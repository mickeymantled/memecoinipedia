import { describe, expect, it } from 'vitest';
import {
  formatSizingTable,
  nearestRank,
  PEAK_THRESHOLDS_USD,
  sizeTargetSet,
} from '../../src/discovery/index.js';
import { row, shuffled } from './helpers.js';

const JAN = '2025-01-15T00:00:00Z';

describe('nearestRank', () => {
  it('uses rank ceil(p/100 * n) on sorted data', () => {
    const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(nearestRank(ten, 50)).toBe(5);
    expect(nearestRank(ten, 90)).toBe(9);
    expect(nearestRank(ten, 99)).toBe(10);
    expect(nearestRank(ten, 100)).toBe(10);
    expect(nearestRank([7], 50)).toBe(7);
    // 4 values: median is the lower middle one (rank 2).
    expect(nearestRank([10, 20, 30, 40], 50)).toBe(20);
    // 100 values: p99 is rank 99, not 100.
    const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(nearestRank(hundred, 99)).toBe(99);
    expect(nearestRank(hundred, 90)).toBe(90);
  });

  it('throws on no data', () => {
    expect(() => nearestRank([], 50)).toThrow();
  });
});

describe('sizeTargetSet thresholds', () => {
  const at = (peak: number | null, i: number) => row(`m${i}`, JAN, peak);

  it('counts a coin at a threshold, and not one cent below it', () => {
    for (const t of PEAK_THRESHOLDS_USD) {
      const [m] = sizeTargetSet([at(t, 1), at(t - 0.01, 2)]);
      expect(m!.graduated).toBe(2);
      expect(m!.reached[String(t)]).toBe(1);
      // The coin one cent below does not reach this threshold, but the coin at it does.
      for (const other of PEAK_THRESHOLDS_USD) {
        if (other < t) expect(m!.reached[String(other)]).toBeGreaterThanOrEqual(1);
        if (other > t) expect(m!.reached[String(other)]).toBe(0);
      }
    }
  });

  it('counts the exact boundary values in every cumulative bucket', () => {
    const peaks = [
      49_999.99,
      50_000,
      79_999,
      80_000,
      99_999.99,
      100_000,
      124_999,
      125_000,
      1e6 - 1,
      1e6,
      1e7,
      1e8,
    ];
    const [m] = sizeTargetSet(peaks.map(at));
    expect(m!.graduated).toBe(12);
    expect(m!.reached).toEqual({
      '50000': 11,
      '80000': 9,
      '100000': 7,
      '125000': 5,
      '1000000': 3,
      '10000000': 2,
      '100000000': 1,
    });
  });

  it('counts a coin with no rough peak as graduated and below every threshold', () => {
    const [m] = sizeTargetSet([at(null, 1), at(0, 2), at(60_000, 3)]);
    expect(m!.graduated).toBe(3);
    expect(m!.reached['50000']).toBe(1);
  });

  it('returns nothing for an empty list', () => {
    expect(sizeTargetSet([])).toEqual([]);
  });
});

describe('sizeTargetSet months', () => {
  it('uses the UTC month of created_at, at the boundary to the second', () => {
    const sizes = sizeTargetSet([
      row('a', '2024-01-31T23:59:59Z', 1),
      row('b', '2024-02-01T00:00:00Z', 1),
      row('c', '2024-02-01T00:00:00+02:00', 1), // 2024-01-31T22:00Z: January
    ]);
    expect(sizes.map((s) => [s.month, s.graduated])).toEqual([
      ['2024-01', 2],
      ['2024-02', 1],
    ]);
  });

  it('fills months with no coins, in order, across a year end', () => {
    const sizes = sizeTargetSet([
      row('a', '2024-11-05T00:00:00Z', 1),
      row('b', '2025-02-05T00:00:00Z', 1),
    ]);
    expect(sizes.map((s) => [s.month, s.graduated])).toEqual([
      ['2024-11', 1],
      ['2024-12', 0],
      ['2025-01', 0],
      ['2025-02', 1],
    ]);
    expect(sizes[1]!.tradesPerCoin).toBeNull();
    expect(sizes[1]!.reached['50000']).toBe(0);
  });
});

describe('sizeTargetSet statistics', () => {
  const DAY = 86_400_000;
  const big = (i: number, trades: number | null, days: number | null, peak = 100_000) =>
    row(`m${i}`, JAN, peak, {
      tradeCount: trades,
      firstTradeAtMs: days === null ? null : Date.parse(JAN),
      lastTradeAtMs: days === null ? null : Date.parse(JAN) + days * DAY,
    });

  it('uses nearest-rank percentiles over coins at $100k or more only', () => {
    const rows = [
      ...Array.from({ length: 10 }, (_, i) => big(i, (i + 1) * 100, i + 1)),
      big(50, 5_000_000, 900, 99_999.99), // under $100k: not in the statistics
      big(51, 5_000_000, 900, null as unknown as number), // no peak: not in the statistics
    ];
    const [m] = sizeTargetSet(rows);
    expect(m!.tradesPerCoin).toEqual({ n: 10, median: 500, p90: 900, p99: 1000, max: 1000 });
    expect(m!.daysBetweenFirstAndLastTrade).toEqual({ n: 10, median: 5, p90: 9, p99: 10, max: 10 });
  });

  it('leaves out coins with missing or inconsistent data, per statistic', () => {
    const [m] = sizeTargetSet([
      big(1, 10, 2),
      big(2, null, 4), // no trade count: only in the days statistic
      big(3, 30, null), // no times: only in the trades statistic
      row('m4', JAN, 200_000, {
        tradeCount: 40,
        firstTradeAtMs: Date.parse(JAN) + DAY,
        lastTradeAtMs: Date.parse(JAN), // last before first: left out of days
      }),
    ]);
    expect(m!.tradesPerCoin).toMatchObject({ n: 3, max: 40, median: 30 });
    expect(m!.daysBetweenFirstAndLastTrade).toMatchObject({ n: 2, max: 4, median: 2 });
  });

  it('keeps fractional days', () => {
    const [m] = sizeTargetSet([
      row('a', JAN, 1e6, { tradeCount: 1, firstTradeAtMs: 0, lastTradeAtMs: DAY / 2 }),
    ]);
    expect(m!.daysBetweenFirstAndLastTrade!.median).toBe(0.5);
  });

  it('gives null statistics when no coin reaches $100k', () => {
    const [m] = sizeTargetSet([big(1, 10, 2, 99_999)]);
    expect(m!.tradesPerCoin).toBeNull();
    expect(m!.daysBetweenFirstAndLastTrade).toBeNull();
  });
});

describe('sizeTargetSet order', () => {
  it('gives the same output in any row order', () => {
    const rows = Array.from({ length: 200 }, (_, i) =>
      row(`m${i}`, `2024-${String((i % 12) + 1).padStart(2, '0')}-10T00:00:00Z`, i * 7_000, {
        tradeCount: i * 3,
        firstTradeAtMs: 0,
        lastTradeAtMs: i * 3_600_000,
      }),
    );
    const base = sizeTargetSet(rows);
    for (const seed of [1, 2, 3]) expect(sizeTargetSet(shuffled(rows, seed))).toEqual(base);
  });
});

describe('formatSizingTable', () => {
  it('prints one line per month under a header', () => {
    const text = formatSizingTable(
      sizeTargetSet([
        row('a', JAN, 1e6, { tradeCount: 5, firstTradeAtMs: 0, lastTradeAtMs: 86_400_000 }),
      ]),
    );
    const lines = text.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]!.startsWith('2025-01\t1\t')).toBe(true);
  });
});
