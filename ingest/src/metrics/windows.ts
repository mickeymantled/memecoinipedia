import { atLeast, SECONDS, type CleanPool, type Window } from './internal.js';
import type { Bar, MetricParams } from './types.js';

type WindowParams = Pick<MetricParams, 'windowMinutes' | 'minWindowVolumeUsd' | 'minWindowTraders'>;

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
    return {
      t: bar.t,
      price: lowerMedian(inWindow.map((b) => b.c)),
      volume,
      traders,
      strict:
        inWindow.length >= 2 &&
        atLeast(volume, params.minWindowVolumeUsd) &&
        atLeast(traders, params.minWindowTraders),
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
): Window {
  return {
    t: bar.t,
    price: bar.c,
    volume: bar.volumeUsd,
    traders: bar.traders,
    strict:
      atLeast(bar.volumeUsd, params.minWindowVolumeUsd) &&
      atLeast(bar.traders, params.minWindowTraders),
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

/** Section 4: every window of every pool, at every resolution. Unordered. */
export function buildWindows(pools: readonly CleanPool[], params: WindowParams): Window[] {
  const windows: Window[] = [];
  for (const pool of pools) {
    windows.push(...minuteWindows(pool.bars1m, pool, params));
    for (const bar of pool.bars1h) {
      if (hourlyBarIsUsed(pools, bar)) windows.push(coarseWindow(bar, pool, '1h', params));
    }
    for (const bar of pool.bars1d) {
      if (dailyBarIsUsed(pools, bar)) windows.push(coarseWindow(bar, pool, '1d', params));
    }
  }
  return windows;
}
