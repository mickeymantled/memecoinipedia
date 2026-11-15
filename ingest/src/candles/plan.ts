/**
 * The candle fetch plan: a pure function from what is known to the next
 * requests to make. No network, no database, no clock.
 *
 * Rules (issue #26, docs/metrics.md section 12):
 *
 * 1. 1-minute bars for the bonding curve's last hours (at most 24 hours before
 *    graduation, and never before launch) and for the first 48 hours after the
 *    graduation pool was created.
 * 2. Daily bars for the whole life of both primary pools, then hourly bars for
 *    the stretches of that life with trading (the days that have a daily bar,
 *    joined across gaps shorter than one request's worth). Each request returns
 *    at most 1,500 buckets, so a long life is paged. Hourly requests are capped
 *    per coin (`maxHourlyRequests`); the cap keeps the first windows in priority
 *    order, so the same inputs always give the same plan.
 * 3. Other pools: daily bars only at first. A pool takes part from the first day
 *    its daily bar shows liquidity of at least `minSecondaryPoolLiquidityUsd`;
 *    its hourly bars are fetched for those days only.
 * 4. Peak refinement (`planPeakRefinement`): when the metrics carry
 *    `peak_outside_minute_coverage`, fetch 1-minute bars for the period of the
 *    highest hourly or daily point, one request per round, capped per coin
 *    (`maxRefinementRequests`).
 *
 * Each request costs about 4 compute units. A request already recorded in
 * `coverage` is never planned again; a range reaching a later `asOf` than
 * before plans only the new part.
 *
 * Work comes in two phases because the second needs bars from the first:
 * `initial` (minute windows and daily bars) and `followup` (hourly bars, which
 * depend on which days have daily bars and what their liquidity was).
 */
import { planBarRequests, type BarResolution } from '../sources/codex/index.js';

export const DAY = 86_400;
export const HOUR = 3_600;
export const MINUTE = 60;

export type ResolutionSec = 60 | 3600 | 86400;
export type PoolRole = 'curve' | 'graduation' | 'other';

/** Hourly runs are joined across gaps up to this long: one request's worth, 1,500 hours. */
const HOURLY_GAP_MERGE_SEC = 1_500 * HOUR;

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
  /** `t` of every daily bar whose liquidity is at least the secondary-pool minimum, ascending. */
  qualifyingDays: number[];
}

export interface PlanLimits {
  /** How far before graduation the curve's 1-minute bars start. Default 24 hours. */
  curveTailSec: number;
  /** How long after graduation the pool's 1-minute bars run. Default 48 hours. */
  postGraduationMinuteSec: number;
  /** Most hourly requests for one coin. Default 8 (12,000 hours, about 500 days). */
  maxHourlyRequests: number;
  /** Most peak-refinement requests for one coin. Default 12. */
  maxRefinementRequests: number;
  /** Liquidity a secondary pool needs, USD. Default 5,000 (docs/metrics.md section 2). */
  minSecondaryPoolLiquidityUsd: number;
}

export const DEFAULT_PLAN_LIMITS: PlanLimits = {
  curveTailSec: DAY,
  postGraduationMinuteSec: 2 * DAY,
  maxHourlyRequests: 8,
  maxRefinementRequests: 12,
  minSecondaryPoolLiquidityUsd: 5_000,
};

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
  limits?: Partial<PlanLimits>;
}

export type RequestReason =
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

export interface BasePlan {
  /** `complete` when nothing more is needed before peak refinement. */
  phase: 'initial' | 'followup' | 'complete';
  requests: PlannedRequest[];
  estimatedUnits: number;
  hourly: {
    /** Windows beyond `maxHourlyRequests` that still have uncovered time. */
    deferredWindows: number;
    capHit: boolean;
  };
}

export interface PeakTarget {
  poolAddress: string;
  /** Start of the hourly or daily bucket whose point sits above the ATH. */
  t: number;
  /** Resolution of that bucket, 3600 or 86400. */
  resolution: 3600 | 86400;
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
    if (v !== undefined) (out as unknown as Record<string, number>)[k] = v;
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

/**
 * The summary `PlanState.daily` wants, from stored daily bars (any order).
 * A day qualifies when its liquidity is known and at least `minLiquidityUsd`.
 */
export function summarizeDaily(
  bars: readonly { t: number; liquidityUsd: number | null }[],
  minLiquidityUsd: number,
): PoolDaily {
  const sorted = [...bars].sort((a, b) => a.t - b.t);
  return {
    first: sorted[0]?.t ?? null,
    last: sorted[sorted.length - 1]?.t ?? null,
    days: sorted.map((b) => b.t),
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
  };
}

/**
 * Peak refinement: the next 1-minute request for the highest unrefined target.
 * `targets` are the hourly or daily points above the ATH, highest first (see
 * `findCoveragePeaks`). `requestsDone` is how many refinement requests this coin
 * has used so far, counted across runs.
 */
export function planPeakRefinement(
  state: PlanState,
  targets: readonly PeakTarget[],
  requestsDone: number,
): RefinementPlan {
  const limits = limitsOf(state);
  for (const target of targets) {
    const need: Interval = { from: target.t, to: target.t + target.resolution };
    const requests = requestsFor(state, target.poolAddress, 60, need, 'peak_refinement');
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
