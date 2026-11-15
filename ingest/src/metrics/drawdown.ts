import type { LevelPoint } from './internal.js';

/**
 * Section 9: the largest (peak so far - level) / peak so far over the level points in
 * order, as a percentage. Null when there are no level points.
 */
export function maxDrawdownPct(series: readonly LevelPoint[]): number | null {
  if (series.length === 0) return null;
  let peak = 0;
  let worst = 0;
  for (const p of series) {
    peak = Math.max(peak, p.level);
    worst = Math.max(worst, (peak - p.level) / peak);
  }
  return worst * 100;
}
