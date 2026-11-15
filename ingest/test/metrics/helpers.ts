import type { Bar, MetricInput, MetricResult, PoolSeries } from '../../src/metrics/types.js';

/** 2023-11-14 00:00 UTC, a multiple of 86,400. */
export const DAY = 1_699_920_000;
/** 10:00 UTC on DAY, a multiple of 3,600. */
export const M0 = DAY + 36_000;

/** A 1-minute-style bar whose four prices are all `c`, with volume and traders that pass the strict rule. */
export function bar(t: number, c: number, over: Partial<Bar> = {}): Bar {
  return {
    t,
    o: c,
    h: c,
    l: c,
    c,
    volumeUsd: 1_000,
    trades: 3,
    traders: 5,
    liquidityUsd: null,
    ...over,
  };
}

/** Consecutive 1-minute bars starting at `t0`, one per close. */
export function minuteBars(t0: number, closes: number[], over: Partial<Bar> = {}): Bar[] {
  return closes.map((c, i) => bar(t0 + i * 60, c, over));
}

export function pool(over: Partial<PoolSeries> = {}): PoolSeries {
  return {
    address: 'P',
    dex: 'pump',
    isPrimary: true,
    bars1m: [],
    bars1h: [],
    bars1d: [],
    ...over,
  };
}

export function input(pools: PoolSeries[], over: Partial<MetricInput> = {}): MetricInput {
  return { totalSupply: 1_000_000_000, launchedAt: M0 - 600, asOf: M0 + 3_600, pools, ...over };
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** A small seeded generator (mulberry32). Returns numbers in [0, 1). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** A result as rules version 5 reported it: without `athNearVolumeUsd` and the flag `ath_thinly_traded`. */
export function withoutVersion6Additions(
  result: MetricResult,
): Omit<MetricResult, 'athNearVolumeUsd'> {
  const rest: Partial<MetricResult> = { ...result };
  delete rest.athNearVolumeUsd;
  return {
    ...(rest as Omit<MetricResult, 'athNearVolumeUsd'>),
    flags: result.flags.filter((f) => f !== 'ath_thinly_traded'),
  };
}
