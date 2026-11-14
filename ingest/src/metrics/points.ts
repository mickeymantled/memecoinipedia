import { compareStrings, type CoinPoint, type Window } from './internal.js';

/**
 * Section 5 ordering: the window with the larger volume is better; on a tie a primary
 * pool is better; on a further tie the smaller address is better. Negative when `a`
 * is better.
 */
export function compareWindows(a: Window, b: Window): number {
  if (a.volume !== b.volume) return b.volume - a.volume;
  if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
  return compareStrings(a.poolAddress, b.poolAddress);
}

/** Section 5: one coin point per timestamp, sorted by `t`. */
export function buildCoinPoints(windows: readonly Window[]): CoinPoint[] {
  const best = new Map<number, Window>();
  for (const window of windows) {
    const current = best.get(window.t);
    if (current === undefined || compareWindows(window, current) < 0) best.set(window.t, window);
  }
  return [...best.values()]
    .sort((a, b) => a.t - b.t)
    .map((w) => ({
      t: w.t,
      price: w.price,
      strict: w.strict,
      poolAddress: w.poolAddress,
      resolution: w.resolution,
    }));
}
