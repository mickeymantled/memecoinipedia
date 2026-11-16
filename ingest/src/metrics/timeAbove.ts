import { atLeast, type LevelPoint } from './internal.js';

/**
 * Section 8: how long each level point holds. It holds until the next level point, and
 * the last one until `asOf`; each hold is capped at `carryForwardMaxSec` and is never
 * below zero. `series` must be sorted by `t`.
 */
export function holdSeconds(
  series: readonly LevelPoint[],
  asOf: number,
  carryForwardMaxSec: number,
): number[] {
  return series.map((p, i) => {
    const next = series[i + 1];
    const end = next === undefined ? asOf : next.t;
    return Math.max(0, Math.min(end - p.t, carryForwardMaxSec));
  });
}

/**
 * Section 8: for each threshold, the sum of the holds of the level points whose level
 * times `totalSupply` is at or above it. Same order as `thresholdsUsd`.
 */
export function secondsAbove(
  series: readonly LevelPoint[],
  thresholdsUsd: readonly number[],
  totalSupply: number,
  asOf: number,
  carryForwardMaxSec: number,
): number[] {
  const holds = holdSeconds(series, asOf, carryForwardMaxSec);
  return thresholdsUsd.map((threshold) =>
    series.reduce(
      (sum, p, i) => (atLeast(p.level * totalSupply, threshold) ? sum + (holds[i] as number) : sum),
      0,
    ),
  );
}
