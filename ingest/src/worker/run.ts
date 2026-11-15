/**
 * `runIngest`: the whole sample ingest, behind `scripts/ingest-sample.ts`.
 *
 * Without `confirm` it reads the file and the database, prints the plan and
 * the cost estimate, and stops: no network call, no write, no queue schema.
 * With `confirm` it seeds, runs the stages through the queue worker, records
 * the run and its provider usage, and prints a summary read from the database.
 * A run with nothing left to do says so and writes nothing.
 */
import {
  createDb,
  createRun,
  discoverCoins,
  finishRun,
  startRun,
  type Database,
  type StageName,
} from '@memecoinipedia/db';
import type { Kysely } from 'kysely';
import { UnitBudget } from '../sources/budget.js';
import { HeliusClient } from '../sources/helius/client.js';
import { JupiterClient } from '../sources/jupiter/client.js';
import { MetadataFetcher, type MetadataResult } from '../sources/metadata/fetch.js';
import { RateLimiter } from '../sources/ratelimit.js';
import { HELIUS_PROVIDER } from '../sources/helius/costs.js';
import type { Logger } from './log.js';
import { formatPlan, planIngest, type IngestPlan } from './plan.js';
import { readSampleFile } from './seed.js';
import { StageRegistry } from './stage.js';
import { discoveredStage } from './stages/discovered.js';
import {
  createMetadataLoaders,
  createMetadataStage,
  type HeliusAssets,
  type JupiterPrices,
} from './stages/metadata.js';
import { buildSummary, formatSummary, type RunSummary } from './summary.js';
import { UsageMeter, type UsageTotals } from './usage.js';
import { PipelineWorker, type PipelineWorkerOptions } from './worker.js';

export const RUN_KIND = 'ingest-sample';
export const DEFAULT_STAGES: StageName[] = ['discovered', 'metadata'];
/** Stages with an implementation in this worker. `candles` and `metrics` are registered by part 3. */
export const IMPLEMENTED_STAGES: readonly StageName[] = ['discovered', 'metadata'];

export interface SourceClients {
  helius: HeliusAssets;
  jupiter: JupiterPrices;
  fetchMetadata(uri: string): Promise<MetadataResult>;
  /** Running totals by provider, read when usage is flushed. */
  readUsage?(): Record<string, UsageTotals>;
}

export interface IngestEnv {
  DATABASE_URL?: string | undefined;
  HELIUS_API_KEY?: string | undefined;
  JUPITER_API_KEY?: string | undefined;
}

export interface IngestOptions {
  samplePath: string;
  stages?: StageName[];
  concurrency?: number;
  maxHeliusCredits?: number | null;
  confirm: boolean;
  env: IngestEnv;
  log: Logger;
  /** Where plan and summary text goes. */
  out: (text: string) => void;
  /** Aborting stops the run gracefully and marks it `stopped`. */
  signal?: AbortSignal;
  now?: () => Date;
  /** Test seams. */
  db?: Kysely<Database>;
  clients?: SourceClients;
  worker?: Partial<PipelineWorkerOptions>;
}

export interface IngestReport {
  plan: IngestPlan;
  /** False for a dry run and for a run with nothing to do. */
  ranWork: boolean;
  runId: number | null;
  status: 'dry_run' | 'nothing_to_do' | 'done' | 'stopped' | 'failed';
  summary: RunSummary | null;
}

export function createLiveClients(env: IngestEnv, maxHeliusCredits: number | null): SourceClients {
  if (!env.HELIUS_API_KEY) throw new Error('HELIUS_API_KEY is not set');
  const budget = new UnitBudget(
    maxHeliusCredits === null ? {} : { ceilingUnits: maxHeliusCredits },
  );
  const helius = new HeliusClient({
    apiKey: env.HELIUS_API_KEY,
    budget,
    // Helius's DAS limit on a free key is low; this run makes a handful of requests.
    limiter: new RateLimiter({ maxPerSecond: 1, burst: 1 }),
  });
  const jupiter = new JupiterClient(env.JUPITER_API_KEY ? { apiKey: env.JUPITER_API_KEY } : {});
  const fetcher = new MetadataFetcher({ gatewayMaxPerSecond: 3 });
  return {
    helius,
    jupiter,
    fetchMetadata: (uri) => fetcher.fetch(uri),
    readUsage: () => {
      const h = helius.spend();
      return {
        [HELIUS_PROVIDER]: { requests: h.requests, units: h.units },
        jupiter: { requests: jupiter.requestCount(), units: 0 },
      };
    },
  };
}

export function buildRegistry(
  db: Kysely<Database>,
  clients: SourceClients,
  meter: UsageMeter,
  addresses: readonly string[],
): StageRegistry {
  const { assets, prices } = createMetadataLoaders({
    db,
    helius: clients.helius,
    jupiter: clients.jupiter,
    addresses,
  });
  return new StageRegistry().register(discoveredStage).register(
    createMetadataStage({
      assets,
      prices,
      fetchMetadata: clients.fetchMetadata,
      usage: meter,
    }),
  );
}

function validateStages(stages: readonly StageName[]): void {
  for (const s of stages) {
    if (!IMPLEMENTED_STAGES.includes(s)) {
      throw new Error(
        `Stage "${s}" is not available in this build: only ${IMPLEMENTED_STAGES.join(' and ')} ` +
          'are registered. candles and metrics are registered by part 3.',
      );
    }
  }
}

export async function runIngest(opts: IngestOptions): Promise<IngestReport> {
  const now = opts.now ?? (() => new Date());
  const stages = opts.stages ?? DEFAULT_STAGES;
  validateStages(stages);
  const sample = await readSampleFile(opts.samplePath);
  for (const p of sample.problems.slice(0, 10)) {
    opts.log.warn(`sample row ${p.line} rejected: ${p.problem}`);
  }
  if (sample.coins.length === 0) throw new Error('The sample file holds no valid coins');
  const addresses = sample.coins.map((c) => c.address);

  const ownsDb = opts.db === undefined && !!opts.env.DATABASE_URL;
  const db = opts.db ?? (opts.env.DATABASE_URL ? createDb(opts.env.DATABASE_URL) : null);
  try {
    const plan = await planIngest({
      file: opts.samplePath,
      sample,
      stages,
      db,
      databaseUrl: opts.env.DATABASE_URL,
      maxHeliusCredits: opts.maxHeliusCredits ?? null,
    });
    opts.out(formatPlan(plan, opts.confirm));
    if (!opts.confirm)
      return { plan, ranWork: false, runId: null, status: 'dry_run', summary: null };
    if (plan.nothingToDo) {
      return { plan, ranWork: false, runId: null, status: 'nothing_to_do', summary: null };
    }
    if (!db || !opts.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
    const connectionString = opts.env.DATABASE_URL;

    const meter = new UsageMeter();
    const clients = opts.clients ?? createLiveClients(opts.env, opts.maxHeliusCredits ?? null);
    const syncUsage = () => {
      for (const [p, t] of Object.entries(clients.readUsage?.() ?? {}))
        meter.set(p, t.requests, t.units);
    };

    const runId = await createRun(db, {
      kind: RUN_KIND,
      params: {
        sample: opts.samplePath,
        stages,
        concurrency: opts.concurrency ?? 5,
        maxHeliusCredits: opts.maxHeliusCredits ?? null,
      },
      estimate: plan.estimate,
    });
    await startRun(db, runId, now());
    opts.log.info(`run ${runId} started`, { stages });

    let status: 'done' | 'stopped' | 'failed' = 'done';
    const stopFlush = meter.startFlushing(
      db,
      runId,
      now,
      5000,
      (err) => opts.log.warn(`usage flush failed: ${(err as Error).message}`),
      syncUsage,
    );
    let worker: PipelineWorker | undefined;
    try {
      if (stages.includes('discovered')) {
        const seeded = await discoverCoins(db, sample.coins, { now: now(), runId });
        opts.log.info('seeded', { ...seeded });
      }
      const registry = buildRegistry(db, clients, meter, addresses);
      worker = new PipelineWorker({
        connectionString,
        db,
        registry,
        stages,
        runId,
        log: opts.log,
        concurrency: opts.concurrency ?? 5,
        now,
        ...opts.worker,
      });
      await worker.start();
      const queued = await worker.enqueueNotDone(addresses);
      opts.log.info('queued', queued);
      await worker.waitUntilIdle({ addresses, ...(opts.signal ? { signal: opts.signal } : {}) });
      if (opts.signal?.aborted) status = 'stopped';
    } catch (err) {
      status = 'failed';
      opts.log.error(`run failed: ${(err as Error).message}`);
      throw err;
    } finally {
      stopFlush();
      if (worker) await worker.stop().catch((e: Error) => opts.log.warn(`stop: ${e.message}`));
      syncUsage();
      await meter.flush(db, runId, now());
      await finishRun(db, runId, { status, actual: meter.snapshot(), now: now() });
    }

    const summary = await buildSummary(db, addresses, stages, plan.estimate, meter.snapshot());
    opts.out(formatSummary(summary, stages));
    return { plan, ranWork: true, runId, status, summary };
  } finally {
    if (ownsDb && db) await db.destroy();
  }
}
