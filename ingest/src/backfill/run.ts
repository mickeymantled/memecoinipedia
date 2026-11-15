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
  countByRoughPeak,
  countCoinsNotDone,
  createDb,
  createRun,
  finishRun,
  recordUsageSample,
  requeueFailedInSelection,
  reopenStagesForCoins,
  resolveSelection,
  stageBreakdown,
  startRun,
  type Database,
  type ResolvedSelection,
  type SelectionSpec,
  type StageBreakdown,
  type StageName,
} from '@memecoinipedia/db';
import { sql, type Kysely } from 'kysely';
import { METRICS_VERSION } from '../candles/index.js';
import { CODEX_PROVIDER, PAIRS_BASE_UNITS, UNITS_PER_RESULT } from '../sources/codex/index.js';
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
import { UsageMeter } from '../worker/usage.js';
import { CELL_EDGES, estimateBackfillUnits, type BackfillEstimate } from './cells.js';
import {
  BACKFILL_BATCH_SIZE,
  BACKFILL_CANDLES_CONCURRENCY,
  DEFAULT_CODEX_RPS,
  DEFAULT_DB_POOL,
  DEFAULT_METADATA_CONCURRENCY,
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
  /** Default: candles, metrics, metadata. */
  stages?: readonly BackfillStageName[];
  /** Requests a second to Codex.io. Default `DEFAULT_CODEX_RPS`. */
  codexRps?: number;
  /** Coins whose candles are fetched at once. Default `BACKFILL_CANDLES_CONCURRENCY`. */
  candlesConcurrency?: number;
  metricsConcurrency?: number;
  metadataConcurrency?: number;
  /** Connections in the run's pool and in the queue's pool; together at most 40. */
  dbPoolSize?: number;
  queuePoolSize?: number;
  /** Compute-unit ceiling for Codex.io. Required with `confirm` when candles is a stage. */
  maxCodexUnits?: number | null;
  maxHeliusCredits?: number | null;
  /** Requests a second to each metadata gateway. */
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
  /** Coins read from the selection, over all passes. */
  scanned: number;
  seconds: number;
}

const STAGE_VERSIONS: Record<BackfillStageName, number> = {
  candles: CANDLES_STAGE_VERSION,
  metrics: METRICS_VERSION,
  metadata: METADATA_STAGE_VERSION,
};
const STAGE_TIMEOUTS: Record<BackfillStageName, number> = {
  candles: CANDLES_TIMEOUT_SECONDS,
  metrics: DEFAULT_STAGE_TIMEOUT_SECONDS,
  metadata: DEFAULT_STAGE_TIMEOUT_SECONDS,
};
const REQUIRES: Record<BackfillStageName, StageName> = {
  candles: 'discovered',
  metrics: 'candles',
  metadata: 'metrics',
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
      ...(stage === 'metadata' ? { minAthMarketCapUsd: LISTED_ATH_USD } : {}),
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
      ? estimateBackfillUnits(counts)
      : { rows: [], coinsToDo: 0, units: 0 },
    ready,
    freshRunning,
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
    confirm: boolean;
    maxCodexUnits: number | null;
  },
): string {
  const sp = plan.selection.spec;
  const lines: string[] = [];
  lines.push(
    `Backfill plan: ${n(plan.selection.size)} coins selected ` +
      `(rough peak $${n(sp.minRoughPeakUsd)} or more${sp.includeNoPrice ? ', and no price' : ''}, ` +
      `${sp.order} order${sp.limit ? `, limit ${n(sp.limit)}` : ''}).`,
  );
  lines.push('Coins per stage (done / failed / running / waiting):');
  for (const s of plan.stages) {
    const note =
      s.stage === 'metadata'
        ? `; ${n(s.notApplicable)} known not to be listed (ATH under $${n(LISTED_ATH_USD)}) are not waiting.`
        : '';
    lines.push(
      `  ${s.stage.padEnd(9)} ${n(s.done)} / ${n(s.failed)} / ${n(s.running)} / ${n(s.waiting)}${note}`,
    );
  }
  if (o.stages.includes('metadata')) {
    lines.push(
      `  Metadata runs only for coins whose ATH is $${n(LISTED_ATH_USD)} or more, after their metrics; ` +
        'which coins that is, is not known until then.',
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
  const stages = opts.stages ?? BACKFILL_STAGES;
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
      confirm: opts.confirm,
      maxCodexUnits,
    });
    opts.out(planText);
    const base = { plan, ceilingStop: false, scanned: 0 };
    if (!opts.confirm) {
      return { ...base, status: 'dry_run', runId: null, seconds: (Date.now() - started) / 1000 };
    }
    if (plan.nothingToDo) {
      return {
        ...base,
        status: 'nothing_to_do',
        runId: null,
        seconds: (Date.now() - started) / 1000,
      };
    }
    const connectionString = databaseUrl;
    if (!connectionString) throw new Error('DATABASE_URL is not set');

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
    const syncUsage = () => {
      const usage = { ...clients.readUsage?.() };
      if (clients.codex && !usage[CODEX_PROVIDER]) {
        const c = clients.codex.spend();
        usage[CODEX_PROVIDER] = { requests: c.requests, units: c.units };
      }
      for (const [p, t] of Object.entries(usage)) meter.set(p, t.requests, t.units);
    };

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
    const flush = async () => {
      syncUsage();
      await meter.flush(db, runId, now());
    };
    let lastSample = 0;
    const stopFlush = meter.startFlushing(
      db,
      runId,
      now,
      5000,
      (err) => opts.log.warn(`usage flush failed: ${(err as Error).message}`),
      () => {
        syncUsage();
        // History for the status view's "last hour": one sample every 30 seconds.
        if (Date.now() - lastSample >= 30_000) {
          lastSample = Date.now();
          const at = now();
          for (const [p, t] of Object.entries(meter.snapshot())) {
            recordUsageSample(db, runId, { provider: p, ...t }, at).catch((e: Error) =>
              opts.log.warn(`usage sample failed: ${e.message}`),
            );
          }
        }
      },
    );
    let scanned = 0;
    try {
      if (opts.retryFailed) {
        const k = await requeueFailedInSelection(db, plan.selection, stages, now());
        opts.log.info(`requeued ${k} failed stages for a full set of retries`);
      }
      if (refresh) {
        const k = await reopenStagesForCoins(db, refresh.coinIds, ['candles'], now());
        opts.log.info(`refresh: ${k} candles stages put back to pending`);
      }
      const { registry, candles } = buildBackfillRegistry({
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
        signal: opts.signal,
      });
      const aborted = () => opts.signal?.aborted === true;

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
          : 'Backfill run finished.';
    const left = (await stageBreakdown(db, plan.selection, breakdownStages(now())))
      .filter((b) => stages.includes(b.stage as BackfillStageName) && b.waiting > 0)
      .map((b) => `${n(b.waiting)} for ${b.stage}`);
    const leftover = left.length > 0 ? `\nCoins still waiting: ${left.join(', ')}.` : '';
    opts.out(
      `${headline}${leftover}\nRun ${runId}: read ${n(scanned)} coins from the selection in ${formatDuration(seconds / 60)}.\n\n` +
        formatStatus(await collectStatus(db, { now })),
    );
    return { plan, status, runId, ceilingStop: candlesStopped, scanned, seconds };
  } finally {
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
