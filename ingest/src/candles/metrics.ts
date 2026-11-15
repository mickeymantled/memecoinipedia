import {
  computeAndStoreCoinMetrics,
  type CoinStatus,
  type MetricInputShape,
  type MetricResultShape,
} from '@memecoinipedia/db';
import { computeCoinMetrics } from '../metrics/index.js';
import type { MetricFlag, MetricResult } from '../metrics/types.js';
import { DEFAULT_PLAN_LIMITS } from './plan.js';
import type { CandleDeps } from './types.js';

/** Stored in `coins.metrics_version`. Raise it when docs/metrics.md or the status rule changes. */
export const METRICS_VERSION = 2;

/** The flag the fetcher sets on a coin it screened out. It is not one of the metric library's flags. */
export const SCREENED_OUT_FLAG = 'screened_out';

/** The library's result, with the fetcher's own flag allowed. */
export type StoredMetricResult = Omit<MetricResult, 'flags'> & {
  flags: (MetricFlag | typeof SCREENED_OUT_FLAG)[];
};

export type ComputeMetricsResult =
  | {
      ok: true;
      /** Observation time used, unix seconds. */
      asOf: number;
      result: StoredMetricResult;
      status: CoinStatus;
      metricsVersion: number;
      /** Bars read, all pools and resolutions. */
      barCount: number;
      /** The coin has no 1-minute bars and no daily high reaching the screen line: stored as screened out. */
      screenedOut: boolean;
    }
  | {
      ok: false;
      /** `coin_not_found`, `missing_launch_time` or `no_candles`. */
      reason: string;
      /** False: none of these is fixed by trying again; run the candle stage first. */
      retry: boolean;
      message: string;
    };

/**
 * The same answer for a screened-out coin as the fetcher's stage 1 gives, from
 * stored bars alone: no 1-minute bars, and no daily high of `screenBelowUsd` as a
 * market cap. Then the highest daily high is the wick, and the ATH, the time
 * above the thresholds and the drawdown stay null (they need 1-minute bars). The
 * flag set is `screened_out` alone.
 */
export function screenedOutResult(
  input: MetricInputShape,
  screenBelowUsd: number,
): MetricResultShape | null {
  let any = false;
  let top = 0;
  for (const pool of input.pools) {
    if (pool.bars1m.length > 0) return null;
    for (const bar of pool.bars1d) {
      any = true;
      top = Math.max(top, bar.o, bar.h, bar.l, bar.c);
    }
  }
  if (!any || top * input.totalSupply >= screenBelowUsd) return null;
  // The wick is the library's, so a bar it would drop as implausible is dropped here too.
  const lib = computeCoinMetrics(input);
  return {
    athMarketCapUsd: null,
    athAt: null,
    athPoolAddress: null,
    secondsToAth: null,
    athWickMarketCapUsd: lib.athWickMarketCapUsd,
    athWickAt: lib.athWickAt,
    athWickPoolAddress: lib.athWickPoolAddress,
    secondsAbove: [],
    maxDrawdownPct: null,
    rugPattern: false,
    flags: [SCREENED_OUT_FLAG],
  };
}

/** See the header of ./index.ts. */
export async function computeMetricsForCoin(
  deps: Pick<CandleDeps, 'db' | 'clock'>,
  coin: { id: number },
  options: { screenBelowUsd?: number } = {},
): Promise<ComputeMetricsResult> {
  const now = deps.clock();
  const asOf = Math.floor(now.getTime() / 1000);
  const screenBelowUsd = options.screenBelowUsd ?? DEFAULT_PLAN_LIMITS.screenBelowUsd;
  let screenedOut = false;
  const out = await computeAndStoreCoinMetrics(deps.db, coin.id, {
    compute: (input) => {
      const screened = screenedOutResult(input, screenBelowUsd);
      screenedOut = screened !== null;
      return screened ?? computeCoinMetrics(input);
    },
    asOf,
    computedAt: now,
    metricsVersion: METRICS_VERSION,
  });
  if (!out.ok) {
    const message =
      out.reason === 'no_candles'
        ? 'No bars are stored for this coin; fetch its candles first'
        : out.reason === 'missing_launch_time'
          ? 'The coin has no launch time'
          : `No coin with id ${coin.id}`;
    return { ok: false, reason: out.reason, retry: false, message };
  }
  return {
    ok: true,
    asOf,
    // The shape is the library's own (or the screened-out one); the db layer only knows it structurally.
    result: out.result as StoredMetricResult,
    status: out.status,
    metricsVersion: METRICS_VERSION,
    barCount: out.barCount,
    screenedOut,
  };
}
