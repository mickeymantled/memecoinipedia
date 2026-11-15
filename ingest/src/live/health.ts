/**
 * `live health` (task E6, issue #97): one line per check, `ok`, `warn` or `alert`, from the
 * database alone. The facts are read in one read-only transaction (`collectHealthFacts`); every
 * decision is made by `evaluateHealth`, a pure function of the facts and the limits, so the limits
 * are tested with plain objects. No provider client is built and no key is read. The pipeline lock
 * is looked at (a read of `pg_locks`), never taken, so this runs beside the live process.
 *
 * What each check reads, and where the live process writes it:
 *   process      pg_locks (the lock itself), `live_state.pipeline_lock` (who took it), the newest
 *                `provider_usage_samples` row of the latest `live` run (written every 15 s: the heartbeat)
 *   discovery    `live_state.last_discovery` (written at the end of every pass, even a paused or failed one)
 *   watch loop   `live_state.last_watch`, written at the end of every watch pass (even one with nothing
 *                due): when the last pass ended, and when the last one ended without a failed price request.
 *                Two lines: `watch` (is the loop running) and `watch:prices` (is Jupiter answering).
 *   queue        `coin_stages` rows: `running` past the stage timeout, and `pending` rows of watched coins
 *                while no coin has finished the stage
 *   failures     `coin_stages` failed in the last 24 hours, by stage and the reason up to its first colon
 *   providers    the usage tally (`provider_usage_samples`) for Codex.io; `jupiter_pause` for Jupiter
 *   refresh      `live_state.refresh_state`
 */
import {
  getLiveState,
  isPipelineLockHeld,
  isWatched,
  PIPELINE_LOCK_STATE_KEY,
  usageTotalSince,
  type Database,
  type PipelineLockHolder,
} from '@memecoinipedia/db';
import { sql, type Kysely } from 'kysely';
import { CODEX_PROVIDER } from '../sources/codex/index.js';
import { DEFAULT_STAGE_TIMEOUT_SECONDS } from '../worker/execute.js';
import { CANDLES_TIMEOUT_SECONDS } from '../worker/stages/candles.js';
import {
  DEFAULT_MAX_CODEX_UNITS_PER_DAY,
  DISCOVERY_INTERVAL_SECONDS,
  LIVE_RUN_KIND,
  STATE_LAST_DISCOVERY,
  STATE_LAST_WATCH,
  STATE_REFRESH,
  STATE_SETTINGS,
  USAGE_SAMPLE_SECONDS,
  WATCH_MID_EVERY_SECONDS,
  WATCH_PASS_SECONDS,
  WATCH_MID_UNDER_SECONDS,
  WATCH_OLDER_EVERY_SECONDS,
  dayKey,
} from './constants.js';
import type { RefreshState } from './refresh.js';
import type { WatchRecord } from './watchRecord.js';
import { startOfUtcDay, watchSpec } from './util.js';

// ----------------------------------------------------------------------------- limits

/**
 * The provider name under which Jupiter pauses are counted in the usage tally. It comes with
 * issue #93; until that is merged no such row exists and the check is left out. A plain string
 * here, so this module does not depend on that branch.
 */
export const JUPITER_PAUSE_PROVIDER = 'jupiter_pause';

/** Stages the live process runs, with the timeout after which a `running` row is taken over. */
export const HEALTH_STAGES = [
  { stage: 'candles', timeoutSeconds: CANDLES_TIMEOUT_SECONDS },
  { stage: 'metrics', timeoutSeconds: DEFAULT_STAGE_TIMEOUT_SECONDS },
  { stage: 'metadata', timeoutSeconds: DEFAULT_STAGE_TIMEOUT_SECONDS },
  { stage: 'metadata_file', timeoutSeconds: DEFAULT_STAGE_TIMEOUT_SECONDS },
] as const;

const MINUTE = 60;

/** Multiples of the intervals the process runs at. Each limit below is one of these times its interval. */
export const HEARTBEAT_WARN_SAMPLES = 8;
export const HEARTBEAT_ALERT_SAMPLES = 24;
export const DISCOVERY_WARN_INTERVALS = 3;
export const DISCOVERY_ALERT_INTERVALS = 6;
export const WATCH_PASS_WARN_PASSES = 10;
export const WATCH_PASS_ALERT_PASSES = 20;
export const WATCH_WARN_INTERVALS = 3;
export const WATCH_ALERT_INTERVALS = 6;

/** Every limit, in one place. Each can be overridden with `--limit name=value`. */
export interface HealthLimits {
  /** Heartbeat age. Samples come every 15 s: 8 missed is 2 minutes (a slow tick), 24 is 6 (something is wrong). */
  heartbeatWarnSeconds: number;
  heartbeatAlertSeconds: number;
  /** Age of the last discovery pass. A pass is every 5 minutes: three missed, then six. */
  discoveryWarnSeconds: number;
  discoveryAlertSeconds: number;
  /** Age of the end of the watch loop's last pass. A pass is every 30 seconds; 10 missed, then 20. */
  watchPassWarnSeconds: number;
  watchPassAlertSeconds: number;
  /** Age of the last pass without a failed price request, in intervals of the fastest tier watched (10 minutes, or an hour). */
  watchWarnIntervals: number;
  watchAlertIntervals: number;
  /** A `running` stage past its timeout times this: 1 means the worker should already have taken it over, 2 that it did not. */
  stalledWarnMultiple: number;
  stalledAlertMultiple: number;
  /** Work waiting for a stage while nothing finished it: half an hour, then an hour (a candles job takes up to 10 minutes). */
  waitingWarnSeconds: number;
  waitingAlertSeconds: number;
  /** Failures in 24 hours for one stage and reason: both the count and the share of the stage's finished rows must be met. */
  failureWarnCount: number;
  failureWarnShare: number;
  failureAlertCount: number;
  failureAlertShare: number;
  /** Codex.io units against the day's ceiling, and against the month's allowance when one is given. */
  codexWarnShare: number;
  codexAlertShare: number;
  /** Jupiter pauses today: a few are normal without a key (rate limit), one an hour all day is not. */
  jupiterPauseWarn: number;
  jupiterPauseAlert: number;
  /** The daily refresh starts at the first tick of the UTC day; alert if it has not by this hour (UTC). */
  refreshStartByHourUtc: number;
}

export const DEFAULT_HEALTH_LIMITS: HealthLimits = {
  heartbeatWarnSeconds: HEARTBEAT_WARN_SAMPLES * USAGE_SAMPLE_SECONDS,
  heartbeatAlertSeconds: HEARTBEAT_ALERT_SAMPLES * USAGE_SAMPLE_SECONDS,
  discoveryWarnSeconds: DISCOVERY_WARN_INTERVALS * DISCOVERY_INTERVAL_SECONDS,
  discoveryAlertSeconds: DISCOVERY_ALERT_INTERVALS * DISCOVERY_INTERVAL_SECONDS,
  watchPassWarnSeconds: WATCH_PASS_WARN_PASSES * WATCH_PASS_SECONDS,
  watchPassAlertSeconds: WATCH_PASS_ALERT_PASSES * WATCH_PASS_SECONDS,
  watchWarnIntervals: WATCH_WARN_INTERVALS,
  watchAlertIntervals: WATCH_ALERT_INTERVALS,
  stalledWarnMultiple: 1,
  stalledAlertMultiple: 2,
  waitingWarnSeconds: 30 * MINUTE,
  waitingAlertSeconds: 60 * MINUTE,
  failureWarnCount: 5,
  failureWarnShare: 0.1,
  failureAlertCount: 20,
  failureAlertShare: 0.25,
  codexWarnShare: 0.8,
  codexAlertShare: 0.95,
  jupiterPauseWarn: 5,
  jupiterPauseAlert: 24,
  refreshStartByHourUtc: 1,
};

export type HealthLimitName = keyof HealthLimits;
export const HEALTH_LIMIT_NAMES = Object.keys(DEFAULT_HEALTH_LIMITS) as HealthLimitName[];

/** `--limit name=value` pairs onto the defaults; throws a message for an unknown name or a bad number. */
export function applyLimitOverrides(pairs: readonly string[]): HealthLimits {
  const limits: HealthLimits = { ...DEFAULT_HEALTH_LIMITS };
  for (const p of pairs) {
    const at = p.indexOf('=');
    const name = at < 0 ? p : p.slice(0, at);
    const raw = at < 0 ? '' : p.slice(at + 1);
    if (!(HEALTH_LIMIT_NAMES as string[]).includes(name))
      throw new Error(`--limit: unknown limit "${name}". Known: ${HEALTH_LIMIT_NAMES.join(', ')}`);
    const v = Number(raw);
    if (raw === '' || !Number.isFinite(v) || v <= 0)
      throw new Error(`--limit ${name}=... must be a positive number`);
    limits[name as HealthLimitName] = v;
  }
  return limits;
}

// ----------------------------------------------------------------------------- facts

export interface StageFacts {
  stage: string;
  timeoutSeconds: number;
  running: number;
  oldestRunningStartedAt: Date | null;
  /** `pending` rows of watched coins. */
  waitingWatched: number;
  oldestWaitingAt: Date | null;
  /** The newest `finished_at` of a `done` row of this stage (any coin). */
  lastFinishedAt: Date | null;
}

export interface FailureFacts {
  stage: string;
  reason: string;
  count: number;
}

export interface HealthFacts {
  now: Date;
  lock: { held: boolean; hint: PipelineLockHolder | null };
  /** The latest `live` run, whatever its status; null when the live process never ran here. */
  liveRun: { id: number; status: string; startedAt: Date | null } | null;
  /** The newest usage sample of that run. */
  heartbeatAt: Date | null;
  settings: { maxCodexUnitsPerDay?: number } | null;
  lastDiscovery: { at: Date; status: string; error?: string } | null;
  watch: {
    watched: number;
    young: number;
    /** The loop's own record (`live_state` key `last_watch`); null before its first write. */
    lastPass: { endedAt: Date; okAt: Date | null } | null;
  };
  stages: StageFacts[];
  failures: FailureFacts[];
  /** Rows that finished (`done` or `failed`) in the last 24 hours, by stage. */
  finished24h: Record<string, number>;
  usage: {
    codexDayUnits: number;
    codexMonthUnits: number;
    /** Pauses counted today; null when the provider has no rows at all. */
    jupiterPausesToday: number | null;
  };
  refresh: Pick<RefreshState, 'day' | 'done'> | null;
}

const FAILURE_WINDOW_SECONDS = 24 * 3600;

/** Reads the facts. Pass a read-only transaction (`runHealth` does). Writes nothing. */
export async function collectHealthFacts(db: Kysely<Database>, now: Date): Promise<HealthFacts> {
  const held = await isPipelineLockHeld(db);
  const hint = await getLiveState<PipelineLockHolder>(db, PIPELINE_LOCK_STATE_KEY);
  const run = await db
    .selectFrom('ingest_runs')
    .select(['id', 'status', 'started_at'])
    .where('kind', '=', LIVE_RUN_KIND)
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  const hb = run
    ? await db
        .selectFrom('provider_usage_samples')
        .select((eb) => eb.fn.max('sampled_at').as('at'))
        .where('run_id', '=', run.id)
        .executeTakeFirst()
    : undefined;
  const settings = await getLiveState<{ maxCodexUnitsPerDay?: number }>(db, STATE_SETTINGS);
  const last = await getLiveState<{ at: string; status: string; error?: string }>(
    db,
    STATE_LAST_DISCOVERY,
  );
  const refresh = await getLiveState<RefreshState>(db, STATE_REFRESH);

  const spec = watchSpec(now);
  const youngSince = new Date(now.getTime() - WATCH_MID_UNDER_SECONDS * 1000);
  const w = await db
    .selectFrom('coins')
    .select([
      sql<string>`count(*)`.as('watched'),
      sql<string>`count(*) filter (where coins.graduated_at > ${youngSince})`.as('young'),
    ])
    .where((eb) => isWatched(eb, spec))
    .executeTakeFirstOrThrow();
  const lastWatch = await getLiveState<Partial<WatchRecord>>(db, STATE_LAST_WATCH);

  const stages: StageFacts[] = [];
  for (const { stage, timeoutSeconds } of HEALTH_STAGES) {
    const running = await db
      .selectFrom('coin_stages')
      .select([sql<string>`count(*)`.as('n'), sql<Date | null>`min(started_at)`.as('oldest')])
      .where('stage', '=', stage)
      .where('status', '=', 'running')
      .executeTakeFirstOrThrow();
    const waiting = await db
      .selectFrom('coin_stages as s')
      .innerJoin('coins', 'coins.id', 's.coin_id')
      .select([sql<string>`count(*)`.as('n'), sql<Date | null>`min(s.updated_at)`.as('oldest')])
      .where('s.stage', '=', stage)
      .where('s.status', '=', 'pending')
      .where((eb) => isWatched(eb, spec))
      .executeTakeFirstOrThrow();
    const fin = await db
      .selectFrom('coin_stages')
      .select(sql<Date | null>`max(finished_at)`.as('at'))
      .where('stage', '=', stage)
      .where('status', '=', 'done')
      .executeTakeFirstOrThrow();
    stages.push({
      stage,
      timeoutSeconds,
      running: Number(running.n),
      oldestRunningStartedAt: running.oldest,
      waitingWatched: Number(waiting.n),
      oldestWaitingAt: waiting.oldest,
      lastFinishedAt: fin.at,
    });
  }

  const since = new Date(now.getTime() - FAILURE_WINDOW_SECONDS * 1000);
  const reason = sql<string>`coalesce(nullif(split_part(last_error, ':', 1), ''), '(no reason recorded)')`;
  const failed = await db
    .selectFrom('coin_stages')
    .select(['stage', reason.as('reason'), sql<string>`count(*)`.as('n')])
    .where('status', '=', 'failed')
    .where('finished_at', '>', since)
    .where('finished_at', '<=', now)
    .groupBy(['stage', reason])
    .execute();
  const fin24 = await db
    .selectFrom('coin_stages')
    .select(['stage', sql<string>`count(*)`.as('n')])
    .where('status', 'in', ['done', 'failed'])
    .where('finished_at', '>', since)
    .where('finished_at', '<=', now)
    .groupBy('stage')
    .execute();

  const dayStart = startOfUtcDay(now);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const codexDay = await usageTotalSince(db, CODEX_PROVIDER, dayStart, now);
  const codexMonth = await usageTotalSince(db, CODEX_PROVIDER, monthStart, now);
  const pauseRow = await db
    .selectFrom('provider_usage')
    .select('run_id')
    .where('provider', '=', JUPITER_PAUSE_PROVIDER)
    .limit(1)
    .executeTakeFirst();
  const pauses = pauseRow
    ? (await usageTotalSince(db, JUPITER_PAUSE_PROVIDER, dayStart, now)).requests
    : null;

  return {
    now,
    lock: { held, hint: hint ?? null },
    liveRun: run ? { id: run.id, status: run.status, startedAt: run.started_at } : null,
    heartbeatAt: hb?.at ?? null,
    settings,
    lastDiscovery: last
      ? {
          at: new Date(last.at),
          status: last.status,
          ...(last.error ? { error: last.error } : {}),
        }
      : null,
    watch: {
      watched: Number(w.watched),
      young: Number(w.young),
      lastPass:
        lastWatch && typeof lastWatch.endedAt === 'string'
          ? {
              endedAt: new Date(lastWatch.endedAt),
              okAt: typeof lastWatch.okAt === 'string' ? new Date(lastWatch.okAt) : null,
            }
          : null,
    },
    stages,
    failures: failed.map((r) => ({ stage: r.stage, reason: r.reason, count: Number(r.n) })),
    finished24h: Object.fromEntries(fin24.map((r) => [r.stage, Number(r.n)])),
    usage: {
      codexDayUnits: codexDay.units,
      codexMonthUnits: codexMonth.units,
      jupiterPausesToday: pauses,
    },
    refresh: refresh ? { day: refresh.day, done: refresh.done } : null,
  };
}

// ----------------------------------------------------------------------------- the checks

export type HealthLevel = 'ok' | 'warn' | 'alert';

export interface HealthCheck {
  name: string;
  level: HealthLevel;
  /** What was measured, in words. */
  figure: string;
  /** The limit it was held against (the alert limit, or `warn/alert`). */
  limit: string;
}

export interface HealthReport {
  checkedAt: string;
  status: HealthLevel;
  checks: HealthCheck[];
}

export interface HealthEvalOptions {
  /** A monthly Codex.io unit allowance; the month check is left out without it. */
  monthlyCodexUnits?: number;
  /** Overrides the ceiling the process stored (and the default). */
  maxCodexUnitsPerDay?: number;
}

const n = (x: number) => Math.round(x).toLocaleString('en-US');
const pct = (x: number) => `${Math.round(x * 100)}%`;

function duration(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)} s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  if (seconds < 172_800) return `${(seconds / 3600).toFixed(1)} hours`;
  return `${(seconds / 86_400).toFixed(1)} days`;
}

/** `ok` below `warn`, `warn` from `warn` up to `alert`, `alert` from `alert` up. */
function byAge(value: number, warn: number, alert: number): HealthLevel {
  return value >= alert ? 'alert' : value >= warn ? 'warn' : 'ok';
}

function secondsSince(now: Date, at: Date): number {
  return Math.max(0, (now.getTime() - at.getTime()) / 1000);
}

/** The pure core: the facts and the limits in, the checks out. Reads nothing, writes nothing. */
export function evaluateHealth(
  f: HealthFacts,
  limits: HealthLimits = DEFAULT_HEALTH_LIMITS,
  opts: HealthEvalOptions = {},
): HealthCheck[] {
  if (!f.liveRun) {
    return [
      {
        name: 'process',
        level: 'warn',
        figure: 'the live process has never run in this database; nothing else is checked',
        limit: '-',
      },
    ];
  }
  const checks: HealthCheck[] = [];
  const now = f.now;
  const run = f.liveRun;
  const ceiling =
    opts.maxCodexUnitsPerDay ?? f.settings?.maxCodexUnitsPerDay ?? DEFAULT_MAX_CODEX_UNITS_PER_DAY;
  const runAge = run.startedAt ? secondsSince(now, run.startedAt) : null;

  // 1. Process
  if (!f.lock.held) {
    checks.push({
      name: 'process',
      level: 'alert',
      figure: `no process holds the pipeline lock (latest live run ${run.id} is ${run.status})`,
      limit: 'a live process holds the lock',
    });
  } else if (f.lock.hint && f.lock.hint.kind !== 'live') {
    checks.push({
      name: 'process',
      level: 'warn',
      figure: `the pipeline lock is held by a ${f.lock.hint.kind} process, not the live process`,
      limit: 'a live process holds the lock',
    });
  } else {
    // A heartbeat that does not exist yet is judged from the run's start.
    const age = f.heartbeatAt ? secondsSince(now, f.heartbeatAt) : runAge;
    const limit = `${duration(limits.heartbeatWarnSeconds)}/${duration(limits.heartbeatAlertSeconds)}`;
    if (age === null) {
      checks.push({
        name: 'process',
        level: 'warn',
        figure: 'holds the lock; no heartbeat and no start time recorded',
        limit,
      });
    } else {
      checks.push({
        name: 'process',
        level: byAge(age, limits.heartbeatWarnSeconds, limits.heartbeatAlertSeconds),
        figure: `holds the lock, last heartbeat ${duration(age)} ago (run ${run.id})`,
        limit,
      });
    }
  }

  // 2. Discovery
  {
    const limit = `${duration(limits.discoveryWarnSeconds)}/${duration(limits.discoveryAlertSeconds)}`;
    const age = f.lastDiscovery ? secondsSince(now, f.lastDiscovery.at) : runAge;
    if (age === null) {
      checks.push({
        name: 'discovery',
        level: 'warn',
        figure: 'no discovery pass recorded',
        limit,
      });
    } else {
      let level = byAge(age, limits.discoveryWarnSeconds, limits.discoveryAlertSeconds);
      let figure = f.lastDiscovery
        ? `last pass ${duration(age)} ago, ${f.lastDiscovery.status}`
        : `no pass recorded, run started ${duration(age)} ago`;
      // A failed pass is retried every interval: worth a look, not yet an outage.
      if (f.lastDiscovery?.status === 'error' && level === 'ok') level = 'warn';
      // A paused pass is the daily ceiling working as designed; the providers check says so.
      if (f.lastDiscovery?.status === 'paused' && level === 'alert') {
        level = 'warn';
        figure += ' (paused at the daily unit ceiling)';
      }
      checks.push({ name: 'discovery', level, figure, limit });
    }
  }

  // 3. Watch loop: two readings of the loop's own record (`last_watch`).
  {
    const passLimit = `${duration(limits.watchPassWarnSeconds)}/${duration(limits.watchPassAlertSeconds)}`;
    const last = f.watch.lastPass;
    if (!last) {
      // Before the loop's first write, as for a database where the live process never ran.
      checks.push({
        name: 'watch',
        level: 'warn',
        figure: 'no watch pass recorded yet (the process writes one at the end of each pass)',
        limit: passLimit,
      });
    } else {
      // A record from before this run started is the previous process's: count from the run start.
      const startedAt = run.startedAt;
      const stale = startedAt !== null && last.endedAt < startedAt;
      const age = stale ? runAge : secondsSince(now, last.endedAt);
      if (age !== null) {
        checks.push({
          name: 'watch',
          level: byAge(age, limits.watchPassWarnSeconds, limits.watchPassAlertSeconds),
          figure: stale
            ? `no watch pass in this run yet, run started ${duration(age)} ago`
            : `last pass ended ${duration(age)} ago`,
          limit: passLimit,
        });
      }
      if (f.watch.watched > 0) {
        // The last pass without a failed price request is at most one interval of the fastest tier
        // present old: every 10 minutes when a coin under 3 days old is watched, else hourly.
        const interval = f.watch.young > 0 ? WATCH_MID_EVERY_SECONDS : WATCH_OLDER_EVERY_SECONDS;
        const warn = limits.watchWarnIntervals * interval;
        const alert = limits.watchAlertIntervals * interval;
        const okStale = last.okAt === null || (startedAt !== null && last.okAt < startedAt);
        const okAge = okStale ? runAge : last.okAt ? secondsSince(now, last.okAt) : null;
        const limit = `${duration(warn)}/${duration(alert)}`;
        if (okAge === null) {
          checks.push({
            name: 'watch:prices',
            level: 'warn',
            figure: 'no pass without a failed price request recorded yet',
            limit,
          });
        } else {
          checks.push({
            name: 'watch:prices',
            level: byAge(okAge, warn, alert),
            figure: okStale
              ? `every pass of this run had a failed price request, run started ${duration(okAge)} ago (${n(f.watch.watched)} coins watched)`
              : `last pass without a failed price request ended ${duration(okAge)} ago (${n(f.watch.watched)} coins watched)`,
            limit,
          });
        }
      }
    }
  }

  // 4. Stalled queue
  for (const s of f.stages) {
    const warn = s.timeoutSeconds * limits.stalledWarnMultiple;
    const alert = s.timeoutSeconds * limits.stalledAlertMultiple;
    const limit = `${duration(warn)}/${duration(alert)}`;
    const age = s.oldestRunningStartedAt ? secondsSince(now, s.oldestRunningStartedAt) : 0;
    const runLevel = s.running > 0 ? byAge(age, warn, alert) : 'ok';
    checks.push({
      name: `queue:${s.stage}:running`,
      level: runLevel,
      figure:
        s.running > 0
          ? `${n(s.running)} running, the oldest for ${duration(age)} (timeout ${duration(s.timeoutSeconds)})`
          : 'none running',
      limit,
    });
    const wLimit = `${duration(limits.waitingWarnSeconds)}/${duration(limits.waitingAlertSeconds)}`;
    if (s.waitingWatched === 0) {
      checks.push({
        name: `queue:${s.stage}:waiting`,
        level: 'ok',
        figure: 'no watched coin waiting',
        limit: wLimit,
      });
    } else {
      // Waiting is only a problem while nothing finishes: both clocks must be past the limit.
      const waited = s.oldestWaitingAt ? secondsSince(now, s.oldestWaitingAt) : 0;
      const idle = s.lastFinishedAt ? secondsSince(now, s.lastFinishedAt) : Infinity;
      const stuck = Math.min(waited, idle);
      checks.push({
        name: `queue:${s.stage}:waiting`,
        level: byAge(stuck, limits.waitingWarnSeconds, limits.waitingAlertSeconds),
        figure:
          `${n(s.waitingWatched)} watched coins waiting, the oldest for ${duration(waited)}; ` +
          (s.lastFinishedAt ? `last finished ${duration(idle)} ago` : 'none finished yet'),
        limit: wLimit,
      });
    }
  }

  // 5. Failures
  {
    const groups = f.failures
      .map((g) => {
        const total = f.finished24h[g.stage] ?? 0;
        const share = total > 0 ? g.count / total : 1;
        const level: HealthLevel =
          g.count >= limits.failureAlertCount && share >= limits.failureAlertShare
            ? 'alert'
            : g.count >= limits.failureWarnCount && share >= limits.failureWarnShare
              ? 'warn'
              : 'ok';
        return { g, total, share, level };
      })
      .filter((x) => x.level !== 'ok')
      .sort((a, b) => b.g.count - a.g.count);
    const limit =
      `${limits.failureWarnCount}+ and ${pct(limits.failureWarnShare)} / ` +
      `${limits.failureAlertCount}+ and ${pct(limits.failureAlertShare)} of the stage's finished rows`;
    if (groups.length === 0) {
      const total = f.failures.reduce((a, g) => a + g.count, 0);
      checks.push({
        name: 'failures',
        level: 'ok',
        figure: `${n(total)} stages failed in the last 24 hours, none over the limits`,
        limit,
      });
    } else {
      for (const { g, total, share, level } of groups) {
        checks.push({
          name: `failures:${g.stage}:${g.reason}`,
          level,
          figure: `${n(g.count)} failed in 24 hours, ${pct(share)} of ${n(total)} finished`,
          limit,
        });
      }
    }
  }

  // 6. Providers
  {
    const used = f.usage.codexDayUnits;
    const share = used / ceiling;
    checks.push({
      name: 'provider:codex:day',
      level:
        share >= limits.codexAlertShare ? 'alert' : share >= limits.codexWarnShare ? 'warn' : 'ok',
      figure: `${n(used)} of ${n(ceiling)} units today (${pct(share)})`,
      limit: `${pct(limits.codexWarnShare)}/${pct(limits.codexAlertShare)} of the daily ceiling`,
    });
    if (opts.monthlyCodexUnits !== undefined) {
      const mShare = f.usage.codexMonthUnits / opts.monthlyCodexUnits;
      checks.push({
        name: 'provider:codex:month',
        level:
          mShare >= limits.codexAlertShare
            ? 'alert'
            : mShare >= limits.codexWarnShare
              ? 'warn'
              : 'ok',
        figure: `${n(f.usage.codexMonthUnits)} of ${n(opts.monthlyCodexUnits)} units this month (${pct(mShare)})`,
        limit: `${pct(limits.codexWarnShare)}/${pct(limits.codexAlertShare)} of the monthly allowance`,
      });
    }
    if (f.usage.jupiterPausesToday !== null) {
      const p = f.usage.jupiterPausesToday;
      checks.push({
        name: 'provider:jupiter:pauses',
        level:
          p >= limits.jupiterPauseAlert ? 'alert' : p >= limits.jupiterPauseWarn ? 'warn' : 'ok',
        figure: `${n(p)} pauses today`,
        limit: `${limits.jupiterPauseWarn}/${limits.jupiterPauseAlert}`,
      });
    }
  }

  // 7. Daily refresh
  {
    const today = dayKey(now);
    const yesterday = dayKey(new Date(startOfUtcDay(now).getTime() - 86_400_000));
    const started = f.refresh?.day === today;
    // Only one day is kept: once today's has started, yesterday's outcome is no longer stored.
    if (f.refresh?.day === yesterday && !f.refresh.done) {
      checks.push({
        name: 'refresh:yesterday',
        level: 'alert',
        figure: "yesterday's refresh did not finish",
        limit: 'finished',
      });
    } else {
      checks.push({
        name: 'refresh:yesterday',
        level: 'ok',
        figure: f.refresh
          ? started
            ? "today's has started (yesterday's outcome is not kept)"
            : f.refresh.day === yesterday
              ? 'finished'
              : `last refresh was ${f.refresh.day}`
          : 'no refresh recorded yet',
        limit: 'finished',
      });
    }
    const hour = now.getUTCHours() + now.getUTCMinutes() / 60;
    checks.push({
      name: 'refresh:today',
      level: !started && hour >= limits.refreshStartByHourUtc ? 'alert' : 'ok',
      figure: started ? `started (${f.refresh?.done ? 'done' : 'in progress'})` : 'not started',
      limit: `started by ${String(limits.refreshStartByHourUtc).padStart(2, '0')}:00 UTC`,
    });
  }
  return checks;
}

export function summarize(checks: readonly HealthCheck[], now: Date): HealthReport {
  const status: HealthLevel = checks.some((c) => c.level === 'alert')
    ? 'alert'
    : checks.some((c) => c.level === 'warn')
      ? 'warn'
      : 'ok';
  return { checkedAt: now.toISOString(), status, checks: [...checks] };
}

export function formatHealth(r: HealthReport): string {
  return r.checks
    .map((c) => `${c.level.padEnd(5)} ${c.name}: ${c.figure} (limit ${c.limit})`)
    .join('\n');
}

/** Exit code: 1 when any check alerts; `warn` never changes it. */
export const healthExitCode = (r: HealthReport): number => (r.status === 'alert' ? 1 : 0);

/**
 * Reads the facts in one read-only transaction and evaluates them. The transaction is read-only
 * whatever the connection was opened as, so a write would be refused by the database.
 */
export async function runHealth(
  db: Kysely<Database>,
  now: Date,
  limits: HealthLimits = DEFAULT_HEALTH_LIMITS,
  opts: HealthEvalOptions = {},
): Promise<HealthReport> {
  const facts = await db
    .transaction()
    .setAccessMode('read only')
    .execute((trx) => collectHealthFacts(trx, now));
  return summarize(evaluateHealth(facts, limits, opts), now);
}
