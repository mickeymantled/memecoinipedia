import type { CoinPoint, LevelPoint } from './internal.js';

/**
 * Section 7: walk the coin points in order of `t`. A strict point sets the level; a
 * point that is not strict can only lower it; before any strict point such points do
 * nothing. Every point at which the level is defined yields a level point.
 */
export function buildLevelSeries(points: readonly CoinPoint[]): LevelPoint[] {
  const ordered = [...points].sort((a, b) => a.t - b.t);
  const series: LevelPoint[] = [];
  let level: number | undefined;
  for (const p of ordered) {
    if (p.strict) {
      level = p.price;
    } else if (level !== undefined && p.price < level) {
      level = p.price;
    }
    if (level !== undefined) series.push({ t: p.t, level });
  }
  return series;
}
