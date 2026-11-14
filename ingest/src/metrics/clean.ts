import { atLeast, atMost, barPeak, type CleanPool } from './internal.js';
import type { Bar, MetricFlag, MetricInput, MetricParams, PoolSeries } from './types.js';

const isPositiveFinite = (x: number): boolean => Number.isFinite(x) && x > 0;

/** Section 3, rule 2: prices finite and above zero, volume finite and zero or more. */
export function isBadBar(bar: Bar): boolean {
  return !(
    isPositiveFinite(bar.o) &&
    isPositiveFinite(bar.h) &&
    isPositiveFinite(bar.l) &&
    isPositiveFinite(bar.c) &&
    Number.isFinite(bar.volumeUsd) &&
    bar.volumeUsd >= 0
  );
}

/** Section 3, rule 3: the largest price field times supply is above the cap. */
export function isImplausibleBar(bar: Bar, totalSupply: number, maxMarketCapUsd: number): boolean {
  return !atMost(barPeak(bar) * totalSupply, maxMarketCapUsd);
}

/** Section 3, rule 5: a non-primary pool's bar needs known, sufficient liquidity. */
export function isIlliquidSecondaryBar(
  bar: Bar,
  isPrimary: boolean,
  minSecondaryPoolLiquidityUsd: number,
): boolean {
  if (isPrimary) return false;
  return bar.liquidityUsd === null || !atLeast(bar.liquidityUsd, minSecondaryPoolLiquidityUsd);
}

export interface CleanBarsResult {
  bars: Bar[];
  flags: MetricFlag[];
}

/**
 * Section 3: clean the bars of one pool at one resolution. Rules apply in the
 * document's order: asOf, bad bar, implausible, duplicate, liquidity. The result is
 * sorted by `t`. The input array and its bars are not modified.
 */
export function cleanBars(
  bars: readonly Bar[],
  isPrimary: boolean,
  input: Pick<MetricInput, 'totalSupply' | 'asOf'>,
  params: Pick<MetricParams, 'maxMarketCapUsd' | 'minSecondaryPoolLiquidityUsd'>,
): CleanBarsResult {
  const flags = new Set<MetricFlag>();
  const lastByT = new Map<number, Bar>();
  for (const bar of bars) {
    if (bar.t > input.asOf) continue; // rule 1
    if (isBadBar(bar)) {
      flags.add('bad_bar'); // rule 2
      continue;
    }
    if (isImplausibleBar(bar, input.totalSupply, params.maxMarketCapUsd)) {
      flags.add('implausible_market_cap'); // rule 3
      continue;
    }
    if (lastByT.has(bar.t)) flags.add('duplicate_bar'); // rule 4: the last one wins
    lastByT.set(bar.t, bar);
  }
  const kept = [...lastByT.values()]
    .filter(
      (bar) => !isIlliquidSecondaryBar(bar, isPrimary, params.minSecondaryPoolLiquidityUsd), // rule 5
    )
    .sort((a, b) => a.t - b.t);
  return { bars: kept, flags: [...flags] };
}

export interface CleanPoolsResult {
  pools: CleanPool[];
  flags: MetricFlag[];
}

/** Section 3 applied to every pool and every resolution. */
export function cleanPools(
  pools: readonly PoolSeries[],
  input: Pick<MetricInput, 'totalSupply' | 'asOf'>,
  params: Pick<MetricParams, 'maxMarketCapUsd' | 'minSecondaryPoolLiquidityUsd'>,
): CleanPoolsResult {
  const flags = new Set<MetricFlag>();
  const clean = pools.map((pool): CleanPool => {
    const run = (bars: readonly Bar[]): Bar[] => {
      const result = cleanBars(bars, pool.isPrimary, input, params);
      for (const flag of result.flags) flags.add(flag);
      return result.bars;
    };
    return {
      address: pool.address,
      isPrimary: pool.isPrimary,
      bars1m: run(pool.bars1m),
      bars1h: run(pool.bars1h),
      bars1d: run(pool.bars1d),
    };
  });
  return { pools: clean, flags: [...flags] };
}
