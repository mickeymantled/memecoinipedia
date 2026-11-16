/**
 * `runLive`: the live process (`live run`).
 *
 * Without `confirm` it is a dry run: it reads the database (read-only), prints the watched coins
 * by age and the requests and units a day it expects, and asks nothing of any provider and writes
 * nothing. With `confirm` it takes the pipeline lock, registers the same stages as a backfill
 * (`buildBackfillRegistry`) on the same `PipelineWorker`, and runs the loops (`LiveLoop`) until
 * told to stop.
 *
 * Stop. `signal` aborting means: finish what is running, then exit. The loop's pass in progress
 * ends, the worker lets the jobs in flight finish, usage is recorded. A restart continues from the
 * cursor in `live_state` and from the stage rows.
 */
import {
  acquirePipelineLock,
  createDb,
  createReadOnlyDb,
  createRun,
  finishRun,
  PipelineLockLostError,
  recordUsageSample,
  setLiveState,
  startRun,
  type Database,
  type PipelineLock,
} from '@memecoinipedia/db';
import type { Kysely } from 'kysely';
import { BACKFILL_BATCH_SIZE, DEFAULT_CODEX_RPS, MAX_CONNECTIONS } from '../backfill/defaults.js';
import {
  BACKFILL_STAGES,
  DEFAULT_GATEWAY_RPS,
  buildBackfillRegistry,
  createBackfillClients,
  type BackfillClients,
} from '../backfill/setup.js';
import { JUPITER_PAUSE_DEFAULT_MS } from '../sources/jupiter/client.js';
import { startUsageReporting, syncUsageFrom } from '../shared/usageReport.js';
import { CANDLES_TIMEOUT_SECONDS } from '../worker/stages/candles.js';
import type { Logger } from '../worker/log.js';
import type { IngestEnv, SourceClients } from '../worker/run.js';
import { UsageMeter } from '../worker/usage.js';
import {
  DEFAULT_MAX_ATTEMPTS,
  PipelineWorker,
  type PipelineWorkerOptions,
} from '../worker/worker.js';
import {
  DEFAULT_MAX_CODEX_UNITS_PER_DAY,
  LIVE_CANDLES_CONCURRENCY,
  LIVE_DB_POOL,
  LIVE_METADATA_CONCURRENCY,
  LIVE_METRICS_CONCURRENCY,
  LIVE_QUEUE_POOL,
  LIVE_RUN_KIND,
  STATE_SETTINGS,
  TICK_SECONDS,
  USAGE_SAMPLE_SECONDS,
} from './constants.js';
import type { LiveDeps } from './deps.js';
import { CodexDayGate } from './gate.js';
import { LiveLoop } from './loop.js';
import { createPoolListQueue } from './topup.js';
import { formatLivePlan, planLive, type LivePlan } from './plan.js';
import { collectLiveStatus, formatLiveStatus } from './status.js';
import { sleepUnlessAborted } from './util.js';

export interface LiveOptions {
  /** Codex.io compute units a UTC day. Default 40,000. Always in force: it cannot be turned off. */
  maxCodexUnitsPerDay?: number;
  codexRps?: number;
  gatewayRps?: number;
  maxAttempts?: number;
  /** For the dry run's model: graduates a day. Default: counted in the database, else assumed. */
  graduatesPerDay?: number;
  confirm: boolean;
  env: IngestEnv;
  log: Logger;
  out: (text: string) => void;
  /** Aborting stops the process gracefully (see above). */
  signal?: AbortSignal;
  now?: () => Date;
  /** Seconds between scheduler ticks. Default `TICK_SECONDS`. */
  tickSeconds?: number;
  /** Test seam: stop after this many ticks, as if signalled. */
  maxTicks?: number;
  /** Test seams. */
  db?: Kysely<Database>;
  clients?: SourceClients;
  worker?: Partial<PipelineWorkerOptions>;
}

export interface LiveReport {
  status: 'dry_run' | 'stopped' | 'failed';
  plan: LivePlan;
  runId: number | null;
  ticks: number;
}

export async function runLive(opts: LiveOptions): Promise<LiveReport> {
  const now = opts.now ?? (() => new Date());
  const ceiling = opts.maxCodexUnitsPerDay ?? DEFAULT_MAX_CODEX_UNITS_PER_DAY;
  if (!(ceiling > 0) || !Number.isFinite(ceiling)) {
    throw new Error(
      '--max-codex-units-per-day must be a positive number: the daily ceiling is always in force.',
    );
  }
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (LIVE_DB_POOL + LIVE_QUEUE_POOL > MAX_CONNECTIONS) {
    throw new Error('The live pools are above the connection cap');
  }
  const databaseUrl = opts.env.DATABASE_URL;
  const ownsDb = opts.db === undefined;
  const db =
    opts.db ??
    (databaseUrl
      ? opts.confirm
        ? createDb(databaseUrl, { max: LIVE_DB_POOL })
        : createReadOnlyDb(databaseUrl)
      : null);
  if (!db) throw new Error('DATABASE_URL is not set');

  let lock: PipelineLock | null = null;
  try {
    const plan = await planLive(db, {
      now: now(),
      maxCodexUnitsPerDay: ceiling,
      ...(opts.graduatesPerDay !== undefined ? { graduatesPerDay: opts.graduatesPerDay } : {}),
    });
    opts.out(formatLivePlan(plan));
    if (!opts.confirm) return { status: 'dry_run', plan, runId: null, ticks: 0 };

    if (!databaseUrl) throw new Error('DATABASE_URL is not set');
    lock = await acquirePipelineLock(databaseUrl, 'live', { now: now() });

    const meter = new UsageMeter();
    const clients: SourceClients & Partial<BackfillClients> =
      opts.clients ??
      createBackfillClients(opts.env, {
        codexRps: opts.codexRps ?? DEFAULT_CODEX_RPS,
        // The ceiling is a day's, enforced by the gate; the client keeps no total of its own.
        maxCodexUnits: null,
        maxHeliusCredits: null,
        gatewayRps: opts.gatewayRps ?? DEFAULT_GATEWAY_RPS,
        onWarning: (m) => opts.log.warn(`Codex.io: ${m}`),
        needCodex: true,
        needHelius: true,
      });
    const codex = clients.codex;
    if (!codex) throw new Error('The live process needs a Codex.io client');

    const runId = await createRun(db, {
      kind: LIVE_RUN_KIND,
      params: {
        maxCodexUnitsPerDay: ceiling,
        maxAttempts,
        tickSeconds: opts.tickSeconds ?? TICK_SECONDS,
      },
      estimate: { codexUnitsPerDay: plan.load.codex.units },
    });
    await startRun(db, runId, now());
    await setLiveState(db, STATE_SETTINGS, { maxCodexUnitsPerDay: ceiling, runId }, now());
    opts.log.info(`live run ${runId} started`, { maxCodexUnitsPerDay: ceiling });

    const gate = new CodexDayGate({
      db,
      ceilingUnits: ceiling,
      now,
      runId,
      localUnits: () => {
        const s = codex.spend();
        return s.units + s.reservedUnits;
      },
      log: opts.log,
    });

    const poolLists = createPoolListQueue(gate);
    const metadataRing = new Set<number>();
    const stopFlush = startUsageReporting({
      db,
      runId,
      meter,
      clients,
      now,
      log: opts.log,
      sampleEveryMs: USAGE_SAMPLE_SECONDS * 1000,
    });
    let status: 'stopped' | 'failed' = 'stopped';
    let worker: PipelineWorker | undefined;
    let ticks = 0;
    try {
      const { registry } = buildBackfillRegistry({
        db,
        clients,
        meter,
        stages: BACKFILL_STAGES,
        maxAttempts,
        metadataCandidateIds: () => [...metadataRing],
        candlesAdmit: () => gate.admit(),
        topUpPools: (id) => poolLists.take(id),
        metadataStopHoldMs: JUPITER_PAUSE_DEFAULT_MS,
      });
      worker = new PipelineWorker({
        connectionString: databaseUrl,
        db,
        registry,
        stages: BACKFILL_STAGES,
        runId,
        log: opts.log,
        concurrency: LIVE_METRICS_CONCURRENCY,
        stageConcurrency: {
          candles: LIVE_CANDLES_CONCURRENCY,
          metrics: LIVE_METRICS_CONCURRENCY,
          metadata: LIVE_METADATA_CONCURRENCY,
          metadata_file: LIVE_METADATA_CONCURRENCY,
        },
        stageBatchSize: BACKFILL_BATCH_SIZE,
        maxAttempts,
        queuePoolSize: LIVE_QUEUE_POOL,
        now,
        onEnqueued: (stage, ids) => {
          if (stage !== 'metadata') return;
          for (const id of ids) metadataRing.add(id);
          while (metadataRing.size > 5000)
            metadataRing.delete(metadataRing.values().next().value as number);
        },
        ...opts.worker,
      });
      // Queued jobs of an earlier process are left: they are this process's work too.
      await worker.start();

      const w = worker;
      const deps: LiveDeps = {
        db,
        codex,
        jupiter: clients.jupiter,
        enqueue: (stage, ids) => w.enqueueCoins(stage, ids),
        gate,
        poolLists,
        now,
        log: opts.log,
      };
      const loop = new LiveLoop(deps);
      let lockLost = false;
      while (!opts.signal?.aborted && (opts.maxTicks === undefined || ticks < opts.maxTicks)) {
        // Every tick, first: a lock that is gone means a second process may already be running,
        // so no new work is taken. The worker is stopped gracefully below and the jobs in flight finish.
        if (!(await lock.isHeld())) {
          lockLost = true;
          break;
        }
        await loop.tick();
        ticks++;
        await sleepUnlessAborted((opts.tickSeconds ?? TICK_SECONDS) * 1000, opts.signal);
      }
      if (lockLost) throw new PipelineLockLostError('live');
    } catch (err) {
      status = 'failed';
      opts.log.error(`live run failed: ${(err as Error).message}`);
      throw err;
    } finally {
      stopFlush();
      if (worker) {
        await worker
          .stop({ graceful: true, timeoutMs: (CANDLES_TIMEOUT_SECONDS + 30) * 1000 })
          .catch((e: Error) => opts.log.warn(`stop: ${e.message}`));
      }
      syncUsageFrom(clients, meter);
      await meter.flush(db, runId, now()).catch(() => undefined);
      const at = now();
      for (const [p, t] of Object.entries(meter.snapshot())) {
        await recordUsageSample(db, runId, { provider: p, ...t }, at).catch(() => undefined);
      }
      await finishRun(db, runId, { status, actual: meter.snapshot(), now: at });
      await clients.close?.().catch(() => undefined);
    }
    opts.out(
      `Live run ${runId} stopped.\n\n${formatLiveStatus(await collectLiveStatus(db, now()))}`,
    );
    return { status, plan, runId, ticks };
  } finally {
    await lock?.release();
    if (ownsDb) await db.destroy();
  }
}
