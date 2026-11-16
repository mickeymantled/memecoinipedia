import { computeAth } from '../metrics/ath.js';
import { cleanPools } from '../metrics/clean.js';
import { buildCoinPoints } from '../metrics/points.js';
import { buildWindows } from '../metrics/windows.js';
import { mergeParams } from '../metrics/index.js';
import type { MetricInput, MetricParams } from '../metrics/types.js';
import type { PeakTarget } from './plan.js';

/**
 * The periods `peak_outside_minute_coverage` points at: every strict hourly or
 * daily coin point (docs/metrics.md section 6) whose high is above the ATH
 * price, or any such point when the ATH is null. Highest high first; on a tie
 * the earlier bucket, then the smaller pool address.
 *
 * Runs the same steps as `computeCoinMetrics` up to the coin points, so it
 * names exactly the points that raise the flag.
 */
export function findCoveragePeaks(
  input: MetricInput,
  params?: Partial<MetricParams>,
): PeakTarget[] {
  const merged = mergeParams(params);
  const cleaned = cleanPools(input.pools, input, merged);
  const points = buildCoinPoints(buildWindows(cleaned.pools, merged));
  const ath = computeAth(points, input.launchedAt, input.totalSupply);
  return points
    .filter(
      (p) => p.strict && p.resolution !== '1m' && (ath.athPrice === null || p.high > ath.athPrice),
    )
    .sort(
      (a, b) =>
        b.high - a.high ||
        a.t - b.t ||
        (a.poolAddress < b.poolAddress ? -1 : a.poolAddress > b.poolAddress ? 1 : 0),
    )
    .map((p) => ({
      poolAddress: p.poolAddress,
      t: p.t,
      resolution: p.resolution === '1h' ? 3600 : 86400,
      highUsd: p.high * input.totalSupply,
    }));
}
