/**
 * The backed high (docs/metrics.md section 6): properties over generated inputs, the exact
 * agreement with the flag, a brute-force check of the "largest market cap" claim, and the edges.
 */
import { describe, expect, it } from 'vitest';
import { computeCoinMetrics } from '../../src/metrics/index.js';
import { countedBars, nearAth, volumeNear, type CountedBar } from '../../src/metrics/athNear.js';
import { cleanPools } from '../../src/metrics/clean.js';
import {
  DEFAULT_METRIC_PARAMS,
  type Bar,
  type MetricInput,
  type MetricParams,
} from '../../src/metrics/types.js';
import { seededRandom } from './helpers.js';

const THINLY = 'ath_thinly_traded';
const SUPPLY = 1_000_000_000;
const CASES = 400;
const T0 = 1_699_920_000;

/** Few distinct closes, so equal closes are common; volumes are whole numbers, so sums are exact. */
function generateInput(seed: number): MetricInput {
  const rnd = seededRandom(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const prices = [0.0003, 0.001, 0.0021, 0.01, 0.05, 0.1, 0.2];
  const pools = Array.from({ length: int(1, 3) }, (_, p) => {
    const bar = (t: number, price: number): Bar => ({
      t,
      o: price,
      h: price,
      l: price,
      c: price,
      volumeUsd: [0, 300, 700, 1_500, 40_000, 2_000_000][int(0, 5)] as number,
      trades: 5,
      traders: int(4, 9),
      liquidityUsd: p === 0 ? null : 20_000,
    });
    const minutes = new Set<number>();
    for (let i = 0; i < int(3, 40); i++) minutes.add(int(0, 90));
    const hours = new Set<number>();
    for (let i = 0; i < int(0, 3); i++) hours.add(int(0, 3));
    return {
      address: `pool-${p}`,
      dex: 'test',
      isPrimary: p === 0,
      bars1m: [...minutes].map((m) =>
        bar(T0 + m * 60, prices[int(0, prices.length - 1)] as number),
      ),
      bars1h: [...hours].map((h) =>
        bar(T0 + h * 3_600, prices[int(0, prices.length - 1)] as number),
      ),
      bars1d: rnd() < 0.3 ? [bar(T0, prices[int(0, prices.length - 1)] as number)] : [],
    };
  });
  return { totalSupply: SUPPLY, launchedAt: T0, asOf: T0 + 5 * 3_600, pools };
}

const inputs = Array.from({ length: CASES }, (_, i) => generateInput(i + 1));
const withAth = inputs.filter((i) => computeCoinMetrics(i).athMarketCapUsd !== null);

const shuffled = <T>(items: readonly T[], rnd: () => number): T[] => {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
};

const doubled = (input: MetricInput): MetricInput => ({
  ...input,
  pools: input.pools.map((p) => ({
    ...p,
    bars1m: p.bars1m.map((b) => ({ ...b, volumeUsd: b.volumeUsd * 2 })),
    bars1h: p.bars1h.map((b) => ({ ...b, volumeUsd: b.volumeUsd * 2 })),
    bars1d: p.bars1d.map((b) => ({ ...b, volumeUsd: b.volumeUsd * 2 })),
  })),
});

describe('the backed high over generated inputs', () => {
  it('generates enough coins with an ATH, some thin and some not', () => {
    expect(withAth.length).toBeGreaterThan(CASES / 3);
    const thin = withAth.filter((i) => computeCoinMetrics(i).flags.includes(THINLY));
    expect(thin.length).toBeGreaterThan(10);
    expect(thin.length).toBeLessThan(withAth.length - 10);
  });

  it('is null with the ATH, never above it, and the ATH itself exactly when the flag is not raised', () => {
    for (const input of inputs) {
      const r = computeCoinMetrics(input);
      if (r.athMarketCapUsd === null) {
        expect(r.athBackedMarketCapUsd).toBeNull();
        expect(r.athNearVolumeUsd).toBeNull();
        expect(r.flags).not.toContain(THINLY);
        continue;
      }
      const backed = r.athBackedMarketCapUsd as number;
      expect(backed).toBeLessThanOrEqual(r.athMarketCapUsd);
      expect(backed >= 0).toBe(true);
      const flagged = r.flags.includes(THINLY);
      expect(backed === r.athMarketCapUsd).toBe(!flagged);
      expect(backed < r.athMarketCapUsd).toBe(flagged);
    }
  });

  it('never rises when the share rises', () => {
    const shares = [0, 0.01, 0.05, 0.2, 0.5, 1, 3];
    for (const input of withAth) {
      let last = Number.POSITIVE_INFINITY;
      for (const share of shares) {
        const r = computeCoinMetrics(input, { minAthNearVolumeShare: share });
        expect(r.athBackedMarketCapUsd as number).toBeLessThanOrEqual(last);
        last = r.athBackedMarketCapUsd as number;
      }
    }
  });

  it('never falls when every bar volume is doubled', () => {
    for (const input of withAth) {
      const before = computeCoinMetrics(input);
      const after = computeCoinMetrics(doubled(input));
      // Doubling a volume can lift a window over the strict line and change the ATH itself, so
      // compare only where the ATH is the same.
      if (after.athMarketCapUsd !== before.athMarketCapUsd) continue;
      expect(after.athBackedMarketCapUsd as number).toBeGreaterThanOrEqual(
        before.athBackedMarketCapUsd as number,
      );
    }
  });

  it('is unchanged, to the bit, by the order of pools and bars', () => {
    const rnd = seededRandom(99);
    for (const input of withAth) {
      const mixed: MetricInput = {
        ...input,
        pools: shuffled(input.pools, rnd).map((p) => ({
          ...p,
          bars1m: shuffled(p.bars1m, rnd),
          bars1h: shuffled(p.bars1h, rnd),
          bars1d: shuffled(p.bars1d, rnd),
        })),
      };
      const a = computeCoinMetrics(input);
      const b = computeCoinMetrics(mixed);
      expect(b.athBackedMarketCapUsd).toBe(a.athBackedMarketCapUsd);
      expect(b.athNearVolumeUsd).toBe(a.athNearVolumeUsd);
      expect(b.flags).toEqual(a.flags);
    }
  });

  it('athNearVolumeUsd is V(athMarketCapUsd), from the same bars', () => {
    for (const input of withAth) {
      const r = computeCoinMetrics(input);
      const cleaned = cleanPools(input.pools, input, DEFAULT_METRIC_PARAMS);
      const counted = countedBars(cleaned.pools);
      const athPrice = (r.athMarketCapUsd as number) / input.totalSupply;
      expect(r.athNearVolumeUsd).toBe(
        volumeNear(counted, athPrice, DEFAULT_METRIC_PARAMS.nearAthFraction),
      );
    }
  });
});

/** Random counted bars with whole-number closes and volumes; the ATH is the highest close. */
function randomBars(seed: number): { bars: CountedBar[]; athPrice: number } {
  const rnd = seededRandom(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const closes = [10, 20, 20, 35, 50, 80, 100, 100, 160, 400];
  const bars = Array.from({ length: int(1, 14) }, () => ({
    close: closes[int(0, closes.length - 1)] as number,
    volume: int(0, 12) * 25,
  }));
  return { bars, athPrice: Math.max(...bars.map((b) => b.close)) };
}

const PARAMS = (share: number, fraction = 0.5) => ({
  nearAthFraction: fraction,
  minAthNearVolumeShare: share,
});

describe('the backed high is the largest market cap with enough volume behind it', () => {
  it('matches a brute-force check of the definition', () => {
    const feasible = (bars: CountedBar[], level: number, share: number, fraction: number) =>
      bars.reduce((sum, b) => (b.close >= (fraction * level) / 1 ? sum + b.volume : sum), 0) >=
      share * level;
    for (let seed = 1; seed <= 600; seed++) {
      for (const share of [0.1, 0.2, 0.5, 1]) {
        for (const fraction of [0.5, 0.8, 1]) {
          const { bars, athPrice } = randomBars(seed);
          // Market cap = close, so totalSupply is 1 here.
          const r = nearAth([...bars], athPrice, athPrice, 1, PARAMS(share, fraction));
          const backed = r.athBackedMarketCapUsd as number;
          expect(backed).toBeLessThanOrEqual(athPrice);
          if (backed === athPrice) {
            expect(r.thinlyTraded).toBe(false);
            continue;
          }
          expect(r.thinlyTraded).toBe(true);
          if (backed > 0) expect(feasible(bars, backed * (1 - 1e-9), share, fraction)).toBe(true);
          // Anything larger, up to the ATH, is not backed.
          for (const k of [1 + 1e-9, 1.01, 1.5]) {
            const level = Math.min(backed * k, athPrice);
            if (level > backed) expect(feasible(bars, level, share, fraction)).toBe(false);
          }
          expect(feasible(bars, athPrice, share, fraction)).toBe(false);
        }
      }
    }
  });

  it('agrees with the flag on the line, inside and outside the tolerance', () => {
    const athPrice = 200;
    for (const share of [0.05, 0.2, 0.3, 1]) {
      for (const delta of [-1e-9, -1e-11, -1e-13, -1e-15, 0, 1e-15, 1e-13, 1e-9]) {
        const total = share * athPrice * (1 + delta);
        // Two bars at the ATH close, one below half of it that adds nothing to V(ATH).
        const bars: CountedBar[] = [
          { close: athPrice, volume: total / 2 },
          { close: athPrice, volume: total / 2 },
          { close: athPrice / 4, volume: 7 },
        ];
        const r = nearAth(bars, athPrice, athPrice, 1, PARAMS(share));
        const backed = r.athBackedMarketCapUsd as number;
        expect(backed < athPrice).toBe(r.thinlyTraded);
        expect(backed === athPrice).toBe(!r.thinlyTraded);
        if (delta <= -1e-11) expect(r.thinlyTraded).toBe(true);
        if (delta >= 0) expect(r.thinlyTraded).toBe(false);
      }
    }
  });

  it('with a share of 0 is the ATH and never divides by zero', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const { bars, athPrice } = randomBars(seed);
      const r = nearAth([...bars], athPrice, athPrice, 1, PARAMS(0));
      expect(r.athBackedMarketCapUsd).toBe(athPrice);
      expect(r.thinlyTraded).toBe(false);
    }
  });

  it('with no volume at all and a share above 0 is 0', () => {
    const bars: CountedBar[] = [
      { close: 100, volume: 0 },
      { close: 60, volume: 0 },
    ];
    const r = nearAth(bars, 100, 100, 1, PARAMS(0.2));
    expect(r).toEqual({ athNearVolumeUsd: 0, athBackedMarketCapUsd: 0, thinlyTraded: true });
  });

  it('is null without an ATH', () => {
    expect(nearAth([{ close: 1, volume: 5 }], null, null, 1, PARAMS(0.2))).toEqual({
      athNearVolumeUsd: null,
      athBackedMarketCapUsd: null,
      thinlyTraded: false,
    });
  });

  it('takes bars with an equal close together, however they are ordered', () => {
    // Market cap = close (supply 1). The ATH bar holds 10 USD; four bars share the close 1,000,000
    // (9,000 USD); a low bar closes at 1,000. The tied group is one group: V = 10 + 9,000 and the
    // candidate is 9,010 / .2 = 45,050. Counting only one of the tied bars gives 15,050 or less.
    const bars: CountedBar[] = [
      { close: 10_000_000, volume: 10 },
      { close: 1_000_000, volume: 3_000 },
      { close: 1_000_000, volume: 3_000 },
      { close: 1_000_000, volume: 2_000 },
      { close: 1_000_000, volume: 1_000 },
      { close: 1_000, volume: 500 },
    ];
    const a = nearAth([...bars], 10_000_000, 10_000_000, 1, PARAMS(0.2));
    const b = nearAth([...bars].reverse(), 10_000_000, 10_000_000, 1, PARAMS(0.2));
    expect(a).toEqual(b);
    expect(a.thinlyTraded).toBe(true);
    expect(a.athBackedMarketCapUsd).toBeCloseTo(45_050, 6);
  });
});

describe('parameters', () => {
  it('the default share is 0.2 and there is no second share', () => {
    expect(DEFAULT_METRIC_PARAMS.minAthNearVolumeShare).toBe(0.2);
    const keys: (keyof MetricParams)[] = Object.keys(
      DEFAULT_METRIC_PARAMS,
    ) as (keyof MetricParams)[];
    expect(keys.filter((k) => /share/i.test(k))).toEqual(['minAthNearVolumeShare']);
  });
});
