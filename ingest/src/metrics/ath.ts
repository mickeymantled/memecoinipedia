import { barPeak, compareStrings, type CleanPool, type CoinPoint } from './internal.js';
import type { MetricFlag, MetricResult } from './types.js';

export type AthFields = Pick<
  MetricResult,
  'athMarketCapUsd' | 'athAt' | 'athPoolAddress' | 'secondsToAth'
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
      fields: { athMarketCapUsd: null, athAt: null, athPoolAddress: null, secondsToAth: null },
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
    },
    athPrice: best.price,
    flags: secondsToAth < 0 ? ['ath_before_launch'] : [],
  };
}

export type WickFields = Pick<
  MetricResult,
  'athWickMarketCapUsd' | 'athWickAt' | 'athWickPoolAddress'
>;

/**
 * Section 6, wick: the highest of max(o, h, l, c) over every clean bar of every pool
 * and resolution. Earliest bar wins; on a tie in `t`, the smallest pool address.
 */
export function computeWick(pools: readonly CleanPool[], totalSupply: number): WickFields {
  let best: { peak: number; t: number; address: string } | null = null;
  for (const pool of pools) {
    for (const bars of [pool.bars1m, pool.bars1h, pool.bars1d]) {
      for (const bar of bars) {
        const peak = barPeak(bar);
        if (
          best === null ||
          peak > best.peak ||
          (peak === best.peak &&
            (bar.t < best.t ||
              (bar.t === best.t && compareStrings(pool.address, best.address) < 0)))
        ) {
          best = { peak, t: bar.t, address: pool.address };
        }
      }
    }
  }
  if (best === null) {
    return { athWickMarketCapUsd: null, athWickAt: null, athWickPoolAddress: null };
  }
  return {
    athWickMarketCapUsd: best.peak * totalSupply,
    athWickAt: best.t,
    athWickPoolAddress: best.address,
  };
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
    (p) => p.strict && p.resolution !== '1m' && (athPrice === null || p.price > athPrice),
  );
}
