import { describe, expect, it } from 'vitest';
import { cleanBars } from '../../src/metrics/clean.js';
import { computeCoinMetrics, mergeParams } from '../../src/metrics/index.js';
import type { CleanPool } from '../../src/metrics/internal.js';
import { DEFAULT_METRIC_PARAMS } from '../../src/metrics/types.js';
import { buildWindows, buildWindowsByScanning, minuteWindows } from '../../src/metrics/windows.js';
import { DAY, M0, bar, input, pool } from './helpers.js';

const supply = { totalSupply: 1_000_000_000, asOf: M0 + 3_600 };
const params = DEFAULT_METRIC_PARAMS;

describe('section 3 rule 5: non-finite liquidity is unknown', () => {
  it('drops a secondary bar whose liquidity is NaN or Infinity; primary keeps it', () => {
    const bars = [
      bar(M0, 0.0001, { liquidityUsd: Number.NaN }),
      bar(M0 + 60, 0.0001, { liquidityUsd: Number.POSITIVE_INFINITY }),
      bar(M0 + 120, 0.0001, { liquidityUsd: 5_000 }),
    ];
    expect(cleanBars(bars, false, supply, params).bars.map((b) => b.t)).toEqual([M0 + 120]);
    expect(cleanBars(bars, true, supply, params).bars).toHaveLength(3);
  });
});

describe('section 3: bad traders and trades count as zero', () => {
  it('replaces NaN, Infinity and negative counts with zero, on a copy', () => {
    const original = bar(M0, 0.0001, { traders: Number.NaN, trades: -3 });
    const good = bar(M0 + 60, 0.0001, { traders: 7, trades: 2 });
    const infinite = bar(M0 + 120, 0.0001, { traders: Number.POSITIVE_INFINITY });
    const result = cleanBars([original, good, infinite], true, supply, params);
    expect(result.bars[0]).toMatchObject({ traders: 0, trades: 0 });
    expect(result.bars[1]).toBe(good);
    expect(result.bars[2]?.traders).toBe(0);
    expect(Number.isNaN(original.traders)).toBe(true);
    expect(original.trades).toBe(-3);
    expect(result.flags).toEqual([]);
  });

  it('a bar with a NaN traders count does not make its window strict', () => {
    const bars = [bar(M0, 1, { traders: Number.NaN }), bar(M0 + 60, 1, { traders: 4 })];
    const cleaned = cleanBars(bars, true, supply, params).bars;
    const windows = minuteWindows(cleaned, { address: 'P', isPrimary: true }, params);
    expect(windows[1]).toMatchObject({ traders: 4, strict: false });
  });

  it('is applied through computeCoinMetrics', () => {
    const bars = [
      bar(M0, 0.0001, { traders: Number.NaN, volumeUsd: 2_000 }),
      bar(M0 + 60, 0.0001, { traders: 4, volumeUsd: 2_000 }),
    ];
    expect(computeCoinMetrics(input([pool({ bars1m: bars })])).flags).toEqual([
      'no_qualifying_window',
    ]);
  });
});

describe('section 2: windowMinutes validation', () => {
  it.each([1, 0, -2, 2.5, Number.NaN])('throws a RangeError for %s', (windowMinutes) => {
    expect(() => mergeParams({ windowMinutes })).toThrow(RangeError);
    expect(() => computeCoinMetrics(input([pool()]), { windowMinutes })).toThrow(RangeError);
  });

  it('accepts 2 and larger whole numbers, and the defaults', () => {
    expect(mergeParams({ windowMinutes: 2 }).windowMinutes).toBe(2);
    expect(mergeParams().windowMinutes).toBe(3);
    expect(() => computeCoinMetrics(input([pool()]), { windowMinutes: 10 })).not.toThrow();
  });
});

describe('finer data wins: the precomputed lookup equals the scanning reading', () => {
  it('3,000 minute bars and 10,000 hourly bars across two pools', () => {
    const cp = (over: Partial<CleanPool>): CleanPool => ({
      address: 'P',
      isPrimary: true,
      bars1m: [],
      bars1h: [],
      bars1d: [],
      ...over,
    });
    const minutes = (n: number, firstMinute: number, step: number) =>
      Array.from({ length: n }, (_, i) =>
        bar(DAY + (firstMinute + i * step) * 60, 0.0001 + (i % 13) * 1e-6),
      );
    const hours = (n: number, firstHour: number) =>
      Array.from({ length: n }, (_, i) => bar(DAY + (firstHour + i) * 3_600, 0.0002));
    // Daily bars: some days hold finer bars, some do not.
    const days = Array.from({ length: 60 }, (_, i) => bar(DAY + i * 86_400 * 7, 0.0003));
    const pools = [
      cp({ bars1m: minutes(2_000, 0, 7), bars1h: hours(6_000, 0), bars1d: days }),
      cp({
        address: 'S',
        isPrimary: false,
        bars1m: minutes(1_000, 3, 41),
        bars1h: hours(4_000, 2_000),
      }),
    ];
    const fast = buildWindows(pools, params);
    const slow = buildWindowsByScanning(pools, params);
    expect(fast.length).toBeGreaterThan(5_000);
    expect(fast.some((w) => w.resolution === '1h')).toBe(true);
    expect(fast.some((w) => w.resolution === '1d')).toBe(true);
    // Some coarse bars were removed, so the test is not vacuous.
    expect(fast.length).toBeLessThan(3_000 + 10_000 + 60);
    expect(fast).toEqual(slow);
  });
});
