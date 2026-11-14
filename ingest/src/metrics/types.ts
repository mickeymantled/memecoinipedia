/**
 * Public types for the price metric library.
 *
 * The rules these types serve are in docs/metrics.md. That file decides any
 * disagreement, so change it first and this file second.
 */

/** One OHLCV bucket. Only buckets with at least one trade have a bar. */
export interface Bar {
  /** Start of the bucket, unix seconds, UTC. A multiple of the resolution. */
  t: number;
  /** Open, high, low and close, in USD per token. */
  o: number;
  h: number;
  l: number;
  c: number;
  /** USD traded in the bucket. */
  volumeUsd: number;
  /** Number of swaps in the bucket. */
  trades: number;
  /** Distinct wallets that traded in the bucket. */
  traders: number;
  /** Pool liquidity in USD, or null when unknown. */
  liquidityUsd: number | null;
}

export interface PoolSeries {
  address: string;
  dex: string;
  /** True for the pump.fun bonding curve and for the pool the coin graduated into. */
  isPrimary: boolean;
  /** Bars at 1-minute, 1-hour and 1-day resolution. Any may be empty or unsorted. */
  bars1m: Bar[];
  bars1h: Bar[];
  bars1d: Bar[];
}

export interface MetricInput {
  /** 1,000,000,000 for every pump.fun coin. Market cap is price times this. */
  totalSupply: number;
  /** When the coin was created, unix seconds. */
  launchedAt: number;
  /** End of the observation period, unix seconds. Later bars are ignored. */
  asOf: number;
  pools: PoolSeries[];
}

/** See docs/metrics.md section 2 for the meaning of each value. */
export interface MetricParams {
  windowMinutes: number;
  minWindowVolumeUsd: number;
  minWindowTraders: number;
  minSecondaryPoolLiquidityUsd: number;
  carryForwardMaxSec: number;
  maxMarketCapUsd: number;
  /** Ascending. `MetricResult.secondsAbove` follows the same order. */
  thresholdsUsd: readonly number[];
  rugDropPct: number;
  rugWithinSec: number;
  rugRecoveryFraction: number;
}

export const DEFAULT_METRIC_PARAMS: MetricParams = {
  windowMinutes: 3,
  minWindowVolumeUsd: 1_000,
  minWindowTraders: 5,
  minSecondaryPoolLiquidityUsd: 5_000,
  carryForwardMaxSec: 86_400,
  maxMarketCapUsd: 20_000_000_000,
  thresholdsUsd: [100_000, 1_000_000, 10_000_000, 100_000_000],
  rugDropPct: 80,
  rugWithinSec: 1_800,
  rugRecoveryFraction: 0.5,
};

export type MetricFlag =
  | 'ath_before_launch'
  | 'bad_bar'
  | 'duplicate_bar'
  | 'implausible_market_cap'
  | 'no_qualifying_window'
  | 'peak_outside_minute_coverage';

export interface MetricResult {
  athMarketCapUsd: number | null;
  /** Unix seconds: the last minute of the window that set the ATH. */
  athAt: number | null;
  athPoolAddress: string | null;
  secondsToAth: number | null;
  athWickMarketCapUsd: number | null;
  athWickAt: number | null;
  athWickPoolAddress: string | null;
  /** Seconds at or above each threshold, in the order of `thresholdsUsd`. */
  secondsAbove: number[];
  /** 0 to 100, or null when there is no level series. */
  maxDrawdownPct: number | null;
  rugPattern: boolean;
  /** Each flag at most once, sorted alphabetically. */
  flags: MetricFlag[];
}

/** The library's entry point, exported from ./index.ts as `computeCoinMetrics`. */
export type ComputeCoinMetrics = (
  input: MetricInput,
  params?: Partial<MetricParams>,
) => MetricResult;

/** A hand-worked test case. Fixtures live in /ingest/test/fixtures/metrics. */
export interface MetricFixture {
  /** Unique, kebab-case. */
  name: string;
  /** What the case tests, in a sentence or two. */
  description: string;
  /** The hand calculation, step by step, following docs/metrics.md. */
  reasoning: string;
  input: MetricInput;
  /** Overrides of the default parameters, when the case needs them. */
  params?: Partial<MetricParams>;
  expected: MetricResult;
}
