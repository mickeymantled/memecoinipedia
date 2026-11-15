import {
  atLeast,
  compareStrings,
  isFunded,
  maxLiquidity,
  SECONDS,
  type CleanPool,
  type CoinPoint,
} from './internal.js';
import type { MetricFlag, MetricParams, MetricResult } from './types.js';

export type AthFields = Pick<
  MetricResult,
  'athMarketCapUsd' | 'athAt' | 'athPoolAddress' | 'secondsToAth' | 'athLiquidityUsd'
>;

export interface AthResult {
  fields: AthFields;
  /** The ATH price in USD per token, or null. Needed by the later steps. */
  athPrice: number | null;
  flags: MetricFlag[];
}

/**
 * Section 6, ATH: the highest price among strict coin points from 1-minute bars; the
 * earliest such point if several share it.
 */
export function computeAth(
  points: readonly CoinPoint[],
  launchedAt: number,
  totalSupply: number,
): AthResult {
  let best: CoinPoint | null = null;
  for (const p of points) {
    if (!p.strict || p.resolution !== '1m') continue;
    if (best === null || p.price > best.price || (p.price === best.price && p.t < best.t)) best = p;
  }
  if (best === null) {
    return {
      fields: {
        athMarketCapUsd: null,
        athAt: null,
        athPoolAddress: null,
        secondsToAth: null,
        athLiquidityUsd: null,
      },
      athPrice: null,
      flags: ['no_qualifying_window'],
    };
  }
  const secondsToAth = best.t - launchedAt;
  return {
    fields: {
      athMarketCapUsd: best.price * totalSupply,
      athAt: best.t,
      athPoolAddress: best.poolAddress,
      secondsToAth,
      athLiquidityUsd: best.liquidity,
    },
    athPrice: best.price,
    flags: secondsToAth < 0 ? ['ath_before_launch'] : [],
  };
}

export type WickFields = Pick<
  MetricResult,
  'athWickMarketCapUsd' | 'athWickAt' | 'athWickPoolAddress'
>;

type WickParams = Pick<
  MetricParams,
  'minWindowVolumeUsd' | 'minWindowTraders' | 'minWindowLiquidityUsd'
>;

/**
 * Section 6, wick: the highest max(open, close) over clean 1-minute bars that are
 * funded by themselves (their own liquidity and the previous clean bar's) and that by
 * themselves have the volume and traders a window needs. Earliest bar wins; on a tie
 * in `t`, the smallest pool address. If the ATH is higher, or there is no candidate,
 * the wick is the ATH. Null only when there is neither.
 */
export function computeWick(
  pools: readonly CleanPool[],
  ath: AthResult,
  params: WickParams,
  totalSupply: number,
): WickFields {
  let top: { value: number; t: number; address: string } | null = null;
  for (const pool of pools) {
    for (let i = 0; i < pool.bars1m.length; i++) {
      const bar = pool.bars1m[i];
      if (bar === undefined) continue;
      if (
        !isFunded(maxLiquidity([bar, pool.bars1m[i - 1]]), params.minWindowLiquidityUsd) ||
        !atLeast(bar.volumeUsd, params.minWindowVolumeUsd) ||
        !atLeast(bar.traders, params.minWindowTraders)
      ) {
        continue;
      }
      const value = Math.max(bar.o, bar.c);
      if (
        top === null ||
        value > top.value ||
        (value === top.value &&
          (bar.t < top.t || (bar.t === top.t && compareStrings(pool.address, top.address) < 0)))
      ) {
        top = { value, t: bar.t, address: pool.address };
      }
    }
  }
  if (ath.athPrice !== null && (top === null || ath.athPrice > top.value)) {
    return {
      athWickMarketCapUsd: ath.athPrice * totalSupply,
      athWickAt: ath.fields.athAt,
      athWickPoolAddress: ath.fields.athPoolAddress,
    };
  }
  if (top === null) {
    return { athWickMarketCapUsd: null, athWickAt: null, athWickPoolAddress: null };
  }
  return {
    athWickMarketCapUsd: top.value * totalSupply,
    athWickAt: top.t,
    athWickPoolAddress: top.address,
  };
}

/** Section 6, `athHourVolumeUsd`: 1-minute volume of every pool in (athAt - 3600, athAt]. */
export function athHourVolume(pools: readonly CleanPool[], athAt: number | null): number | null {
  if (athAt === null) return null;
  let sum = 0;
  for (const pool of pools) {
    for (const bar of pool.bars1m) {
      if (bar.t > athAt - SECONDS['1h'] && bar.t <= athAt) sum += bar.volumeUsd;
    }
  }
  return sum;
}

/**
 * Section 6, coverage flag: a strict hourly or daily coin point priced above the ATH,
 * or any such point while the ATH is null.
 */
export function peakOutsideMinuteCoverage(
  points: readonly CoinPoint[],
  athPrice: number | null,
): boolean {
  return points.some(
    (p) => p.strict && p.resolution !== '1m' && (athPrice === null || p.high > athPrice),
  );
}
