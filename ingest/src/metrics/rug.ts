import { atLeast, atMost, type CoinPoint, type LevelPoint } from './internal.js';
import type { MetricParams } from './types.js';

type RugParams = Pick<MetricParams, 'rugDropPct' | 'rugWithinSec' | 'rugRecoveryFraction'>;

/**
 * Section 10, condition 2: the earliest level point after `athAt` and no later than
 * `athAt + rugWithinSec` whose level is at or below (1 - rugDropPct / 100) of the ATH
 * price. Null when there is none.
 */
export function findCrashPoint(
  series: readonly LevelPoint[],
  athAt: number,
  athPrice: number,
  params: RugParams,
): LevelPoint | null {
  const limit = (1 - params.rugDropPct / 100) * athPrice;
  const crash = series
    .filter((p) => p.t > athAt && p.t <= athAt + params.rugWithinSec && atMost(p.level, limit))
    .sort((a, b) => a.t - b.t)[0];
  return crash ?? null;
}

/**
 * Section 10: true when the ATH exists, a crash point exists, and no strict coin point
 * after the crash point, at any resolution, recovers to the recovery fraction of ATH.
 */
export function rugPattern(
  ath: { athAt: number | null; athPrice: number | null },
  series: readonly LevelPoint[],
  points: readonly CoinPoint[],
  params: RugParams,
): boolean {
  if (ath.athAt === null || ath.athPrice === null) return false; // condition 1
  const crash = findCrashPoint(series, ath.athAt, ath.athPrice, params);
  if (crash === null) return false;
  const recoveryPrice = params.rugRecoveryFraction * ath.athPrice;
  const recovered = points.some(
    (p) => p.strict && p.t > crash.t && atLeast(p.price, recoveryPrice), // condition 3
  );
  return !recovered;
}
