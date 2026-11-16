/**
 * Candle fetching and metric write-back for one coin (plan task A5, part 2).
 *
 * Two entry points, for the worker (part 3) to call:
 *
 *   fetchCandlesForCoin(
 *     deps: { db: Kysely<Database>; codex: CodexClient; clock: () => Date },
 *     coin: { id: number; address: string; chain?: string;
 *             launchInfo?: LaunchInfo | null; refreshPools?: boolean },
 *     options?: { limits?: Partial<PlanLimits>; maxSecondaryPools?: number },
 *   ): Promise<{ ok: true; summary } | { ok: false; reason; retry; message; summary }>
 *
 *     Runs the staged plan (see plan.ts; `EXHAUSTIVE_PLAN_LIMITS` is the old
 *     one): launch info, a screen on daily bars, then minute and hourly bars,
 *     and the other pools and the bonding curve only when the coin needs them.
 *     Fetches under the client's unit budget, stores bars and the requested
 *     ranges, refines the peak, and returns a summary (path taken, pools, bars
 *     per resolution, requests, units this coin cost, refinement rounds,
 *     flags). A screened-out coin stops after the screen. A second call with the same clock makes no
 *     request and changes no row. Expected provider failures (network, quota,
 *     bad key, budget ceiling, odd responses) come back as `ok: false` with a
 *     `reason` and whether a `retry` makes sense; anything else (a database
 *     error, a bug) is thrown.
 *
 *   computeMetricsForCoin(
 *     deps: { db: Kysely<Database>; clock: () => Date },
 *     coin: { id: number },
 *   ): Promise<{ ok: true; asOf; result; status; metricsVersion; barCount }
 *             | { ok: false; reason; retry; message }>
 *
 *     Reads the stored bars, runs `computeCoinMetrics`, and writes every metric
 *     column of `coins` plus the status (alive, dead, rugged, or unknown).
 *     Running it twice with the same clock writes the same values. Makes no
 *     provider call.
 *
 * `planBaseRequests`, `planPeakRefinement` and `estimateCoinUnits` are the pure
 * planning functions; `selectPools` is the pure pool split.
 */
export { fetchCandlesForCoin } from './fetch.js';
export {
  computeMetricsForCoin,
  screenedOutResult,
  noCandlesResult,
  NO_CANDLES_FLAG,
  METRICS_VERSION,
  SCREENED_OUT_FLAG,
  type ComputeMetricsResult,
  type StoredMetricResult,
} from './metrics.js';
export {
  DEFAULT_PLAN_LIMITS,
  EXHAUSTIVE_PLAN_LIMITS,
  UNITS_PER_BARS_REQUEST,
  estimateCoinUnits,
  graduationStart,
  packHourlyWindows,
  planBaseRequests,
  planPeakRefinement,
  summarizeDaily,
  subtractIntervals,
  mergeIntervals,
  type BasePlan,
  type Interval,
  type PeakTarget,
  type PlanLimits,
  type PlanPool,
  type PlanState,
  type PlannedRequest,
  type PoolDaily,
  type PoolRole,
  type RefinementPlan,
  type ResolutionSec,
  type StageInfo,
  type UnitEstimate,
} from './plan.js';
export { selectPools, type PoolSelection, type SelectPoolsArgs } from './poolSelection.js';
export { findCoveragePeaks } from './peaks.js';
export { classifyProviderError, type CandleFailure } from './errors.js';
export type {
  BarCounts,
  CandleCoin,
  CandleDeps,
  CandleFetchSummary,
  FetchCandlesOptions,
  FetchCandlesResult,
  PoolSummary,
} from './types.js';
