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
export const METRICS_VERSION = 8;

/**
 * The last rules version that changed which bars count or how a peak is found, so a coin whose
 * candles were fetched under an older version may need bars that fetch did not ask for. A version
 * that only adds an output does not raise it. The metrics stage reopens candles against this, not
 * against `METRICS_VERSION` (docs/metrics.md section 12).
 */
export const CANDLE_RULES_VERSION = 5;

/** The flag the fetcher sets on a coin it screened out. It is not one of the metric library's flags. */
export const SCREENED_OUT_FLAG = 'screened_out';

/** The flag set on a coin that has no bar in any pool that counts (its metrics stage still ends `done`). */
export const NO_CANDLES_FLAG = 'no_candles';

/** The library's result, with the fetcher's and the stage's own flags allowed. */
export type StoredMetricResult = Omit<MetricResult, 'flags'> & {
  flags: (MetricFlag | typeof SCREENED_OUT_FLAG | typeof NO_CANDLES_FLAG)[];
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
      /** Side pools left out of the input because their quote token is not SOL, USDC or USDT. */
      sidePoolsLeftOut: number;
      /** The coin has no bar in any pool that counts (docs/metrics.md section 1): stored with a null ATH and the `no_candles` flag. */
      noCandles: boolean;
    }
  | {
      ok: false;
      /** `coin_not_found` or `missing_launch_time`. */
      reason: string;
      /** False: neither is fixed by trying again. */
      retry: boolean;
      message: string;
    };

/**
 * The same answer for a screened-out coin as the fetcher's stage 1 gives, from
 * stored bars alone: no 1-minute bars, and no daily high of `screenBelowUsd` as a
 * market cap. Then the ATH, the wick, the time above the thresholds, the drawdown
 * and the two ATH outputs are all null: they need 1-minute bars, and the wick rule
 * (docs/metrics.md section 6) takes no daily bar. The daily bars stay stored. The
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
  return {
    athMarketCapUsd: null,
    athAt: null,
    athPoolAddress: null,
    secondsToAth: null,
    athWickMarketCapUsd: null,
    athWickAt: null,
    athWickPoolAddress: null,
    athLiquidityUsd: null,
    athHourVolumeUsd: null,
    athNearVolumeUsd: null,
    secondsAbove: [],
    maxDrawdownPct: null,
    rugPattern: false,
    flags: [SCREENED_OUT_FLAG],
  };
}

/**
 * The result for a coin with no bar in any pool that counts (screened out before any bar was stored, or bars only on left-out side pools):
 * every metric null, no rug, and the flag `no_candles`. The coin's metrics are final: there is
 * nothing to compute and fetching candles again is the candle stage's business, not a retry here.
 */
export function noCandlesResult(): MetricResultShape {
  return {
    athMarketCapUsd: null,
    athAt: null,
    athPoolAddress: null,
    secondsToAth: null,
    athWickMarketCapUsd: null,
    athWickAt: null,
    athWickPoolAddress: null,
    athLiquidityUsd: null,
    athHourVolumeUsd: null,
    athNearVolumeUsd: null,
    secondsAbove: [],
    maxDrawdownPct: null,
    rugPattern: false,
    flags: [NO_CANDLES_FLAG],
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
    noBars: noCandlesResult(),
    asOf,
    computedAt: now,
    metricsVersion: METRICS_VERSION,
  });
  if (!out.ok) {
    const message =
      out.reason === 'missing_launch_time'
        ? 'The coin has no launch time'
        : out.reason === 'no_candles'
          ? 'No bars are stored for this coin' // not reachable: `noBars` is always given
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
    sidePoolsLeftOut: out.sidePoolsLeftOut,
    screenedOut,
    noCandles: out.barCount === 0,
  };
}
