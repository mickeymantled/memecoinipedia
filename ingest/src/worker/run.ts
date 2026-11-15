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
  requeueFailed,
  startRun,
  type Database,
  type StageName,
} from '@memecoinipedia/db';
import type { Kysely } from 'kysely';
import { METRICS_VERSION } from '../candles/index.js';
import { UnitBudget } from '../sources/budget.js';
import { CODEX_PROVIDER, CodexClient } from '../sources/codex/index.js';
import { HeliusClient } from '../sources/helius/client.js';
import { JupiterClient, jupiterPauseUsage } from '../sources/jupiter/client.js';
import { MetadataFetcher, type MetadataResult } from '../sources/metadata/fetch.js';
import { RateLimiter } from '../sources/ratelimit.js';
import { HELIUS_PROVIDER } from '../sources/helius/costs.js';
import type { Logger } from './log.js';
import { formatPlan, planIngest, type IngestPlan } from './plan.js';
import { readSampleFile } from './seed.js';
import { STAGE_ORDER, StageRegistry } from './stage.js';
import { CANDLES_STAGE_VERSION, createCandlesStage, type CandlesStage } from './stages/candles.js';
import { discoveredStage } from './stages/discovered.js';
import { metricsStage } from './stages/metrics.js';
import {
  METADATA_STAGE_VERSION,
  createMetadataLoaders,
  createMetadataStage,
  type MetadataStage,
  type HeliusAssets,
  type JupiterPrices,
} from './stages/metadata.js';
import { METADATA_FILE_STAGE_VERSION, createMetadataFileStage } from './stages/metadataFile.js';
import { buildSummary, formatSummary, type RunSummary } from './summary.js';
import { UsageMeter, type UsageTotals } from './usage.js';
import { DEFAULT_MAX_ATTEMPTS, PipelineWorker, type PipelineWorkerOptions } from './worker.js';

/**
 * Requests a second to each metadata gateway. The first live run used 3 and both public
 * gateways answered 429 for about one coin in eight, so the default is 1.
 */
export const DEFAULT_GATEWAY_RPS = 1;

export const RUN_KIND = 'ingest-sample';
export const DEFAULT_STAGES: StageName[] = [...STAGE_ORDER];
/** Stages with an implementation in this worker. */
export const IMPLEMENTED_STAGES: readonly StageName[] = STAGE_ORDER;
/** Jobs at once for the candles stage. The Codex.io client's rate limiter is the real limit. */
export const DEFAULT_CANDLES_CONCURRENCY = 8;
/** Requests a second to Codex.io (the plan allows 300; this is what the candle scripts used). */
export const CODEX_MAX_PER_SECOND = 10;
/** Stage versions, for the plan: a stage done at a lower version counts as work. */
export const STAGE_VERSIONS: Partial<Record<StageName, number>> = {
  metadata: METADATA_STAGE_VERSION,
  metadata_file: METADATA_FILE_STAGE_VERSION,
  candles: CANDLES_STAGE_VERSION,
  metrics: METRICS_VERSION,
};

export interface SourceClients {
  helius: HeliusAssets;
  jupiter: JupiterPrices;
  fetchMetadata(uri: string): Promise<MetadataResult>;
  /** The run's one Codex.io client, with its unit budget. Needed by the candles stage. */
  codex?: CodexClient;
  /** Running totals by provider, read when usage is flushed. */
  readUsage?(): Record<string, UsageTotals>;
}

export interface IngestEnv {
  DATABASE_URL?: string | undefined;
  HELIUS_API_KEY?: string | undefined;
  JUPITER_API_KEY?: string | undefined;
  CODEX_API_KEY?: string | undefined;
}

export interface IngestOptions {
  samplePath: string;
  stages?: StageName[];
  concurrency?: number;
  maxHeliusCredits?: number | null;
  /**
   * Compute-unit ceiling for the run's Codex.io client. Required with `confirm` when the candles
   * stage is selected: there is no default.
   */
  maxCodexUnits?: number | null;
  /** Give stages that were left failed a full set of retries. Default false: a re-run leaves them. */
  retryFailed?: boolean;
  /** Default 3. */
  maxAttempts?: number;
  /** Requests a second to each metadata gateway. Default 1. */
  gatewayRps?: number;
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

/** What the candles stage did to the run, for the last lines of the summary. */
export interface CeilingStop {
  /** Compute units spent by the run's Codex.io client. */
  unitsSpent: number;
  ceiling: number;
  /** Coins that still need candles after the stop. */
  coinsLeft: number;
  reason: string;
}

export interface IngestReport {
  plan: IngestPlan;
  /** False for a dry run and for a run with nothing to do. */
  ranWork: boolean;
  runId: number | null;
  status: 'dry_run' | 'nothing_to_do' | 'done' | 'stopped' | 'failed';
  summary: RunSummary | null;
  /** Set when the Codex.io unit ceiling ended the candles stage before every coin was done. */
  ceilingStop?: CeilingStop;
  /** Set when Jupiter's rate limit stopped the metadata stage: the message. The coins stay pending. */
  jupiterStop?: string;
}

export function createLiveClients(
  env: IngestEnv,
  maxHeliusCredits: number | null,
  gatewayRps = DEFAULT_GATEWAY_RPS,
  codex: { maxUnits: number } | null = null,
  needHelius = true,
): SourceClients {
  // A run of candles and metrics alone calls neither Helius nor Jupiter.
  if (needHelius && !env.HELIUS_API_KEY) throw new Error('HELIUS_API_KEY is not set');
  let codexClient: CodexClient | undefined;
  if (codex) {
    if (!env.CODEX_API_KEY) throw new Error('CODEX_API_KEY is not set');
    codexClient = new CodexClient({
      apiKey: env.CODEX_API_KEY,
      budget: new UnitBudget({ ceilingUnits: codex.maxUnits }),
      limiter: new RateLimiter({ maxPerSecond: CODEX_MAX_PER_SECOND, burst: 1 }),
    });
  }
  const budget = new UnitBudget(
    maxHeliusCredits === null ? {} : { ceilingUnits: maxHeliusCredits },
  );
  const helius = new HeliusClient({
    apiKey: env.HELIUS_API_KEY ?? '',
    budget,
    // Helius's DAS limit on a free key is low; this run makes a handful of requests.
    limiter: new RateLimiter({ maxPerSecond: 1, burst: 1 }),
  });
  const jupiter = new JupiterClient(env.JUPITER_API_KEY ? { apiKey: env.JUPITER_API_KEY } : {});
  const fetcher = new MetadataFetcher({ gatewayMaxPerSecond: gatewayRps });
  return {
    helius,
    jupiter,
    fetchMetadata: (uri) => fetcher.fetch(uri),
    ...(codexClient ? { codex: codexClient } : {}),
    readUsage: () => {
      const h = helius.spend();
      const c = codexClient?.spend();
      return {
        [HELIUS_PROVIDER]: { requests: h.requests, units: h.units },
        jupiter: { requests: jupiter.requestCount(), units: 0 },
        ...jupiterPauseUsage(jupiter),
        ...(c ? { [CODEX_PROVIDER]: { requests: c.requests, units: c.units } } : {}),
      };
    },
  };
}

export function buildRegistry(
  db: Kysely<Database>,
  clients: SourceClients,
  meter: UsageMeter,
  addresses: readonly string[],
  maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
): { registry: StageRegistry; candles: CandlesStage | null; metadata: MetadataStage } {
  const { assets, prices } = createMetadataLoaders({
    db,
    helius: clients.helius,
    jupiter: clients.jupiter,
    addresses,
    maxAttempts,
  });
  const metadata = createMetadataStage({ assets, prices });
  const registry = new StageRegistry().register(discoveredStage).register(metadata);
  registry.register(
    createMetadataFileStage({ fetchMetadata: clients.fetchMetadata, usage: meter }),
  );
  // The candles stage needs the run's Codex.io client; metrics reads stored bars and needs none.
  const candles = clients.codex ? createCandlesStage({ codex: clients.codex }) : null;
  if (candles) registry.register(candles);
  registry.register(metricsStage);
  return { registry, candles, metadata };
}

function validateStages(stages: readonly StageName[]): void {
  for (const s of stages) {
    if (!IMPLEMENTED_STAGES.includes(s)) {
      throw new Error(
        `Stage "${s}" is not available in this build: the stages are ${IMPLEMENTED_STAGES.join(', ')}.`,
      );
    }
  }
}

export async function runIngest(opts: IngestOptions): Promise<IngestReport> {
  const now = opts.now ?? (() => new Date());
  const stages = opts.stages ?? DEFAULT_STAGES;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  validateStages(stages);
  const wantsCandles = stages.includes('candles');
  if (opts.confirm && wantsCandles && !(opts.maxCodexUnits && opts.maxCodexUnits > 0)) {
    throw new Error(
      '--max-codex-units is required with --confirm when the candles stage is selected: ' +
        'it is the compute-unit ceiling for the run, and there is no default.',
    );
  }
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
      maxCodexUnits: opts.maxCodexUnits ?? null,
      maxAttempts,
      retryFailed: opts.retryFailed ?? false,
      versions: STAGE_VERSIONS,
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
    const clients =
      opts.clients ??
      createLiveClients(
        opts.env,
        opts.maxHeliusCredits ?? null,
        opts.gatewayRps,
        wantsCandles ? { maxUnits: opts.maxCodexUnits! } : null,
        stages.includes('metadata'),
      );
    if (wantsCandles && !clients.codex) {
      throw new Error('The candles stage needs a Codex.io client (clients.codex)');
    }
    const syncUsage = () => {
      const usage = { ...clients.readUsage?.() };
      if (clients.codex && !usage[CODEX_PROVIDER]) {
        const c = clients.codex.spend();
        usage[CODEX_PROVIDER] = { requests: c.requests, units: c.units };
      }
      for (const [p, t] of Object.entries(usage)) meter.set(p, t.requests, t.units);
    };

    const runId = await createRun(db, {
      kind: RUN_KIND,
      params: {
        sample: opts.samplePath,
        stages,
        concurrency: opts.concurrency ?? 5,
        maxHeliusCredits: opts.maxHeliusCredits ?? null,
        maxCodexUnits: opts.maxCodexUnits ?? null,
        retryFailed: opts.retryFailed ?? false,
        maxAttempts,
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
    let ceilingStop: CeilingStop | undefined;
    let jupiterStop: string | undefined;
    try {
      if (opts.retryFailed) {
        const n = await requeueFailed(db, stages, { addresses, now: now() });
        opts.log.info(`requeued ${n} failed stages for a full set of retries`);
      }
      if (stages.includes('discovered')) {
        const seeded = await discoverCoins(db, sample.coins, { now: now(), runId });
        opts.log.info('seeded', { ...seeded });
      }
      const { registry, candles, metadata } = buildRegistry(
        db,
        clients,
        meter,
        addresses,
        maxAttempts,
      );
      worker = new PipelineWorker({
        connectionString,
        db,
        registry,
        stages,
        runId,
        log: opts.log,
        concurrency: opts.concurrency ?? 5,
        // Candles run wider by default; the Codex.io client's limiter is what paces them.
        stageConcurrency:
          opts.concurrency === undefined ? { candles: DEFAULT_CANDLES_CONCURRENCY } : {},
        maxAttempts,
        now,
        ...opts.worker,
      });
      await worker.start();
      const queued = await worker.enqueueNotDone(addresses);
      opts.log.info('queued', queued);
      await worker.waitUntilIdle({ addresses, ...(opts.signal ? { signal: opts.signal } : {}) });
      if (opts.signal?.aborted) status = 'stopped';
      if (metadata.stopped) jupiterStop = metadata.stopReason ?? 'Jupiter kept answering HTTP 429.';
      if (candles?.stopped && clients.codex) {
        const left = await worker.coinsToDo('candles', addresses);
        ceilingStop = {
          unitsSpent: clients.codex.spend().units,
          ceiling: opts.maxCodexUnits ?? 0,
          coinsLeft: left.length,
          reason: candles.stopReason ?? 'ceiling reached',
        };
      }
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
    if (ceilingStop) opts.out(formatCeilingStop(ceilingStop));
    if (jupiterStop) {
      opts.out(
        `STOPPED: ${jupiterStop} The coins of the batch are pending again and no attempt was spent. Run again later to continue.`,
      );
    }
    return {
      plan,
      ranWork: true,
      runId,
      status,
      summary,
      ...(ceilingStop ? { ceilingStop } : {}),
      ...(jupiterStop ? { jupiterStop } : {}),
    };
  } finally {
    if (ownsDb && db) await db.destroy();
  }
}

export function formatCeilingStop(c: CeilingStop): string {
  const n = (x: number) => Math.round(x).toLocaleString('en-US');
  return (
    `STOPPED AT THE CODEX.IO UNIT CEILING: ${n(c.unitsSpent)} of ${n(c.ceiling)} units spent, ` +
    `${n(c.coinsLeft)} coins still need candles. Nothing is lost: run again with a higher ` +
    '--max-codex-units to continue where this stopped.'
  );
}
