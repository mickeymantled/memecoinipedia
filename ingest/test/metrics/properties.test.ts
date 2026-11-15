import { describe, expect, it } from 'vitest';
import { computeCoinMetrics } from '../../src/metrics/index.js';
import type { Bar, MetricInput, PoolSeries } from '../../src/metrics/types.js';
import { deepFreeze, seededRandom } from './helpers.js';

const CASES = 300;
const DAY = 86_400;

interface GenOptions {
  /** Allow two bars with the same t in one pool and resolution (their order then matters). */
  allowDuplicates: boolean;
}

function generateInput(seed: number, { allowDuplicates }: GenOptions): MetricInput {
  const rnd = seededRandom(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const pick = <T>(items: T[]): T => items[int(0, items.length - 1)] as T;

  const launchedAt = 1_700_000_040 + int(0, 1_000) * 60;
  const asOf = launchedAt + int(1, 4 * 24 * 60) * 60;
  const poolCount = int(1, 3);
  const pools: PoolSeries[] = [];

  for (let p = 0; p < poolCount; p++) {
    const isPrimary = p === 0 ? rnd() < 0.8 : rnd() < 0.3;
    const makeBar = (t: number, price: number): Bar => {
      const spread = () => price * (1 + rnd() * 0.3);
      const bar: Bar = {
        t,
        o: price,
        h: spread(),
        l: price * (1 - rnd() * 0.2),
        c: price * (0.8 + rnd() * 0.4),
        volumeUsd: pick([0, 20, 300, 700, 1_500, 4_000]),
        trades: int(1, 20),
        traders: int(0, 9),
        liquidityUsd: pick([null, 100, 4_999, 5_000, 20_000]),
      };
      const roll = rnd();
      if (roll < 0.02) bar.o = pick([0, -1, Number.NaN, Number.POSITIVE_INFINITY]);
      else if (roll < 0.04)
        bar.h = 50 + rnd() * 100; // implausible market cap
      else if (roll < 0.05) bar.volumeUsd = pick([-1, Number.NaN]);
      return bar;
    };

    const series = (resolution: number, runs: number, runLength: number): Bar[] => {
      const bars: Bar[] = [];
      const seen = new Set<number>();
      const add = (bar: Bar) => {
        if (!allowDuplicates && seen.has(bar.t)) return;
        seen.add(bar.t);
        bars.push(bar);
      };
      for (let r = 0; r < runs; r++) {
        let price = Math.exp(Math.log(1e-6) + rnd() * Math.log(1e3));
        const slots = Math.floor((asOf - launchedAt) / resolution) + 2;
        const first = Math.floor(launchedAt / resolution) - 1 + int(0, Math.max(0, slots - 1));
        for (let i = 0; i < runLength; i++) {
          if (rnd() < 0.2) continue; // a gap: nobody traded
          price *= 0.7 + rnd() * 0.7;
          const bar = makeBar((first + i) * resolution, price);
          add(bar);
          if (allowDuplicates && rnd() < 0.05) add(makeBar(bar.t, price * 1.1));
        }
      }
      return bars;
    };

    pools.push({
      address: `pool-${p}-${int(0, 9)}`,
      dex: 'dex',
      isPrimary,
      bars1m: series(60, int(0, 4), int(1, 40)),
      bars1h: series(3_600, int(0, 2), int(1, 12)),
      bars1d: series(DAY, int(0, 1), int(1, 4)),
    });
  }
  return { totalSupply: 1_000_000_000, launchedAt, asOf, pools };
}

function shuffled<T>(items: readonly T[], rnd: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
  }
  return copy;
}

describe('properties over seeded random inputs', () => {
  const seeds = Array.from({ length: CASES }, (_, i) => i + 1);

  it('ATH never exceeds the wick; ATH and wick are null together or ordered', () => {
    for (const seed of seeds) {
      const r = computeCoinMetrics(generateInput(seed, { allowDuplicates: true }));
      if (r.athMarketCapUsd !== null) {
        expect(r.athWickMarketCapUsd, `seed ${seed}`).not.toBeNull();
        expect(r.athMarketCapUsd, `seed ${seed}`).toBeLessThanOrEqual(
          r.athWickMarketCapUsd as number,
        );
      }
    }
  });

  it('secondsAbove never increases along the thresholds and stays within the observed span', () => {
    let nonZero = 0;
    for (const seed of seeds) {
      const inp = generateInput(seed, { allowDuplicates: true });
      const r = computeCoinMetrics(inp);
      const times = inp.pools
        .flatMap((p) => [...p.bars1m, ...p.bars1h, ...p.bars1d])
        .map((b) => b.t)
        .filter((t) => t <= inp.asOf);
      const span = times.length === 0 ? 0 : inp.asOf - Math.min(...times);
      for (let i = 0; i < r.secondsAbove.length; i++) {
        const v = r.secondsAbove[i] as number;
        expect(v, `seed ${seed}`).toBeGreaterThanOrEqual(0);
        expect(v, `seed ${seed}`).toBeLessThanOrEqual(span);
        if (i > 0) expect(v, `seed ${seed}`).toBeLessThanOrEqual(r.secondsAbove[i - 1] as number);
      }
      if ((r.secondsAbove[0] as number) > 0) nonZero++;
    }
    // The generator must exercise the interesting path, not only empty results.
    expect(nonZero).toBeGreaterThan(CASES / 10);
  });

  it('max drawdown is null or between 0 and 100', () => {
    let defined = 0;
    for (const seed of seeds) {
      const r = computeCoinMetrics(generateInput(seed, { allowDuplicates: true }));
      if (r.maxDrawdownPct !== null) {
        defined++;
        expect(r.maxDrawdownPct, `seed ${seed}`).toBeGreaterThanOrEqual(0);
        expect(r.maxDrawdownPct, `seed ${seed}`).toBeLessThanOrEqual(100);
      }
    }
    expect(defined).toBeGreaterThan(CASES / 10);
  });

  it('flags are sorted and unique', () => {
    for (const seed of seeds) {
      const { flags } = computeCoinMetrics(generateInput(seed, { allowDuplicates: true }));
      expect(flags, `seed ${seed}`).toEqual([...new Set(flags)].sort());
    }
  });

  it('shuffling the bars within each pool and the order of the pools changes nothing', () => {
    for (const seed of seeds) {
      const inp = generateInput(seed, { allowDuplicates: false });
      const rnd = seededRandom(seed * 7919);
      const mixed: MetricInput = {
        ...inp,
        pools: shuffled(
          inp.pools.map((p) => ({
            ...p,
            bars1m: shuffled(p.bars1m, rnd),
            bars1h: shuffled(p.bars1h, rnd),
            bars1d: shuffled(p.bars1d, rnd),
          })),
          rnd,
        ),
      };
      expect(computeCoinMetrics(mixed), `seed ${seed}`).toEqual(computeCoinMetrics(inp));
    }
  });

  it('never mutates its input or its parameters (deep-frozen)', () => {
    for (const seed of seeds) {
      const inp = deepFreeze(generateInput(seed, { allowDuplicates: true }));
      const params = deepFreeze({ windowMinutes: 4, thresholdsUsd: [50_000, 500_000] });
      expect(() => computeCoinMetrics(inp)).not.toThrow();
      expect(() => computeCoinMetrics(inp, params)).not.toThrow();
    }
  });

  it('is deterministic', () => {
    for (const seed of seeds.slice(0, 50)) {
      const inp = generateInput(seed, { allowDuplicates: true });
      expect(computeCoinMetrics(inp)).toEqual(computeCoinMetrics(inp));
    }
  });
});
