import {
  atLeast,
  barPeak,
  isFunded,
  maxLiquidity,
  SECONDS,
  type CleanPool,
  type Window,
} from './internal.js';
import type { Bar, MetricParams } from './types.js';

type WindowParams = Pick<
  MetricParams,
  'windowMinutes' | 'minWindowVolumeUsd' | 'minWindowTraders' | 'minWindowLiquidityUsd'
>;

/** Section 4: the lower median. 3 values: the middle. 2 values: the lower. 1: itself. */
export function lowerMedian(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] as number;
}

/**
 * Section 4, 1-minute bars: one window per clean bar, made of that pool's clean bars
 * in the `windowMinutes` minutes ending at the bar. `bars` must be sorted by `t`.
 */
export function minuteWindows(
  bars: readonly Bar[],
  pool: Pick<CleanPool, 'address' | 'isPrimary'>,
  params: WindowParams,
): Window[] {
  const span = (params.windowMinutes - 1) * SECONDS['1m'];
  return bars.map((bar, i): Window => {
    const inWindow: Bar[] = [];
    for (let j = i; j >= 0; j--) {
      const earlier = bars[j] as Bar;
      if (earlier.t < bar.t - span) break;
      inWindow.push(earlier);
    }
    const volume = inWindow.reduce((sum, b) => sum + b.volumeUsd, 0);
    const traders = Math.max(...inWindow.map((b) => b.traders));
    const price = lowerMedian(inWindow.map((b) => b.c));
    const liquidity = maxLiquidity(inWindow);
    return {
      t: bar.t,
      price,
      high: price,
      volume,
      traders,
      strict:
        inWindow.length >= 2 &&
        atLeast(volume, params.minWindowVolumeUsd) &&
        atLeast(traders, params.minWindowTraders) &&
        isFunded(liquidity, params.minWindowLiquidityUsd),
      liquidity,
      poolAddress: pool.address,
      isPrimary: pool.isPrimary,
      resolution: '1m',
    };
  });
}

/** Section 4, hourly and daily bars: each bar is its own window. */
export function coarseWindow(
  bar: Bar,
  pool: Pick<CleanPool, 'address' | 'isPrimary'>,
  resolution: '1h' | '1d',
  params: WindowParams,
  previous?: Bar,
): Window {
  const liquidity = maxLiquidity([bar, previous]);
  return {
    t: bar.t,
    price: bar.c,
    high: barPeak(bar),
    volume: bar.volumeUsd,
    traders: bar.traders,
    strict:
      atLeast(bar.volumeUsd, params.minWindowVolumeUsd) &&
      atLeast(bar.traders, params.minWindowTraders) &&
      isFunded(liquidity, params.minWindowLiquidityUsd),
    liquidity,
    poolAddress: pool.address,
    isPrimary: pool.isPrimary,
    resolution,
  };
}

/** True when some clean bar, in any pool, starts inside [start, start + length). */
function anyBarInside(
  pools: readonly CleanPool[],
  key: 'bars1m' | 'bars1h',
  start: number,
  length: number,
): boolean {
  return pools.some((pool) => pool[key].some((bar) => bar.t >= start && bar.t < start + length));
}

/**
 * Section 4, "finer data wins": an hourly bar is not a window when any pool has a
 * clean 1-minute bar inside that hour.
 */
export function hourlyBarIsUsed(pools: readonly CleanPool[], bar: Bar): boolean {
  return !anyBarInside(pools, 'bars1m', bar.t, SECONDS['1h']);
}

/**
 * Section 4, "finer data wins": a daily bar is not a window when any pool has a
 * clean 1-minute or hourly bar inside that day.
 */
export function dailyBarIsUsed(pools: readonly CleanPool[], bar: Bar): boolean {
  return (
    !anyBarInside(pools, 'bars1m', bar.t, SECONDS['1d']) &&
    !anyBarInside(pools, 'bars1h', bar.t, SECONDS['1d'])
  );
}

export type BarPredicate = (bar: Bar) => boolean;

/** Section 4: every window, given which hourly and daily bars are used. Unordered. */
function windowsFor(
  pools: readonly CleanPool[],
  params: WindowParams,
  hourlyUsed: BarPredicate,
  dailyUsed: BarPredicate,
): Window[] {
  const windows: Window[] = [];
  for (const pool of pools) {
    windows.push(...minuteWindows(pool.bars1m, pool, params));
    pool.bars1h.forEach((bar, i) => {
      if (hourlyUsed(bar)) windows.push(coarseWindow(bar, pool, '1h', params, pool.bars1h[i - 1]));
    });
    pool.bars1d.forEach((bar, i) => {
      if (dailyUsed(bar)) windows.push(coarseWindow(bar, pool, '1d', params, pool.bars1d[i - 1]));
    });
  }
  return windows;
}

/** True when the ascending array holds a value in [start, end). Binary search. */
function anyInRange(sorted: readonly number[], start: number, end: number): boolean {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((sorted[mid] as number) < start) lo = mid + 1;
    else hi = mid;
  }
  return lo < sorted.length && (sorted[lo] as number) < end;
}

const sortedTimes = (pools: readonly CleanPool[], key: 'bars1m' | 'bars1h'): number[] =>
  pools.flatMap((pool) => pool[key].map((bar) => bar.t)).sort((a, b) => a - b);

/**
 * Section 4, "finer data wins": which hourly and daily bars are used as windows. The
 * lookups are built once (sorted times, binary search), so each check is log n. Every
 * reader of that rule goes through here, so there is one version of it.
 */
export function usedBarChecks(pools: readonly CleanPool[]): {
  hourlyUsed: BarPredicate;
  dailyUsed: BarPredicate;
} {
  const minutes = sortedTimes(pools, 'bars1m');
  const hours = sortedTimes(pools, 'bars1h');
  return {
    hourlyUsed: (bar) => !anyInRange(minutes, bar.t, bar.t + SECONDS['1h']),
    dailyUsed: (bar) =>
      !anyInRange(minutes, bar.t, bar.t + SECONDS['1d']) &&
      !anyInRange(hours, bar.t, bar.t + SECONDS['1d']),
  };
}

/**
 * Section 4: every window of every pool, at every resolution. Unordered. The "finer
 * data wins" lookups are built once per call (`usedBarChecks`), so the cost is n log n
 * in the bar count. Same result as `buildWindowsByScanning`.
 */
export function buildWindows(pools: readonly CleanPool[], params: WindowParams): Window[] {
  const { hourlyUsed, dailyUsed } = usedBarChecks(pools);
  return windowsFor(pools, params, hourlyUsed, dailyUsed);
}

/** The direct, slow reading of the rules, kept to prove `buildWindows` is equivalent. */
export function buildWindowsByScanning(
  pools: readonly CleanPool[],
  params: WindowParams,
): Window[] {
  return windowsFor(
    pools,
    params,
    (bar) => hourlyBarIsUsed(pools, bar),
    (bar) => dailyBarIsUsed(pools, bar),
  );
}
