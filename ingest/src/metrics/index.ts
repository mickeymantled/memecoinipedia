import { computeAth, computeWick, peakOutsideMinuteCoverage } from './ath.js';
import { cleanPools } from './clean.js';
import { maxDrawdownPct } from './drawdown.js';
import { buildLevelSeries } from './level.js';
import { buildCoinPoints } from './points.js';
import { rugPattern } from './rug.js';
import { secondsAbove } from './timeAbove.js';
import { buildWindows } from './windows.js';
import {
  DEFAULT_METRIC_PARAMS,
  type ComputeCoinMetrics,
  type MetricFlag,
  type MetricInput,
  type MetricParams,
  type MetricResult,
} from './types.js';

export * from './types.js';

/** Partial parameters merged over the defaults; keys set to undefined keep the default. */
export function mergeParams(params?: Partial<MetricParams>): MetricParams {
  const merged: Record<string, unknown> = { ...DEFAULT_METRIC_PARAMS };
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined) merged[key] = value;
  }
  const result = merged as unknown as MetricParams;
  // Section 2: windowMinutes must be 2 or more, and a whole number of minutes.
  if (!Number.isInteger(result.windowMinutes) || result.windowMinutes < 2) {
    throw new RangeError(
      `windowMinutes must be an integer of 2 or more, got ${result.windowMinutes}`,
    );
  }
  return result;
}

/**
 * The price metrics of one coin, computed exactly as docs/metrics.md describes. Pure:
 * no I/O, no clock, and the input is never modified.
 */
export const computeCoinMetrics: ComputeCoinMetrics = (
  input: MetricInput,
  partial?: Partial<MetricParams>,
): MetricResult => {
  const params = mergeParams(partial);
  const flags = new Set<MetricFlag>();

  // Section 3: clean the bars.
  const cleaned = cleanPools(input.pools, input, params);
  cleaned.flags.forEach((f) => flags.add(f));

  // Sections 4 and 5: windows, then one point per timestamp.
  const windows = buildWindows(cleaned.pools, params);
  const points = buildCoinPoints(windows);

  // Section 6: ATH and wick.
  const ath = computeAth(points, input.launchedAt, input.totalSupply);
  ath.flags.forEach((f) => flags.add(f));
  const wick = computeWick(cleaned.pools, input.totalSupply);
  if (peakOutsideMinuteCoverage(points, ath.athPrice)) flags.add('peak_outside_minute_coverage');

  // Sections 7 to 10: level series, time above, drawdown, rug pattern.
  const series = buildLevelSeries(points);

  return {
    ...ath.fields,
    ...wick,
    secondsAbove: secondsAbove(
      series,
      params.thresholdsUsd,
      input.totalSupply,
      input.asOf,
      params.carryForwardMaxSec,
    ),
    maxDrawdownPct: maxDrawdownPct(series),
    rugPattern: rugPattern(
      { athAt: ath.fields.athAt, athPrice: ath.athPrice },
      series,
      points,
      params,
    ),
    flags: [...flags].sort(),
  };
};
