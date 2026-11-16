import { atLeast, type CleanPool } from './internal.js';
import type { MetricParams } from './types.js';
import { usedBarChecks } from './windows.js';

/**
 * Section 6, `athNearVolumeUsd`: the `volumeUsd` of the clean bars of every pool whose
 * close is at or above `nearAthFraction` times the ATH price, each stretch of time
 * counted once at the finest resolution held. Every clean 1-minute bar counts; an
 * hourly or daily bar counts only when "finer data wins" keeps it as a window, decided
 * by the same checks `buildWindows` uses. A bar is judged on its own close. Taken from
 * clean bars, before one point per timestamp is chosen, so every pool is summed.
 * Null when the ATH is null.
 */
export function athNearVolume(
  pools: readonly CleanPool[],
  athPrice: number | null,
  params: Pick<MetricParams, 'nearAthFraction'>,
): number | null {
  if (athPrice === null) return null;
  const limit = params.nearAthFraction * athPrice;
  const { hourlyUsed, dailyUsed } = usedBarChecks(pools);
  let sum = 0;
  for (const pool of pools) {
    for (const bar of pool.bars1m) if (atLeast(bar.c, limit)) sum += bar.volumeUsd;
    for (const bar of pool.bars1h)
      if (hourlyUsed(bar) && atLeast(bar.c, limit)) sum += bar.volumeUsd;
    for (const bar of pool.bars1d)
      if (dailyUsed(bar) && atLeast(bar.c, limit)) sum += bar.volumeUsd;
  }
  return sum;
}

/**
 * Section 6, flag `ath_thinly_traded`: the ATH is not null and the near-ATH volume is
 * strictly below `minAthNearVolumeShare` times the ATH market cap. A volume equal to
 * that product within the usual tolerance is not below it.
 */
export function athThinlyTraded(
  athNearVolumeUsd: number | null,
  athMarketCapUsd: number | null,
  params: Pick<MetricParams, 'minAthNearVolumeShare'>,
): boolean {
  if (athNearVolumeUsd === null || athMarketCapUsd === null) return false;
  return !atLeast(athNearVolumeUsd, params.minAthNearVolumeShare * athMarketCapUsd);
}
