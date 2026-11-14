/**
 * Helpers that BUILD INPUT for the hand-worked fixtures. They never compute
 * any metric: every expected value in a fixture is written out as a literal.
 *
 * Conventions used by every fixture:
 * - Prices are USD per token. Supply is 1,000,000,000, so a price of 0.0001 is
 *   a $100,000 market cap and 0.002 is $2,000,000.
 * - T0 is a multiple of 86,400, so it is also a valid hourly and daily bucket
 *   start. "m5" in a reasoning string means the minute at T0 + 5 * 60.
 * - Expected market caps and drawdowns are exact in real arithmetic. A test
 *   that compares them with floating point must allow a tiny relative error
 *   (for example 1e-9), because 0.00028 * 1e9 is not exactly 280000 in binary.
 */
import type { Bar, MetricInput, PoolSeries } from '../../../src/metrics/types.js';

export const T0 = 1_699_920_000;
export const SUPPLY = 1_000_000_000;

/** Start of minute n after T0. */
export const minute = (n: number): number => T0 + n * 60;
/** Start of hour n after T0. */
export const hourAt = (n: number): number => T0 + n * 3_600;
/** Start of day n after T0. */
export const dayAt = (n: number): number => T0 + n * 86_400;

/**
 * A flat bar (o = h = l = c) with 500 USD of volume, 10 trades and 6 traders,
 * and unknown liquidity. Override any field.
 */
export function bar(t: number, c: number, over: Partial<Bar> = {}): Bar {
  return {
    t,
    o: c,
    h: c,
    l: c,
    c,
    volumeUsd: 500,
    trades: 10,
    traders: 6,
    liquidityUsd: null,
    ...over,
  };
}

/** One bar per minute starting at minute `first`, one close per bar. */
export function minuteRun(first: number, closes: number[], over: Partial<Bar> = {}): Bar[] {
  return closes.map((c, i) => bar(minute(first + i), c, over));
}

/** The same close repeated for `count` minutes starting at minute `first`. */
export function flatRun(first: number, count: number, c: number, over: Partial<Bar> = {}): Bar[] {
  return minuteRun(first, Array<number>(count).fill(c), over);
}

/** A primary pool unless `extra.isPrimary` says otherwise. */
export function pool(address: string, bars1m: Bar[], extra: Partial<PoolSeries> = {}): PoolSeries {
  return {
    address,
    dex: 'test-dex',
    isPrimary: true,
    bars1m,
    bars1h: [],
    bars1d: [],
    ...extra,
  };
}

/** Input with the coin launched at T0 unless told otherwise. */
export function input(pools: PoolSeries[], asOf: number, launchedAt: number = T0): MetricInput {
  return { totalSupply: SUPPLY, launchedAt, asOf, pools };
}
