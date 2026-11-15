import { atLeast, type CleanPool } from './internal.js';
import type { MetricParams } from './types.js';
import { usedBarChecks } from './windows.js';

/** A bar that `V(L)` (docs/metrics.md section 6) is made of: its close and its volume. */
export interface CountedBar {
  close: number;
  volume: number;
}

/**
 * Section 6: the bars `athNearVolumeUsd` and the backed high are made of, collected once:
 * every clean 1-minute bar of every pool that counts, and a clean hourly or daily bar only
 * when "finer data wins" keeps it as a window, decided by the same checks `buildWindows`
 * uses (`usedBarChecks`). Taken from clean bars, before one point per timestamp is chosen,
 * so every pool is included.
 */
export function countedBars(pools: readonly CleanPool[]): CountedBar[] {
  const { hourlyUsed, dailyUsed } = usedBarChecks(pools);
  const out: CountedBar[] = [];
  for (const pool of pools) {
    for (const bar of pool.bars1m) out.push({ close: bar.c, volume: bar.volumeUsd });
    for (const bar of pool.bars1h) {
      if (hourlyUsed(bar)) out.push({ close: bar.c, volume: bar.volumeUsd });
    }
    for (const bar of pool.bars1d) {
      if (dailyUsed(bar)) out.push({ close: bar.c, volume: bar.volumeUsd });
    }
  }
  return out;
}

/**
 * `V` at a price, straight from the definition: the volume of the counted bars whose close is
 * at least `nearAthFraction` times `price`. Slow and simple; `nearAth` is checked against it.
 */
export function volumeNear(
  counted: readonly CountedBar[],
  price: number,
  nearAthFraction: number,
): number {
  const limit = nearAthFraction * price;
  let sum = 0;
  for (const bar of counted) if (atLeast(bar.close, limit)) sum += bar.volume;
  return sum;
}

export interface NearAthResult {
  /** `V(athMarketCapUsd)`, or null without an ATH. */
  athNearVolumeUsd: number | null;
  /** Section 6: the largest backed market cap no larger than the ATH, or null without an ATH. */
  athBackedMarketCapUsd: number | null;
  /** Section 6, flag `ath_thinly_traded`: the near volume is below the line. */
  thinlyTraded: boolean;
}

/**
 * Section 6, `athNearVolumeUsd`, the flag `ath_thinly_traded` and `athBackedMarketCapUsd`, from
 * one list of counted bars: one pass to sort, one pass to scan. The bars are sorted by close,
 * highest first; bars with an equal close form a group, taken together; the volume of a group
 * is added in ascending order so the sums do not depend on the order of the input. After each
 * group, `V_i` is the volume of every bar at or above its close.
 *
 * - The near volume is the `V_i` of the last group whose close is at least
 *   `nearAthFraction` times the ATH price (the usual tolerance), which is `V(ATH)` itself.
 * - The flag is decided once: the near volume is not at least `minAthNearVolumeShare` times
 *   the ATH market cap (the usual tolerance).
 * - Not flagged: the backed high is the ATH market cap, the same number. Flagged: the largest
 *   candidate, the smaller of `cap_i / nearAthFraction` and `V_i / minAthNearVolumeShare`,
 *   capped at the ATH. Flagged means a share above 0, so the division is safe, and every
 *   candidate is below the ATH: a group counted at the ATH has `V_i` no larger than the near
 *   volume, which is below the line by more than the tolerance; any other group has a close
 *   below `nearAthFraction` times the ATH price by more than the tolerance.
 *
 * `counted` is sorted in place.
 */
export function nearAth(
  counted: CountedBar[],
  athPrice: number | null,
  athMarketCapUsd: number | null,
  totalSupply: number,
  params: Pick<MetricParams, 'nearAthFraction' | 'minAthNearVolumeShare'>,
): NearAthResult {
  if (athPrice === null || athMarketCapUsd === null) {
    return { athNearVolumeUsd: null, athBackedMarketCapUsd: null, thinlyTraded: false };
  }
  const { nearAthFraction: fraction, minAthNearVolumeShare: share } = params;
  counted.sort((a, b) => b.close - a.close || a.volume - b.volume);
  const limit = fraction * athPrice;

  let volume = 0; // V_i
  let near = 0; // V at the ATH
  let best = 0; // the largest candidate
  let i = 0;
  while (i < counted.length) {
    const close = (counted[i] as CountedBar).close;
    let j = i;
    while (j < counted.length && (counted[j] as CountedBar).close === close) {
      volume += (counted[j] as CountedBar).volume;
      j++;
    }
    i = j;
    if (atLeast(close, limit)) near = volume;
    if (share > 0) {
      const candidate = Math.min((close * totalSupply) / fraction, volume / share);
      if (candidate > best) best = candidate;
    }
  }

  const thinlyTraded = !atLeast(near, share * athMarketCapUsd);
  return {
    athNearVolumeUsd: near,
    athBackedMarketCapUsd: thinlyTraded ? Math.min(best, athMarketCapUsd) : athMarketCapUsd,
    thinlyTraded,
  };
}
