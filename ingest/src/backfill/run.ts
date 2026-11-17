/**
 * `runBackfill`: the backfill over a selection of the seeded candidate coins.
 *
 * Without `confirm`: reads the database only and prints the selection, the coins per stage and
 * the estimate in compute units (no provider call, no write, no queue schema).
 *
 * With `confirm`: feeds the queue a page at a time (`Feeder`), runs the stages through the queue
 * worker, records the run and its provider usage, and prints the status view at the end.
 *
 * Stop and resume. `signal` aborting means: take no new coin, let the ones in flight finish, print
 * the summary, return status `stopped`. Everything is in the stage rows, so running the same
 * command again carries on, and a coin whose stage is done is never fetched again. A process that
 * dies leaves its stage rows `running`; they are claimable again after the stage's timeout, and
 * the next run waits for that before it calls itself finished.
 */
import {
  acquirePipelineLock,
  countByRoughPeak,
  countCoinsNotDone,
  countLeftOutBySource,
  CURVE_ONLY_DISCOVERY_SOURCE,
  createDb,
  createRun,
  finishRun,
  PIPELINE_LOCK_CHECK_SECONDS,
  PipelineLockLostError,
  recordUsageSample,
  refreshFirstStart,
  requeueFailedInSelection,
  reopenStagesForCoins,
  resolveSelection,
  stageBreakdown,
  startRun,
  type Database,
  type PipelineLock,
  type ResolvedSelection,
  type SelectionSpec,
  type StageBreakdown,
  type StageName,
} from '@memecoinipedia/db';
import { sql, type Kysely } from 'kysely';
import { METRICS_VERSION } from '../candles/index.js';
import { PAIRS_BASE_UNITS, UNITS_PER_RESULT } from '../sources/codex/index.js';
import {
  DEFAULT_MAX_ATTEMPTS,
  PipelineWorker,
  type PipelineWorkerOptions,
} from '../worker/worker.js';
import type { IngestEnv, SourceClients } from '../worker/run.js';
import { DEFAULT_STAGE_TIMEOUT_SECONDS } from '../worker/execute.js';
import type { Logger } from '../worker/log.js';
import { LISTED_ATH_USD } from '../worker/stage.js';
import { CANDLES_STAGE_VERSION, CANDLES_TIMEOUT_SECONDS } from '../worker/stages/candles.js';
import { METADATA_STAGE_VERSION } from '../worker/stages/metadata.js';
import { METADATA_FILE_STAGE_VERSION } from '../worker/stages/metadataFile.js';
import { estimateMetadata } from '../worker/plan.js';
import { startUsageReporting, syncUsageFrom } from '../shared/usageReport.js';
import { UsageMeter } from '../worker/usage.js';
import {
  CELL_EDGES,
  estimateBackfillUnits,
  estimateCurveOnlyUnits,
  type BackfillEstimate,
} from './cells.js';
import {
  BACKFILL_BATCH_SIZE,
  BACKFILL_CANDLES_CONCURRENCY,
  DEFAULT_CODEX_RPS,
  DEFAULT_DB_POOL,
  DEFAULT_METADATA_CONCURRENCY,
  DEFAULT_METADATA_FILE_CONCURRENCY,
  DEFAULT_METRICS_CONCURRENCY,
  DEFAULT_QUEUE_POOL,
  FEED_PAGE,
  MAX_CONNECTIONS,
  OUTSTANDING_PER_SLOT,
} from './defaults.js';
import { Feeder } from './feeder.js';
import { resolveRefreshCoins, type RefreshSelection } from './refresh.js';
import {
  BACKFILL_STAGES,
  buildBackfillRegistry,
  DEFAULT_BACKFILL_STAGES,
  createBackfillClients,
  DEFAULT_GATEWAY_RPS,
  type BackfillClients,
  type BackfillStageName,
} from './setup.js';
import {
  BACKFILL_RUN_KIND,
  breakdownStages,
  collectStatus,
  formatDuration,
  formatStatus,
} from './status.js';

export interface BackfillOptions {
  selection: SelectionSpec;
  /** Default: candles, metrics, metadata. `metadata_file` is run by itself. */
  stages?: readonly BackfillStageName[];
  /** Requests a second to Codex.io. Default `DEFAULT_CODEX_RPS`. */
  codexRps?: number;
  /** Coins whose candles are fetched at once. Default `BACKFILL_CANDLES_CONCURRENCY`. */
  candlesConcurrency?: number;
  metricsConcurrency?: number;
  metadataConcurrency?: number;
  /** Coins whose metadata file is fetched at once. Default `DEFAULT_METADATA_FILE_CONCURRENCY`. */
  fileConcurrency?: number;
  /** Connections in the run's pool and in the queue's pool; together at most 40. */
  dbPoolSize?: number;
  queuePoolSize?: number;
  /** Compute-unit ceiling for Codex.io. Required with `confirm` when candles is a stage. */
  maxCodexUnits?: number | null;
  maxHeliusCredits?: number | null;
  /** Requests a second to each metadata gateway (the `metadata_file` stage only). */
  gatewayRps?: number;
  maxAttempts?: number;
  /** Jobs the feeder keeps waiting or running at most. Default twice the candles concurrency, at least 1,000. */
  maxQueued?: number;
  /** Coins the feeder reads from the selection at a time. Default 500. */
  feedPage?: number;
  /** Give stages that were left failed a full set of retries before starting. */
  retryFailed?: boolean;
  /**
   * Refresh the pool list of these coins (ids) instead of fetching new ones: each coin whose
   * candles are done is put back to pending and its candles stage lists the pools again, stores
   * the ones not held and fetches their bars (`refreshPools` of `fetchCandlesForCoin`); metrics go
   * back to pending for a coin that gained a pool or moved the graduation role. The selection is
   * exactly these coins: given as ids, as a file, or by a rule that picks them from the database
   * (`selectCoinsByRule`; `maxGraduationPoolDelaySeconds` is its distance). Needs the candles stage.
   */
  refreshPools?: RefreshSelection;
  confirm: boolean;
  env: IngestEnv;
  log: Logger;
  out: (text: string) => void;
  /** Aborting stops the run gracefully (see above). */
  signal?: AbortSignal;
  /** Seconds between checks that the pipeline lock is still held. Default `PIPELINE_LOCK_CHECK_SECONDS`. */
  lockCheckSeconds?: number;
  now?: () => Date;
  /** Test seams. */
  db?: Kysely<Database>;
  clients?: SourceClients;
  worker?: Partial<PipelineWorkerOptions>;
}

export interface BackfillPlan {
  selection: ResolvedSelection;
  stages: StageBreakdown[];
  estimate: BackfillEstimate;
  /** Ready-to-run work, by stage: coins with the stage not done whose requirement is met. */
  ready: Partial<Record<StageName, number>>;
  freshRunning: number;
  /** Coins of the curve-only list the selection's rule would take but its source leaves out. */
  leftOutBySource: number;
  nothingToDo: boolean;
  /**
   * Failed stages of the asked-for stages inside the selection that `--retry-failed` puts back to
   * pending, with a full set of attempts. Present only with `--retry-failed`; they count as work.
   */
  retryFailed?: { stages: number };
  /** A pool-list refresh: how many selected coins have candles done (they will be reopened). */
  refresh?: { coins: number; candlesDone: number };
}

export interface BackfillReport {
  plan: BackfillPlan;
  status: 'dry_run' | 'nothing_to_do' | 'done' | 'stopped' | 'failed';
  runId: number | null;
  ceilingStop: boolean;
  /** Why the run stopped on Jupiter's rate limit, or null. */
  jupiterStop: string | null;
  /** Coins read from the selection, over all passes. */
  scanned: number;
  seconds: number;
}

const STAGE_VERSIONS: Record<BackfillStageName, number> = {
  candles: CANDLES_STAGE_VERSION,
  metrics: METRICS_VERSION,
  metadata: METADATA_STAGE_VERSION,
  metadata_file: METADATA_FILE_STAGE_VERSION,
};
const STAGE_TIMEOUTS: Record<BackfillStageName, number> = {
  candles: CANDLES_TIMEOUT_SECONDS,
  metrics: DEFAULT_STAGE_TIMEOUT_SECONDS,
  metadata: DEFAULT_STAGE_TIMEOUT_SECONDS,
  metadata_file: DEFAULT_STAGE_TIMEOUT_SECONDS,
};
const REQUIRES: Record<BackfillStageName, StageName> = {
  candles: 'discovered',
  metrics: 'candles',
  metadata: 'metrics',
  metadata_file: 'metadata',
};

/** Passes over the selection after the first, to retry what a pass left retryable. */
const MAX_EXTRA_PASSES = 3;

async function readyCounts(
  db: Kysely<Database>,
  sel: ResolvedSelection,
  stages: readonly BackfillStageName[],
  maxAttempts: number,
  now: Date,
): Promise<Partial<Record<StageName, number>>> {
  const out: Partial<Record<StageName, number>> = {};
  for (const stage of stages) {
    out[stage] = await countCoinsNotDone(db, stage, {
      version: STAGE_VERSIONS[stage],
      requires: REQUIRES[stage],
      selection: sel,
      maxAttempts,
      runningSince: new Date(now.getTime() - STAGE_TIMEOUTS[stage] * 1000),
      ...(stage === 'metadata' || stage === 'metadata_file'
        ? { minAthMarketCapUsd: LISTED_ATH_USD }
        : {}),
    });
  }
  return out;
}

/** One pool-list request: its base cost, and a typical list of about twenty pools. */
export const REFRESH_UNITS_PER_COIN = PAIRS_BASE_UNITS + UNITS_PER_RESULT * 20;

export async function planBackfill(
  db: Kysely<Database>,
  selectionSpec: SelectionSpec,
  stages: readonly BackfillStageName[],
  maxAttempts: number,
  now: Date,
  refresh = false,
  retryFailed = false,
): Promise<BackfillPlan> {
  const selection = await resolveSelection(db, selectionSpec);
  const leftOutBySource = await countLeftOutBySource(db, selectionSpec);
  if (refresh) {
    const all = await stageBreakdown(db, selection, breakdownStages(now));
    const candlesDone = all.find((b) => b.stage === 'candles')?.done ?? 0;
    return {
      selection,
      stages: all.filter((b) => stages.includes(b.stage as BackfillStageName)),
      estimate: {
        rows: [],
        coinsToDo: selection.size,
        units: Math.round(selection.size * REFRESH_UNITS_PER_COIN),
      },
      ready: {},
      freshRunning: 0,
      leftOutBySource,
      nothingToDo: selection.size === 0,
      refresh: { coins: selection.size, candlesDone },
      ...(retryFailed ? { retryFailed: { stages: failedCount(all, stages) } } : {}),
    };
  }
  const all = await stageBreakdown(db, selection, breakdownStages(now));
  const breakdown = all.filter((b) => stages.includes(b.stage as BackfillStageName));
  const counts = await countByRoughPeak(db, selection, CELL_EDGES, {
    stage: 'candles',
    version: CANDLES_STAGE_VERSION,
  });
  const ready = await readyCounts(db, selection, stages, maxAttempts, now);
  const freshRunning = breakdown.reduce((s, b) => s + b.running, 0);
  const readyTotal = Object.values(ready).reduce((s, x) => s + (x ?? 0), 0);
  const retry = retryFailed ? failedCount(all, stages) : 0;
  return {
    selection,
    stages: breakdown,
    estimate: stages.includes('candles')
      ? selectionSpec.source === CURVE_ONLY_DISCOVERY_SOURCE
        ? estimateCurveOnlyUnits(counts)
        : estimateBackfillUnits(counts)
      : { rows: [], coinsToDo: 0, units: 0 },
    ready,
    freshRunning,
    leftOutBySource,
    nothingToDo: readyTotal === 0 && freshRunning === 0 && retry === 0,
    ...(retryFailed ? { retryFailed: { stages: retry } } : {}),
  };
}

/** Failed stage rows of the asked-for stages in the selection (what `--retry-failed` requeues). */
function failedCount(
  all: readonly { stage: string; failed: number }[],
  stages: readonly BackfillStageName[],
): number {
  return all
    .filter((b) => stages.includes(b.stage as BackfillStageName))
    .reduce((sum, b) => sum + b.failed, 0);
}

const n = (x: number) => Math.round(x).toLocaleString('en-US');

export function formatBackfillPlan(
  plan: BackfillPlan,
  o: {
    stages: readonly BackfillStageName[];
    codexRps: number;
    candlesConcurrency: number;
    gatewayRps?: number;
    /** Coins in flight for `metadata_file`. */
    fileConcurrency?: number;
    confirm: boolean;
    maxCodexUnits: number | null;
  },
): string {
  const sp = plan.selection.spec;
  const lines: string[] = [];
  lines.push(
    `Backfill plan: ${n(plan.selection.size)} coins selected ` +
      `(rough peak $${n(sp.minRoughPeakUsd)} or more${sp.includeNoPrice ? ', and no price' : ''}, ` +
      `${sp.source ? `source ${sp.source}, ` : ''}` +
      `${sp.order} order${sp.limit ? `, limit ${n(sp.limit)}` : ''}).`,
  );
  if (plan.leftOutBySource > 0) {
    lines.push(
      `${n(plan.leftOutBySource)} coins of the curve-only list were left out ` +
        `(never graduated); --source ${CURVE_ONLY_DISCOVERY_SOURCE} selects them.`,
    );
  }
  lines.push('Coins per stage (done / failed / running / waiting):');
  for (const s of plan.stages) {
    const note =
      s.stage === 'metadata' || s.stage === 'metadata_file'
        ? `; ${n(s.notApplicable)} known not to be listed (ATH under $${n(LISTED_ATH_USD)}) are not waiting.`
        : '';
    lines.push(
      `  ${s.stage.padEnd(13)} ${n(s.done)} / ${n(s.failed)} / ${n(s.running)} / ${n(s.waiting)}${note}`,
    );
  }
  if (o.stages.includes('metadata')) {
    lines.push(
      `  Metadata runs only for coins whose ATH is $${n(LISTED_ATH_USD)} or more, after their metrics; ` +
        'which coins that is, is not known until then.',
    );
  }
  if (o.stages.includes('metadata')) {
    const coins = plan.ready.metadata ?? 0;
    const h = estimateMetadata(coins);
    lines.push(
      `Metadata estimate: ${n(coins)} coins ready now (more become ready as metrics finish): ` +
        `Helius ${n(h.helius?.requests ?? 0)} requests, ${n(h.helius?.credits ?? 0)} credits; ` +
        `Jupiter ${n(h.jupiter?.requests ?? 0)} requests, no credits. No gateway request.`,
    );
  }
  if (o.stages.includes('metadata_file')) {
    const coins = plan.ready.metadata_file ?? 0;
    const rps = o.gatewayRps ?? DEFAULT_GATEWAY_RPS;
    const inFlight = o.fileConcurrency ?? DEFAULT_METADATA_FILE_CONCURRENCY;
    lines.push(
      `Metadata file: ${n(coins)} coins ready now, no cost. At ${rps} request a second to each ` +
        `gateway with ${inFlight} coins in flight, one request a coin at the least, that is about ${formatDuration(coins / rps / 60)} ` +
        'of requests, if the gateways keep up.',
    );
  }
  if (o.stages.includes('candles')) {
    if (plan.refresh) {
      lines.push(
        `Pool-list refresh: ${n(plan.refresh.coins)} coins; ${n(plan.refresh.candlesDone)} of them have candles ` +
          'done and will be put back to pending (the others are fetched as usual).',
      );
      lines.push(
        `Codex.io estimate: one pool-list request a coin, about ${n(plan.estimate.units)} compute units ` +
          `(${REFRESH_UNITS_PER_COIN.toFixed(2)} a coin). Bars for pools the list adds cannot be known ` +
          'before the list is read: each adds about 4 units a request, and none is asked for a pool already held.',
      );
    } else if (plan.estimate.curveOnly) {
      const c = plan.estimate.curveOnly;
      lines.push(
        `Codex.io estimate, curve-only list: ${n(plan.estimate.coinsToDo)} coins still to fetch. ` +
          `Every coin costs ${c.screenUnitsPerCoin} units (launch record 4, pool list 4, daily screen on its curve 4): ` +
          `${n(c.floorUnits)} units. A coin whose screen passes costs ${c.restUnitsPerCoin} more ` +
          '(its first 1,500 minutes and one hourly request); the list holds coins whose hourly peak ' +
          'was $100,000 or more, so most pass.',
      );
      lines.push(
        `  Total: about ${n(plan.estimate.units)} compute units if every coin passes ` +
          `(${n(c.screenUnitsPerCoin + c.restUnitsPerCoin)} a coin), ${n(c.floorUnits)} if none does. ` +
          'Peak refinement and other pools are not counted; not measured on this list yet.',
      );
    } else {
      lines.push('Codex.io estimate, by rough-peak cell (coins still to fetch):');
      for (const r of plan.estimate.rows) {
        lines.push(
          `  ${r.label.padEnd(14)} ${n(r.toDo).padStart(9)} coins x ${r.unitsPerCoin} = ${n(r.units).padStart(11)} units` +
            `${r.alreadyDone > 0 ? ` (${n(r.alreadyDone)} already done)` : ''}`,
        );
      }
      lines.push(
        `  Total: ${n(plan.estimate.coinsToDo)} coins, about ${n(plan.estimate.units)} compute units ` +
          '(at the measured figures per coin; 11 under $30k: measured 10.7 on 100 coins (#40), figure kept at 11).',
      );
    }
    const minutes = plan.estimate.coinsToDo > 0 ? plan.estimate.units / 4 / o.codexRps / 60 : 0;
    lines.push(
      `Rate: ${o.codexRps} requests a second to Codex.io, ${o.candlesConcurrency} coins in flight. ` +
        `At 4 units a request that is about ${formatDuration(minutes)} of requests, if the provider keeps up.`,
    );
  }
  if (plan.retryFailed) {
    lines.push(
      `Failed stages to retry (--retry-failed): ${n(plan.retryFailed.stages)}; ` +
        'they are put back to pending with a full set of attempts.',
    );
  }
  if (plan.nothingToDo) lines.push('Nothing to do: every selected coin is done at every stage.');
  if (!o.confirm) {
    lines.push('Dry run: no provider call, no write. Add --confirm to run.');
    if (o.stages.includes('candles') && o.maxCodexUnits === null) {
      lines.push('--confirm also needs --max-codex-units N (no default).');
    }
  }
  return lines.join('\n');
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runBackfill(opts: BackfillOptions): Promise<BackfillReport> {
  const started = Date.now();
  const now = opts.now ?? (() => new Date());
  const stages = opts.stages ?? DEFAULT_BACKFILL_STAGES;
  for (const s of stages) {
    if (!BACKFILL_STAGES.includes(s)) throw new Error(`Unknown stage "${s}"`);
  }
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const codexRps = opts.codexRps ?? DEFAULT_CODEX_RPS;
  const candlesConcurrency = opts.candlesConcurrency ?? BACKFILL_CANDLES_CONCURRENCY;
  const dbPool = opts.dbPoolSize ?? DEFAULT_DB_POOL;
  const queuePool = opts.queuePoolSize ?? DEFAULT_QUEUE_POOL;
  if (dbPool + queuePool > MAX_CONNECTIONS) {
    throw new Error(
      `The pools add up to ${dbPool + queuePool} connections; at most ${MAX_CONNECTIONS} are allowed ` +
        '(the Postgres server is shared with other databases).',
    );
  }
  const wantsCandles = stages.includes('candles');
  const maxCodexUnits = opts.maxCodexUnits ?? null;
  if (opts.confirm && wantsCandles && !(maxCodexUnits && maxCodexUnits > 0)) {
    throw new Error(
      '--max-codex-units is required with --confirm when the candles stage is selected: ' +
        'it is the compute-unit ceiling for the run, and there is no default.',
    );
  }
  if (opts.refreshPools && !wantsCandles)
    throw new Error('--refresh-pools needs the candles stage');
  const databaseUrl = opts.env.DATABASE_URL;
  const ownsDb = opts.db === undefined;
  const db = opts.db ?? (databaseUrl ? createDb(databaseUrl, { max: dbPool }) : null);
  if (!db) throw new Error('DATABASE_URL is not set');

  // One pipeline process per database: a confirmed run holds this lock until it ends.
  let lock: PipelineLock | null = null;
  // Stopping, from the caller's signal or from a lost lock: both end the run gracefully.
  const stopCtl = new AbortController();
  const onCallerAbort = () => stopCtl.abort();
  if (opts.signal?.aborted) stopCtl.abort();
  opts.signal?.addEventListener('abort', onCallerAbort, { once: true });
  let lockLost = false;
  let lockTimer: NodeJS.Timeout | undefined;
  try {
    let refresh: { coinIds: readonly number[] } | undefined;
    if (opts.refreshPools) {
      refresh = { coinIds: await resolveRefreshCoins(db, opts.refreshPools) };
      if (refresh.coinIds.length === 0) throw new Error('--refresh-pools: no coins selected');
    }
    const selectionSpec: SelectionSpec = refresh
      ? { ...opts.selection, includeNoPrice: true, coinIds: refresh.coinIds, limit: null }
      : opts.selection;
    const refreshSet = refresh ? new Set(refresh.coinIds) : null;
    const plan = await planBackfill(
      db,
      selectionSpec,
      stages,
      maxAttempts,
      now(),
      refresh !== undefined,
      opts.retryFailed ?? false,
    );
    const planText = formatBackfillPlan(plan, {
      stages,
      codexRps,
      candlesConcurrency,
      gatewayRps: opts.gatewayRps ?? DEFAULT_GATEWAY_RPS,
      fileConcurrency: opts.fileConcurrency ?? DEFAULT_METADATA_FILE_CONCURRENCY,
      confirm: opts.confirm,
      maxCodexUnits,
    });
    opts.out(planText);
    const base = { plan, ceilingStop: false, jupiterStop: null, scanned: 0 };
    if (!opts.confirm) {
      return { ...base, status: 'dry_run', runId: null, seconds: (Date.now() - started) / 1000 };
    }
    const connectionString = databaseUrl;
    if (!connectionString) throw new Error('DATABASE_URL is not set');
    lock = await acquirePipelineLock(connectionString, 'backfill', { now: now() });
    // A lock whose connection dropped is gone, and a second process may start: stop taking new
    // work (the feeder and the wait loops see the abort), let the jobs in flight finish, then fail.
    const held = lock;
    let checking = false;
    lockTimer = setInterval(
      () => {
        if (checking || lockLost) return;
        checking = true;
        void held
          .isHeld()
          .then((ok) => {
            if (ok) return;
            lockLost = true;
            opts.log.error('the pipeline lock was lost; taking no new work');
            stopCtl.abort();
          })
          .finally(() => {
            checking = false;
          });
      },
      (opts.lockCheckSeconds ?? PIPELINE_LOCK_CHECK_SECONDS) * 1000,
    );
    if (plan.nothingToDo) {
      return {
        ...base,
        status: 'nothing_to_do',
        runId: null,
        seconds: (Date.now() - started) / 1000,
      };
    }
    const meter = new UsageMeter();
    const clients: SourceClients & Partial<BackfillClients> =
      opts.clients ??
      createBackfillClients(opts.env, {
        codexRps,
        maxCodexUnits,
        maxHeliusCredits: opts.maxHeliusCredits ?? null,
        gatewayRps: opts.gatewayRps ?? DEFAULT_GATEWAY_RPS,
        onWarning: (m) => opts.log.warn(`Codex.io: ${m}`),
        needCodex: wantsCandles,
        needHelius: stages.includes('metadata'),
      });
    if (wantsCandles && !clients.codex)
      throw new Error('The candles stage needs a Codex.io client');
    const syncUsage = () => syncUsageFrom(clients, meter);

    const runId = await createRun(db, {
      kind: BACKFILL_RUN_KIND,
      params: {
        selection: selectionSpec,
        ...(refresh ? { refreshPools: true } : {}),
        stages,
        codexRps,
        candlesConcurrency,
        metricsConcurrency: opts.metricsConcurrency ?? DEFAULT_METRICS_CONCURRENCY,
        metadataConcurrency: opts.metadataConcurrency ?? DEFAULT_METADATA_CONCURRENCY,
        dbPool,
        queuePool,
        maxCodexUnits,
        maxHeliusCredits: opts.maxHeliusCredits ?? null,
        maxAttempts,
        retryFailed: opts.retryFailed ?? false,
      },
      estimate: { codexUnits: plan.estimate.units, coins: plan.estimate.coinsToDo },
    });
    await startRun(db, runId, now());
    opts.log.info(`run ${runId} started`, { selected: plan.selection.size, stages: [...stages] });

    // Coins most recently queued for metadata, so the loaders prefetch the coins about to need it.
    const metadataRing = new Set<number>();
    const ringIds = (): number[] => [...metadataRing];

    let status: 'done' | 'stopped' | 'failed' = 'done';
    let worker: PipelineWorker | undefined;
    let candlesStopped = false;
    let jupiterStop: string | null = null;
    const flush = async () => {
      syncUsage();
      await meter.flush(db, runId, now());
    };
    const stopFlush = startUsageReporting({ db, runId, meter, clients, now, log: opts.log });
    let scanned = 0;
    try {
      if (opts.retryFailed) {
        const k = await requeueFailedInSelection(db, plan.selection, stages, now());
        opts.log.info(`requeued ${k} failed stages for a full set of retries`);
      }
      if (refresh) {
        // A refresh stopped and started again carries on: a coin whose candles finished after the
        // refresh first started was refreshed by it, and is not reopened (not listed twice).
        const firstStart = await refreshFirstStart(db, {
          kind: BACKFILL_RUN_KIND,
          coinIds: refresh.coinIds,
          beforeRunId: runId,
        });
        const k = await reopenStagesForCoins(db, refresh.coinIds, ['candles'], now(), {
          finishedBefore: firstStart,
        });
        opts.log.info(
          firstStart
            ? `refresh continued (first started ${firstStart.toISOString()}): ${k} candles stages put back to pending, coins finished since are left`
            : `refresh: ${k} candles stages put back to pending`,
        );
      }
      const { registry, candles, metadata } = buildBackfillRegistry({
        ...(refreshSet ? { refreshPools: (id: number) => refreshSet.has(id) } : {}),
        db,
        clients,
        meter,
        stages,
        maxAttempts,
        metadataCandidateIds: ringIds,
      });
      worker = new PipelineWorker({
        connectionString,
        db,
        registry,
        stages,
        runId,
        log: opts.log,
        concurrency: opts.metricsConcurrency ?? DEFAULT_METRICS_CONCURRENCY,
        stageConcurrency: {
          candles: candlesConcurrency,
          metrics: opts.metricsConcurrency ?? DEFAULT_METRICS_CONCURRENCY,
          metadata: opts.metadataConcurrency ?? DEFAULT_METADATA_CONCURRENCY,
          metadata_file: opts.fileConcurrency ?? DEFAULT_METADATA_FILE_CONCURRENCY,
        },
        stageBatchSize: BACKFILL_BATCH_SIZE,
        maxAttempts,
        queuePoolSize: queuePool,
        now,
        onEnqueued: (stage, ids) => {
          if (stage !== 'metadata') return;
          for (const id of ids) metadataRing.add(id);
          // Keep the ring bounded: the oldest ids go first.
          while (metadataRing.size > 5000)
            metadataRing.delete(metadataRing.values().next().value as number);
        },
        ...opts.worker,
      });
      await worker.start();
      await worker.clearQueued();

      const feeder = new Feeder({
        db,
        worker,
        selection: plan.selection,
        maxOutstanding:
          opts.maxQueued ?? Math.max(FEED_PAGE * 2, candlesConcurrency * OUTSTANDING_PER_SLOT),
        gateStage: BACKFILL_STAGES.find((x) => stages.includes(x)),
        pageSize: opts.feedPage ?? FEED_PAGE,
        log: opts.log,
        signal: stopCtl.signal,
      });
      const aborted = () => stopCtl.signal.aborted;

      /** Waits until nothing is queued or running here. */
      const waitIdle = async () => {
        let quiet = 0;
        while (!aborted()) {
          const busy = await worker!.hasOutstandingJobs();
          if (!busy && worker!.runningHere === 0) {
            if (++quiet >= 2) return;
          } else quiet = 0;
          await sleep(250);
        }
      };

      for (let pass = 0; !aborted(); pass++) {
        const fed = await feeder.pass();
        scanned = feeder.scannedTotal;
        const queuedTotal = Object.values(fed.queued).reduce((s, x) => s + (x ?? 0), 0);
        opts.log.info(
          `pass ${pass + 1}: read ${n(fed.scanned)} coins, queued ${n(queuedTotal)} jobs`,
          {
            ...fed.queued,
          },
        );
        if (aborted()) break;
        await waitIdle();
        if (aborted()) break;
        if (candles?.stopped) {
          candlesStopped = true;
          break;
        }
        if (metadata?.stopped) {
          jupiterStop = metadata.stopReason;
          break;
        }
        // What is left? A coin whose stage failed and can be retried, or whose stage is `running`
        // for a process that is gone (it becomes claimable when the stage's timeout passes).
        const t = now();
        const ready = await readyCounts(db, plan.selection, stages, maxAttempts, t);
        const readyTotal = Object.values(ready).reduce((s, x) => s + (x ?? 0), 0);
        const running = (await stageBreakdown(db, plan.selection, breakdownStages(t)))
          .filter((b) => stages.includes(b.stage as BackfillStageName))
          .reduce((s, b) => s + b.running, 0);
        if (readyTotal === 0 && running === 0) break;
        if (readyTotal === 0) {
          opts.log.info(
            `${n(running)} stages are marked running by a process that is gone; waiting for their timeout`,
          );
          while (!aborted() && running > 0) {
            await sleep(1000);
            const again = (await stageBreakdown(db, plan.selection, breakdownStages(now())))
              .filter((b) => stages.includes(b.stage as BackfillStageName))
              .reduce((s, b) => s + b.running, 0);
            if (again === 0) break;
            const r2 = await readyCounts(db, plan.selection, stages, maxAttempts, now());
            if (Object.values(r2).some((x) => (x ?? 0) > 0)) break;
          }
        } else if (queuedTotal === 0 || pass >= MAX_EXTRA_PASSES) {
          opts.log.warn(`${n(readyTotal)} stages are still retryable; run again to continue`);
          break;
        }
      }
      if (lockLost) throw new PipelineLockLostError('backfill');
      if (aborted()) status = 'stopped';
    } catch (err) {
      status = 'failed';
      opts.log.error(`run failed: ${(err as Error).message}`);
      throw err;
    } finally {
      stopFlush();
      if (worker) {
        // Gracefully: running jobs finish. The stage timeout bounds how long that can take.
        const longest = Math.max(...stages.map((s) => STAGE_TIMEOUTS[s]));
        await worker
          .stop({ graceful: true, timeoutMs: (longest + 30) * 1000 })
          .catch((e: Error) => opts.log.warn(`stop: ${e.message}`));
      }
      await flush().catch(() => undefined);
      const at = now();
      for (const [p, t] of Object.entries(meter.snapshot())) {
        await recordUsageSample(db, runId, { provider: p, ...t }, at).catch(() => undefined);
      }
      await finishRun(db, runId, { status, actual: meter.snapshot(), now: at });
      await clients.close?.().catch(() => undefined);
    }

    const seconds = (Date.now() - started) / 1000;
    const headline =
      status === 'stopped'
        ? 'Stopped on request: nothing in flight was left running. Run the same command again to continue.'
        : candlesStopped
          ? 'Stopped at the Codex.io unit ceiling. Run again with a higher --max-codex-units to continue.'
          : jupiterStop !== null
            ? `Stopped: ${jupiterStop} The coins of the batch are left to be retried by the next run: the status report shows them as failed with the reason jupiter_rate_limited, and no attempt was spent. Run the same command again later to continue.`
            : 'Backfill run finished.';
    const left = (await stageBreakdown(db, plan.selection, breakdownStages(now())))
      .filter((b) => stages.includes(b.stage as BackfillStageName) && b.waiting > 0)
      .map((b) => `${n(b.waiting)} for ${b.stage}`);
    const leftover = left.length > 0 ? `\nCoins still waiting: ${left.join(', ')}.` : '';
    opts.out(
      `${headline}${leftover}\nRun ${runId}: read ${n(scanned)} coins from the selection in ${formatDuration(seconds / 60)}.\n\n` +
        formatStatus(await collectStatus(db, { now })),
    );
    return { plan, status, runId, ceilingStop: candlesStopped, jupiterStop, scanned, seconds };
  } finally {
    clearInterval(lockTimer);
    opts.signal?.removeEventListener('abort', onCallerAbort);
    await lock?.release();
    if (ownsDb) await db.destroy();
  }
}

/** Number of `running` stage rows (for tests that check nothing was left running). */
export async function countRunningStages(db: Kysely<Database>): Promise<number> {
  const r = await sql<{
    n: string;
  }>`select count(*)::text as n from coin_stages where status = 'running'`.execute(db);
  return Number(r.rows[0]!.n);
}
