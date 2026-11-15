/**
 * The candle fetch plan: a pure function from what is known to the next
 * requests to make. No network, no database, no clock.
 *
 * The default plan is staged (docs/metrics.md section 12). It spends one request
 * on most coins and about ten on the rest:
 *
 * 1. Screen. Daily bars of the primary pool (the graduation pool, or the bonding
 *    curve when the coin has no graduation pool) for its whole life. W is the
 *    highest daily high as a market cap. Under `screenBelowUsd` the coin cannot
 *    have an ATH of $100,000, so nothing else is fetched. Unless the Dune peak
 *    (`roughAthUsd`) is more than `escalationRatio` times W: then the coin takes
 *    the full path, and W is recomputed over all fetched pools.
 * 2. Light path (W under `fullPathFromUsd`): one request of 1,500 1-minute bars
 *    from five minutes before the pool began trading, then hourly bars for the
 *    days whose daily high is at least `hourlyFromUsd` and that 1-minute bars do
 *    not cover, packed greedily into 1,500-hour windows. Primary pool only.
 * 3. Full path (W at or above `fullPathFromUsd`, or escalated): the light path
 *    plus daily bars, and hourly bars on liquid days, for the other pools.
 * 4. The bonding curve: its last 1,500 minutes, only when the graduation pool's
 *    first daily bar opens at `curveFromUsd` or more.
 * 5. Peak refinement (`planPeakRefinement`): when the metrics carry
 *    `peak_outside_minute_coverage`, one request of 1,500 minutes around the
 *    highest hourly or daily point, repeated, capped per coin.
 *
 * `EXHAUSTIVE_PLAN_LIMITS` is the earlier plan, kept to measure what the staged
 * one loses: 1-minute bars for 48 hours after graduation and for the curve's last
 * day, hourly bars for every stretch with trading, every liquid pool.
 *
 * Each request costs about 4 compute units. A request already recorded in
 * `coverage` is never planned again; a range reaching a later `asOf` than
 * before plans only the new part.
 *
 * Work comes in phases because each needs bars from the one before: `initial`
 * (screen, other pools' daily bars, minute windows) and `followup` (hourly bars).
 * `needsPoolList` says the plan cannot go on until the caller has looked up the
 * pool list and stored the pools.
 */
import { planBarRequests, type BarResolution } from '../sources/codex/index.js';

export const DAY = 86_400;
export const HOUR = 3_600;
export const MINUTE = 60;

export type ResolutionSec = 60 | 3600 | 86400;
export type PoolRole = 'curve' | 'graduation' | 'other';

/** Exhaustive plan: hourly runs are joined across gaps up to this long, one request's worth. */
const HOURLY_GAP_MERGE_SEC = 1_500 * HOUR;
/** Buckets one request returns at most. */
const WINDOW_BUCKETS = 1_500;

/** Compute units one bars request costs (docs/data-sources.md section 7). */
export const UNITS_PER_BARS_REQUEST = 4;

export interface Interval {
  /** Unix seconds, inclusive. */
  from: number;
  /** Unix seconds, exclusive. */
  to: number;
}

export interface PlanPool {
  address: string;
  role: PoolRole;
  /** Pool creation time as the provider reports it. Only trusted for the graduation pool. */
  createdAt: number | null;
}

/** What the stored daily bars of a pool say. Empty when none are stored. */
export interface PoolDaily {
  /** `t` of the first and last stored daily bar. */
  first: number | null;
  last: number | null;
  /** `t` of every stored daily bar (a day with trades), ascending. */
  days: number[];
  /** Highest of open, high, low and close of each daily bar as a market cap in USD, aligned with `days`. */
  highs: number[];
  /** The largest of `highs`, or null with no bars. */
  maxHigh: number | null;
  /** The first daily bar's open as a market cap in USD, or null. */
  firstOpen: number | null;
  /** `t` of every daily bar whose liquidity is at least the secondary-pool minimum, ascending. */
  qualifyingDays: number[];
}

export interface PlanLimits {
  /** True: the staged plan. False: the exhaustive plan (`EXHAUSTIVE_PLAN_LIMITS`). */
  staged: boolean;
  /** Staged: W under this, USD market cap, and the coin is screened out. Default 90,000. */
  screenBelowUsd: number;
  /** Staged: W at or above this and the coin takes the full path. Default 1,000,000. */
  fullPathFromUsd: number;
  /** Refinement skips periods whose high is under this, USD market cap. Default 90,000. Both plans. */
  refineFromUsd: number;
  /** Staged: hourly bars for days whose daily high is at least this. Default 80,000. */
  hourlyFromUsd: number;
  /** Staged: the curve is fetched when the graduation pool opens at this or more. Default 90,000. */
  curveFromUsd: number;
  /** Staged: a Dune peak above this many times W sends the coin to the full path. Default 1.5. */
  escalationRatio: number;
  /** Exhaustive: how far before graduation the curve's 1-minute bars start. Default 24 hours. */
  curveTailSec: number;
  /** Exhaustive: how long after graduation the pool's 1-minute bars run. Default 48 hours. */
  postGraduationMinuteSec: number;
  /** Most hourly windows for one coin on the light path (and in the exhaustive plan). Default 8. */
  maxHourlyRequests: number;
  /** Most hourly windows for one coin on the full path. Default 24. */
  maxHourlyRequestsFull: number;
  /** Most peak-refinement requests for one coin. Default 12. */
  maxRefinementRequests: number;
  /** Liquidity a secondary pool needs, USD. Default 5,000 (docs/metrics.md section 2). */
  minSecondaryPoolLiquidityUsd: number;
  /**
   * How far from the migration a pool's creation may be and still be the graduation pool, seconds.
   * Default 3,600 (docs/data-sources.md, "How the graduation pool is chosen").
   */
  maxGraduationPoolDelaySeconds: number;
}

export const DEFAULT_PLAN_LIMITS: PlanLimits = {
  staged: true,
  screenBelowUsd: 90_000,
  refineFromUsd: 90_000,
  fullPathFromUsd: 1_000_000,
  hourlyFromUsd: 80_000,
  curveFromUsd: 90_000,
  escalationRatio: 1.5,
  curveTailSec: DAY,
  postGraduationMinuteSec: 2 * DAY,
  maxHourlyRequests: 8,
  maxHourlyRequestsFull: 24,
  maxRefinementRequests: 12,
  minSecondaryPoolLiquidityUsd: 5_000,
  maxGraduationPoolDelaySeconds: 3_600,
};

/**
 * The plan before the staged one: no screen, 1-minute bars for 48 hours after
 * graduation and for the curve's last day, hourly bars for every stretch with
 * trading, every liquid pool, refinement one bucket at a time. Pass it as
 * `limits` to measure what the staged plan loses.
 */
export const EXHAUSTIVE_PLAN_LIMITS: Partial<PlanLimits> = { staged: false };

export interface PlanState {
  /** End of the observation period, unix seconds. Nothing after it is planned. */
  asOf: number;
  /** Coin creation time, unix seconds. */
  launchedAt: number | null;
  /** Migration (graduation) time, unix seconds. */
  graduatedAt: number | null;
  pools: readonly PlanPool[];
  /** Requested ranges already recorded, by pool address and resolution. */
  coverage: Readonly<Record<string, Partial<Record<ResolutionSec, readonly Interval[]>>>>;
  /** Summary of the stored daily bars, by pool address. */
  daily: Readonly<Record<string, PoolDaily>>;
  /** `coins.rough_ath_market_cap_usd`, Dune's hourly peak over every pool. Null when unknown. */
  roughAthUsd?: number | null;
  /** The pool list has been looked up and its pools stored. Staged plan only. */
  poolsListed?: boolean;
  limits?: Partial<PlanLimits>;
}

export type RequestReason =
  | 'primary_minute'
  | 'curve_tail'
  | 'post_graduation_minute'
  | 'daily_life'
  | 'hourly_life'
  | 'secondary_hourly'
  | 'peak_refinement';

export interface PlannedRequest {
  poolAddress: string;
  resolution: ResolutionSec;
  /** First bucket start sent to the provider, aligned to the resolution. */
  from: number;
  /** One past the last second sent. `(to - from) / resolution` is at most 1,500. */
  to: number;
  /** What this request settles, recorded as coverage once it is made. Inside `[from, to)`. */
  cover: Interval;
  buckets: number;
  reason: RequestReason;
  estimatedUnits: number;
}

/** Where a coin stands in the staged plan. */
export interface StageInfo {
  /** `screen`: daily bars of the primary pool are still due. */
  path: 'screen' | 'light' | 'full';
  /** W, the highest daily high as a market cap in USD; null before the screen bars exist. */
  w: number | null;
  /** The Dune peak was more than `escalationRatio` times W. */
  escalated: boolean;
  /** The coin cannot be listed and nothing more is fetched. */
  screenedOut: boolean;
}

export interface BasePlan {
  /** `complete` when nothing more is needed before peak refinement. */
  phase: 'initial' | 'followup' | 'complete';
  requests: PlannedRequest[];
  estimatedUnits: number;
  hourly: {
    /** Windows beyond the hourly cap that still have uncovered time. */
    deferredWindows: number;
    capHit: boolean;
  };
  /** Staged plan: the pool list must be looked up and stored before the plan can go on. */
  needsPoolList: boolean;
  stage: StageInfo;
}

export interface PeakTarget {
  poolAddress: string;
  /** Start of the hourly or daily bucket whose point sits above the ATH. */
  t: number;
  /** Resolution of that bucket, 3600 or 86400. */
  resolution: 3600 | 86400;
  /** The bar's high as a market cap in USD. */
  highUsd?: number;
}

export interface RefinementPlan {
  /** The next request, or null. */
  request: PlannedRequest | null;
  /** The cap is used up and a target still has no 1-minute coverage. */
  capHit: boolean;
  /** Not capped, but every target already has its 1-minute bars requested. */
  exhausted: boolean;
}

const RES_CODE: Record<ResolutionSec, BarResolution> = { 60: '1', 3600: '60', 86400: '1D' };

export function resolutionCode(res: ResolutionSec): BarResolution {
  return RES_CODE[res];
}

export const floorTo = (t: number, step: number): number => Math.floor(t / step) * step;
export const ceilTo = (t: number, step: number): number => Math.ceil(t / step) * step;

function limitsOf(state: Pick<PlanState, 'limits'>): PlanLimits {
  const out: PlanLimits = { ...DEFAULT_PLAN_LIMITS };
  for (const [k, v] of Object.entries(state.limits ?? {})) {
    if (v !== undefined) (out as unknown as Record<string, number | boolean>)[k] = v;
  }
  return out;
}

/** Sorted, merged copy of the intervals. Ones that touch, or lie `gap` seconds apart or less, join. */
export function mergeIntervals(intervals: readonly Interval[], gap = 0): Interval[] {
  const sorted = intervals
    .filter((i) => i.to > i.from)
    .map((i) => ({ ...i }))
    .sort((a, b) => a.from - b.from || a.to - b.to);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.from <= last.to + gap) last.to = Math.max(last.to, i.to);
    else out.push(i);
  }
  return out;
}

/** The parts of `need` not inside `covered`, ascending. */
export function subtractIntervals(need: Interval, covered: readonly Interval[]): Interval[] {
  if (need.to <= need.from) return [];
  const out: Interval[] = [];
  let cursor = need.from;
  for (const c of mergeIntervals(covered)) {
    if (c.to <= cursor) continue;
    if (c.from >= need.to) break;
    if (c.from > cursor) out.push({ from: cursor, to: c.from });
    cursor = Math.max(cursor, c.to);
    if (cursor >= need.to) break;
  }
  if (cursor < need.to) out.push({ from: cursor, to: need.to });
  return out;
}

/** True when `[from, to)` is wholly inside the covered ranges. */
export function isCovered(range: Interval, covered: readonly Interval[]): boolean {
  return subtractIntervals(range, covered).length === 0;
}

/** A stored bar as `summarizeDaily` reads it; prices are optional so liquidity-only tests stay short. */
export interface DailyBarInput {
  t: number;
  liquidityUsd: number | null;
  o?: number;
  h?: number;
  l?: number;
  c?: number;
}

/**
 * The summary `PlanState.daily` wants, from stored daily bars (any order).
 * A day qualifies when its liquidity is known and at least `minLiquidityUsd`.
 * Market caps are price times `supply` (default 1 billion).
 */
export function summarizeDaily(
  bars: readonly DailyBarInput[],
  minLiquidityUsd: number,
  supply = 1_000_000_000,
): PoolDaily {
  const sorted = [...bars].sort((a, b) => a.t - b.t);
  const highs = sorted.map(
    (b) =>
      Math.max(0, ...[b.o, b.h, b.l, b.c].filter((v): v is number => v !== undefined)) * supply,
  );
  const firstOpen = sorted[0]?.o;
  return {
    first: sorted[0]?.t ?? null,
    last: sorted[sorted.length - 1]?.t ?? null,
    days: sorted.map((b) => b.t),
    highs,
    maxHigh: highs.length > 0 ? Math.max(...highs) : null,
    firstOpen: firstOpen === undefined ? null : firstOpen * supply,
    qualifyingDays: sorted
      .filter((b) => b.liquidityUsd !== null && b.liquidityUsd >= minLiquidityUsd)
      .map((b) => b.t),
  };
}

/**
 * When the graduation pool began trading. The pool's own creation time unless it
 * is more than a day away from the migration time (the provider's pool dates
 * are sometimes wrong), then the migration time. With no graduation pool, the
 * migration time. Null when neither is known.
 */
export function graduationStart(state: Pick<PlanState, 'pools' | 'graduatedAt'>): number | null {
  const grad = state.pools.find((p) => p.role === 'graduation');
  if (!grad) return state.graduatedAt;
  const created = grad.createdAt;
  const migrated = state.graduatedAt;
  if (created !== null && migrated !== null) {
    return Math.abs(created - migrated) > DAY ? migrated : created;
  }
  return created ?? migrated;
}

function coverageOf(state: PlanState, address: string, res: ResolutionSec): readonly Interval[] {
  return state.coverage[address]?.[res] ?? [];
}

/**
 * The requests that fill `need` for one pool and resolution, minus what is
 * covered: one request per window of at most 1,500 buckets.
 */
function requestsFor(
  state: PlanState,
  address: string,
  res: ResolutionSec,
  need: Interval,
  reason: RequestReason,
): PlannedRequest[] {
  const clipped: Interval = { from: need.from, to: Math.min(need.to, state.asOf) };
  const out: PlannedRequest[] = [];
  for (const piece of subtractIntervals(clipped, coverageOf(state, address, res))) {
    out.push(...windowRequests(address, res, piece, reason));
  }
  return out;
}

function windowRequests(
  address: string,
  res: ResolutionSec,
  piece: Interval,
  reason: RequestReason,
): PlannedRequest[] {
  return planBarRequests({ from: piece.from, to: piece.to, resolution: RES_CODE[res] }).map(
    (w) => ({
      poolAddress: address,
      resolution: res,
      from: w.from,
      to: w.to + 1,
      cover: { from: Math.max(w.from, piece.from), to: Math.min(w.to + 1, piece.to) },
      buckets: w.buckets,
      reason,
      estimatedUnits: UNITS_PER_BARS_REQUEST,
    }),
  );
}

const sumUnits = (requests: readonly PlannedRequest[]): number =>
  requests.reduce((s, r) => s + r.estimatedUnits, 0);

function curveOf(state: PlanState): PlanPool | undefined {
  return state.pools.find((p) => p.role === 'curve');
}
function graduationOf(state: PlanState): PlanPool | undefined {
  return state.pools.find((p) => p.role === 'graduation');
}

/** Phase `initial`: 1-minute windows and daily bars. Needs no stored bars. */
function initialRequests(state: PlanState, gradStart: number | null): PlannedRequest[] {
  const limits = limitsOf(state);
  const curve = curveOf(state);
  const grad = graduationOf(state);
  const out: PlannedRequest[] = [];

  if (curve) {
    // The curve's last hours: up to 24 hours before graduation, never before launch.
    const end = gradStart ?? state.asOf;
    const start = Math.max(
      state.launchedAt ?? end - limits.curveTailSec,
      end - limits.curveTailSec,
    );
    out.push(
      ...requestsFor(
        state,
        curve.address,
        60,
        { from: floorTo(start, MINUTE), to: end },
        'curve_tail',
      ),
    );
  }
  if (grad && gradStart !== null) {
    out.push(...postGraduationMinuteRequests(state, grad.address, gradStart, limits));
  }

  // Daily bars for the whole life of both primary pools, and of the others.
  const launchDay = floorTo(state.launchedAt ?? gradStart ?? state.asOf - DAY, DAY);
  if (curve) {
    const curveEnd = gradStart === null ? state.asOf : ceilTo(gradStart + 1, DAY);
    out.push(
      ...requestsFor(state, curve.address, 86400, { from: launchDay, to: curveEnd }, 'daily_life'),
    );
  }
  if (grad) {
    const from = floorTo(gradStart ?? state.launchedAt ?? state.asOf - DAY, DAY);
    out.push(...requestsFor(state, grad.address, 86400, { from, to: state.asOf }, 'daily_life'));
  }
  for (const pool of state.pools) {
    if (pool.role !== 'other') continue;
    out.push(
      ...requestsFor(state, pool.address, 86400, { from: launchDay, to: state.asOf }, 'daily_life'),
    );
  }
  return out;
}

function postGraduationMinuteRequests(
  state: PlanState,
  address: string,
  gradStart: number,
  limits: PlanLimits,
): PlannedRequest[] {
  // Start a few minutes early: the provider's first bar can precede the pool's recorded creation.
  const from = floorTo(gradStart - 5 * MINUTE, MINUTE);
  const to = Math.min(gradStart + limits.postGraduationMinuteSec, state.asOf);
  return requestsFor(state, address, 60, { from, to }, 'post_graduation_minute');
}

/** Hourly ranges worth fetching, in priority order, with the request reason. */
function hourlyNeeds(
  state: PlanState,
): { address: string; range: Interval; reason: RequestReason }[] {
  const needs: { address: string; range: Interval; reason: RequestReason }[] = [];
  const primaries = [graduationOf(state), curveOf(state)].filter((p): p is PlanPool => !!p);
  for (const pool of primaries) {
    const d = state.daily[pool.address];
    if (!d) continue;
    // Only stretches with trading: days with a daily bar, joined across gaps shorter than one
    // 1,500-hour window (a request across such a gap costs nothing extra). A dead coin with
    // two years of scattered trades does not pay for the empty months.
    const runs = mergeIntervals(
      d.days.map((t) => ({ from: floorTo(t, DAY), to: floorTo(t, DAY) + DAY })),
      HOURLY_GAP_MERGE_SEC,
    );
    for (const run of runs) {
      const to = Math.min(run.to, state.asOf);
      if (to > run.from) {
        needs.push({ address: pool.address, range: { from: run.from, to }, reason: 'hourly_life' });
      }
    }
  }
  for (const pool of state.pools) {
    if (pool.role !== 'other') continue;
    const d = state.daily[pool.address];
    if (!d) continue;
    for (const run of mergeIntervals(
      d.qualifyingDays.map((t) => ({ from: floorTo(t, DAY), to: floorTo(t, DAY) + DAY })),
    )) {
      const to = Math.min(run.to, state.asOf);
      if (to > run.from) {
        needs.push({
          address: pool.address,
          range: { from: run.from, to },
          reason: 'secondary_hourly',
        });
      }
    }
  }
  return needs;
}

/**
 * Hourly requests: the first `maxHourlyRequests` windows, in priority order
 * (graduation pool, curve, then other pools by their order in `pools`),
 * minus what is already covered.
 */
function hourlyRequests(
  state: PlanState,
  limits: PlanLimits,
): { requests: PlannedRequest[]; deferredWindows: number } {
  const windows: { address: string; res: Interval; piece: Interval; reason: RequestReason }[] = [];
  for (const need of hourlyNeeds(state)) {
    for (const w of planBarRequests({
      from: need.range.from,
      to: need.range.to,
      resolution: '60',
    })) {
      windows.push({
        address: need.address,
        res: { from: w.from, to: w.to + 1 },
        piece: {
          from: Math.max(w.from, need.range.from),
          to: Math.min(w.to + 1, need.range.to),
        },
        reason: need.reason,
      });
    }
  }
  const requests: PlannedRequest[] = [];
  let deferred = 0;
  windows.forEach((w, index) => {
    const uncovered = subtractIntervals(w.piece, coverageOf(state, w.address, 3600));
    if (index >= limits.maxHourlyRequests) {
      if (uncovered.length > 0) deferred += 1;
      return;
    }
    for (const piece of uncovered) {
      requests.push(...windowRequests(w.address, 3600, piece, w.reason));
    }
  });
  return { requests, deferredWindows: deferred };
}

/**
 * The next requests of phases `initial` and `followup`. Returns the first phase
 * that still has work, or `complete` with no requests.
 */
export function planBaseRequests(state: PlanState): BasePlan {
  return limitsOf(state).staged ? planStaged(state) : planExhaustive(state);
}

const EXHAUSTIVE_STAGE: StageInfo = {
  path: 'full',
  w: null,
  escalated: false,
  screenedOut: false,
};

function planExhaustive(state: PlanState): BasePlan {
  const limits = limitsOf(state);
  const gradStart = graduationStart(state);
  const noHourly = { deferredWindows: 0, capHit: false };

  const initial = initialRequests(state, gradStart);
  if (initial.length > 0) {
    return {
      phase: 'initial',
      requests: initial,
      estimatedUnits: sumUnits(initial),
      hourly: noHourly,
      needsPoolList: false,
      stage: EXHAUSTIVE_STAGE,
    };
  }

  const followup: PlannedRequest[] = [];
  // No creation or migration time for the graduation pool: its first daily bar stands in.
  const grad = graduationOf(state);
  if (grad && gradStart === null) {
    const first = state.daily[grad.address]?.first;
    if (first !== null && first !== undefined) {
      followup.push(...postGraduationMinuteRequests(state, grad.address, first, limits));
    }
  }
  const hourly = hourlyRequests(state, limits);
  followup.push(...hourly.requests);
  return {
    phase: followup.length > 0 ? 'followup' : 'complete',
    requests: followup,
    estimatedUnits: sumUnits(followup),
    hourly: { deferredWindows: hourly.deferredWindows, capHit: hourly.deferredWindows > 0 },
    needsPoolList: false,
    stage: EXHAUSTIVE_STAGE,
  };
}

// The staged plan ----------------------------------------------------------

/** The pool the screen and the light path look at: the graduation pool, else the curve. */
function primaryOf(state: PlanState): PlanPool | undefined {
  return graduationOf(state) ?? curveOf(state);
}

/** One request's worth of minutes, as seconds. */
const MINUTE_WINDOW_SEC = WINDOW_BUCKETS * MINUTE;
const HOURLY_WINDOW_SEC = WINDOW_BUCKETS * HOUR;

/**
 * Hourly windows for days whose daily high is at least `fromUsd` and that
 * neither 1-minute nor hourly bars already cover, packed greedily: a window
 * starts at the first uncovered qualifying day and runs 1,500 hours; the next
 * starts at the next qualifying day it does not cover. Runs are never joined
 * across gaps. The windows are clipped to `asOf`.
 */
export function packHourlyWindows(
  days: readonly number[],
  coveredMinutes: readonly Interval[],
  coveredHours: readonly Interval[],
  asOf: number,
): Interval[] {
  const windows: Interval[] = [];
  for (const d of [...days].sort((a, b) => a - b)) {
    const day: Interval = { from: floorTo(d, DAY), to: Math.min(floorTo(d, DAY) + DAY, asOf) };
    if (day.to <= day.from) continue;
    const covered = [...coveredMinutes, ...coveredHours, ...windows];
    const open = subtractIntervals(day, covered)[0];
    if (!open) continue;
    const from = floorTo(open.from, HOUR);
    windows.push({ from, to: Math.min(from + HOURLY_WINDOW_SEC, asOf) });
  }
  return windows;
}

function hourlyWindowRequests(
  state: PlanState,
  limits: PlanLimits,
  primary: PlanPool,
  full: boolean,
): { requests: PlannedRequest[]; deferredWindows: number } {
  const candidates: { address: string; window: Interval; reason: RequestReason }[] = [];
  const pools = [primary, ...(full ? state.pools.filter((p) => p.role === 'other') : [])];
  for (const pool of pools) {
    const d = state.daily[pool.address];
    if (!d) continue;
    const liquid = new Set(d.qualifyingDays);
    const days = d.days.filter(
      (t, i) =>
        (d.highs[i] ?? 0) >= limits.hourlyFromUsd && (pool.role !== 'other' || liquid.has(t)),
    );
    for (const window of packHourlyWindows(
      days,
      coverageOf(state, pool.address, 60),
      coverageOf(state, pool.address, 3600),
      state.asOf,
    )) {
      candidates.push({
        address: pool.address,
        window,
        reason: pool.role === 'other' ? 'secondary_hourly' : 'hourly_life',
      });
    }
  }
  // The cap counts windows over the coin's life, so a later run cannot creep past it.
  const cap = full ? limits.maxHourlyRequestsFull : limits.maxHourlyRequests;
  const used = state.pools.reduce((n, p) => n + coverageOf(state, p.address, 3600).length, 0);
  const room = Math.max(0, cap - used);
  const requests: PlannedRequest[] = [];
  for (const c of candidates.slice(0, room)) {
    for (const piece of subtractIntervals(c.window, coverageOf(state, c.address, 3600))) {
      requests.push(...windowRequests(c.address, 3600, piece, c.reason));
    }
  }
  return { requests, deferredWindows: Math.max(0, candidates.length - room) };
}

/**
 * One request of the curve's last 1,500 minutes before graduation (never before
 * launch), minus what is covered.
 */
function curveTailRequests(state: PlanState, curve: PlanPool, end: number): PlannedRequest[] {
  const to = ceilTo(end, MINUTE);
  const earliest = floorTo(state.launchedAt ?? to - MINUTE_WINDOW_SEC, MINUTE);
  const from = Math.max(earliest, to - MINUTE_WINDOW_SEC);
  return requestsFor(state, curve.address, 60, { from, to }, 'curve_tail');
}

function planStaged(state: PlanState): BasePlan {
  const limits = limitsOf(state);
  const listed = state.poolsListed === true;
  const done = (
    stage: StageInfo,
    extra: Partial<Pick<BasePlan, 'needsPoolList'>> = {},
  ): BasePlan => ({
    phase: 'complete',
    requests: [],
    estimatedUnits: 0,
    hourly: { deferredWindows: 0, capHit: false },
    needsPoolList: extra.needsPoolList ?? false,
    stage,
  });
  const initial = (
    requests: PlannedRequest[],
    stage: StageInfo,
    needsPoolList = false,
  ): BasePlan => ({
    phase: 'initial',
    requests,
    estimatedUnits: sumUnits(requests),
    hourly: { deferredWindows: 0, capHit: false },
    needsPoolList,
    stage,
  });

  const primary = primaryOf(state);
  const screening: StageInfo = { path: 'screen', w: null, escalated: false, screenedOut: false };
  if (!primary) return done(screening, { needsPoolList: !listed });

  // Stage 1: the screen. Daily bars of the primary pool for its whole life.
  const gradStart = graduationStart(state);
  const launchDay = floorTo(state.launchedAt ?? gradStart ?? state.asOf - DAY, DAY);
  const primaryFrom =
    primary.role === 'graduation'
      ? floorTo(gradStart ?? state.launchedAt ?? state.asOf - DAY, DAY)
      : launchDay;
  const screenBars = requestsFor(
    state,
    primary.address,
    86400,
    { from: primaryFrom, to: state.asOf },
    'daily_life',
  );
  if (screenBars.length > 0) return initial(screenBars, screening);

  const primaryDaily = state.daily[primary.address];
  const w1 = primaryDaily?.maxHigh ?? 0;
  const rough = state.roughAthUsd ?? null;
  const escalated = rough !== null && rough > limits.escalationRatio * w1;
  const full = escalated || w1 >= limits.fullPathFromUsd;
  const stage: StageInfo = { path: full ? 'full' : 'light', w: w1, escalated, screenedOut: false };

  if (!full && w1 < limits.screenBelowUsd) return done({ ...stage, screenedOut: true });

  // Stage 3: the other pools' daily bars, and W over all of them.
  const others = state.pools.filter((p) => p.role === 'other');
  if (full) {
    if (!listed) return done(stage, { needsPoolList: true });
    const otherDaily: PlannedRequest[] = [];
    for (const pool of others) {
      otherDaily.push(
        ...requestsFor(
          state,
          pool.address,
          86400,
          { from: launchDay, to: state.asOf },
          'daily_life',
        ),
      );
    }
    if (otherDaily.length > 0) return initial(otherDaily, stage);
    const w = Math.max(w1, ...others.map((p) => state.daily[p.address]?.maxHigh ?? 0));
    stage.w = w;
    if (w < limits.screenBelowUsd) return done({ ...stage, screenedOut: true });
  }

  // Stage 2: the primary pool's first 1,500 minutes, and the curve's last ones when it matters.
  const minutes: PlannedRequest[] = [];
  const start =
    primary.role === 'graduation'
      ? (gradStart ?? primaryDaily?.first ?? null)
      : (state.launchedAt ?? launchDay);
  if (start !== null) {
    const from = floorTo(start - 5 * MINUTE, MINUTE);
    minutes.push(
      ...requestsFor(
        state,
        primary.address,
        60,
        { from, to: from + MINUTE_WINDOW_SEC },
        'primary_minute',
      ),
    );
  }
  let needsPoolList = false;
  const grad = graduationOf(state);
  if (grad && (primaryDaily?.firstOpen ?? 0) >= limits.curveFromUsd) {
    const curve = curveOf(state);
    if (curve) {
      const end = gradStart ?? primaryDaily?.first ?? null;
      if (end !== null) minutes.push(...curveTailRequests(state, curve, end));
    } else if (!listed) {
      needsPoolList = true;
    }
  }
  if (minutes.length > 0 || needsPoolList) return initial(minutes, stage, needsPoolList);

  // Hourly bars.
  const hourly = hourlyWindowRequests(state, limits, primary, full);
  return {
    phase: hourly.requests.length > 0 ? 'followup' : 'complete',
    requests: hourly.requests,
    estimatedUnits: sumUnits(hourly.requests),
    hourly: { deferredWindows: hourly.deferredWindows, capHit: hourly.deferredWindows > 0 },
    needsPoolList: false,
    stage,
  };
}

/**
 * A full 1,500-minute window holding the target bucket, clipped to `asOf`, minus
 * what is covered. The piece that holds the bucket's first uncovered minute is
 * the request (one request: no piece is longer than 1,500 minutes).
 */
function refinementWindowRequests(
  state: PlanState,
  target: PeakTarget,
  bucket: Interval,
): PlannedRequest[] {
  const covered = coverageOf(state, target.poolAddress, 60);
  const open = subtractIntervals(
    { from: bucket.from, to: Math.min(bucket.to, state.asOf) },
    covered,
  );
  if (open.length === 0) return [];
  const from = target.resolution === 3600 ? target.t + HOUR / 2 - MINUTE_WINDOW_SEC / 2 : target.t;
  const window: Interval = { from, to: Math.min(from + MINUTE_WINDOW_SEC, state.asOf) };
  const piece = subtractIntervals(window, covered).find(
    (p) => p.from <= open[0]!.from && open[0]!.from < p.to,
  );
  return piece ? windowRequests(target.poolAddress, 60, piece, 'peak_refinement') : [];
}

/**
 * Peak refinement: the next 1-minute request for the highest unrefined target.
 * `targets` are the hourly or daily points above the ATH, highest first (see
 * `findCoveragePeaks`). `requestsDone` is how many refinement requests this coin
 * has used so far, counted across runs.
 *
 * Staged plan: the request is a full window of 1,500 minutes that holds the
 * target bucket (centred on an hourly one, starting at a daily one), clipped to
 * `asOf` and minus what is covered. Exhaustive plan: the bucket itself.
 */
export function planPeakRefinement(
  state: PlanState,
  targets: readonly PeakTarget[],
  requestsDone: number,
): RefinementPlan {
  const limits = limitsOf(state);
  for (const target of targets) {
    const need: Interval = { from: target.t, to: target.t + target.resolution };
    const requests = limits.staged
      ? refinementWindowRequests(state, target, need)
      : requestsFor(state, target.poolAddress, 60, need, 'peak_refinement');
    if (requests.length === 0) continue;
    if (requestsDone >= limits.maxRefinementRequests) {
      return { request: null, capHit: true, exhausted: false };
    }
    return { request: requests[0]!, capHit: false, exhausted: false };
  }
  return { request: null, capHit: false, exhausted: true };
}

export interface UnitEstimate {
  /** Requests and units of the `initial` phase, exact for this state. */
  initialRequests: number;
  initialUnits: number;
  /** Hourly requests and units: exact once daily bars are stored, otherwise an upper bound from the pools' lifetimes. */
  hourlyRequests: number;
  hourlyUnits: number;
  hourlyIsUpperBound: boolean;
  /** The refinement cap, in units. A coin rarely uses it. */
  refinementCapUnits: number;
  /** `initialUnits + hourlyUnits + refinementCapUnits`. Lookups (launch info and pool list) are extra. */
  upperBoundUnits: number;
  /** `initialUnits + hourlyUnits`: what a coin without refinement needs. */
  typicalUnits: number;
}

/**
 * Estimated compute units for the whole plan of one coin, before anything is
 * sent. Before the daily bars exist the hourly part is an upper bound: the
 * number of 1,500-hour windows in the primary pools' lifetimes, at most the cap.
 */
export function estimateCoinUnits(state: PlanState): UnitEstimate {
  const limits = limitsOf(state);
  if (limits.staged) {
    // What is due now is exact; the hourly part is bounded by the cap until the daily bars show which days need it.
    const plan = planStaged(state);
    const initialN = plan.phase === 'initial' ? plan.requests.length : 0;
    const hourlyKnown = plan.phase !== 'initial';
    const hourlyN = hourlyKnown
      ? plan.phase === 'followup'
        ? plan.requests.length
        : 0
      : limits.maxHourlyRequests;
    const initialUnits = initialN * UNITS_PER_BARS_REQUEST;
    const hourlyUnits = hourlyN * UNITS_PER_BARS_REQUEST;
    const refinementCapUnits = limits.maxRefinementRequests * UNITS_PER_BARS_REQUEST;
    return {
      initialRequests: initialN,
      initialUnits,
      hourlyRequests: hourlyN,
      hourlyUnits,
      hourlyIsUpperBound: !hourlyKnown,
      refinementCapUnits,
      upperBoundUnits: initialUnits + hourlyUnits + refinementCapUnits,
      typicalUnits: initialUnits + hourlyUnits,
    };
  }
  const gradStart = graduationStart(state);
  const initial = initialRequests(state, gradStart);
  const dailyKnown = state.pools
    .filter((p) => p.role !== 'other')
    .some((p) => state.daily[p.address]?.first != null);

  let hourlyRequestsN: number;
  let upper: boolean;
  if (dailyKnown || initial.length === 0) {
    hourlyRequestsN = hourlyRequests(state, limits).requests.length;
    upper = false;
  } else {
    const grad = graduationOf(state);
    const curve = curveOf(state);
    let windows = 0;
    if (grad) {
      const from = floorTo(gradStart ?? state.launchedAt ?? state.asOf - DAY, DAY);
      windows += planBarRequests({ from, to: state.asOf, resolution: '60' }).length;
    }
    if (curve) {
      const from = floorTo(state.launchedAt ?? gradStart ?? state.asOf - DAY, DAY);
      const to = gradStart === null ? state.asOf : ceilTo(gradStart + 1, DAY);
      windows += planBarRequests({ from, to, resolution: '60' }).length;
    }
    hourlyRequestsN = Math.min(limits.maxHourlyRequests, windows);
    upper = true;
  }
  const initialUnits = sumUnits(initial);
  const hourlyUnits = hourlyRequestsN * UNITS_PER_BARS_REQUEST;
  const refinementCapUnits = limits.maxRefinementRequests * UNITS_PER_BARS_REQUEST;
  return {
    initialRequests: initial.length,
    initialUnits,
    hourlyRequests: hourlyRequestsN,
    hourlyUnits,
    hourlyIsUpperBound: upper,
    refinementCapUnits,
    upperBoundUnits: initialUnits + hourlyUnits + refinementCapUnits,
    typicalUnits: initialUnits + hourlyUnits,
  };
}
