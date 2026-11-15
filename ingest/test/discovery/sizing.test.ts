import { describe, expect, it } from 'vitest';
import {
  formatSizingTable,
  nearestRank,
  PEAK_THRESHOLDS_USD,
  sizeTargetSet,
  sizeTotals,
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

describe('thresholds', () => {
  it('are $30k, $50k, $80k, $100k, $125k, $1M, $10M and $100M', () => {
    expect([...PEAK_THRESHOLDS_USD]).toEqual([
      30_000, 50_000, 80_000, 100_000, 125_000, 1_000_000, 10_000_000, 100_000_000,
    ]);
  });

  const at = (peak: number | null, i: number) => row(`m${i}`, JAN, peak);

  it('counts a coin at a threshold, and not one cent below it', () => {
    for (const t of PEAK_THRESHOLDS_USD) {
      const [m] = sizeTargetSet([at(t, 1), at(t - 0.01, 2)]);
      expect(m!.graduated).toBe(2);
      expect(m!.reached[String(t)]).toBe(1);
      for (const other of PEAK_THRESHOLDS_USD) {
        if (other < t) expect(m!.reached[String(other)]).toBeGreaterThanOrEqual(1);
        if (other > t) expect(m!.reached[String(other)]).toBe(0);
      }
    }
  });

  it('counts the exact boundary values in every cumulative bucket', () => {
    const peaks = [
      29_999.99,
      30_000,
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
    expect(m!.graduated).toBe(14);
    expect(m!.reached).toEqual({
      '30000': 13,
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
    expect(m!.reached['30000']).toBe(1);
    expect(m!.reached['50000']).toBe(1);
    expect(m!.reached['80000']).toBe(0);
  });

  it('returns nothing for an empty list', () => {
    expect(sizeTargetSet([])).toEqual([]);
  });
});

describe('months', () => {
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
    expect(sizes[1]!.hours).toBeNull();
    expect(sizes[1]!.reached['50000']).toBe(0);
  });
});

describe('hours statistics', () => {
  const big = (i: number, hours: number | null, peak: number | null = 100_000) =>
    row(`m${i}`, JAN, peak, { hours });

  it('uses nearest-rank percentiles of hours over coins at $100k or more only', () => {
    const rows = [
      ...Array.from({ length: 10 }, (_, i) => big(i, (i + 1) * 100)),
      big(50, 5_000_000, 99_999.99), // under $100k: not in the statistic
      big(51, 5_000_000, null), // no peak: not in the statistic
    ];
    const [m] = sizeTargetSet(rows);
    expect(m!.hours).toEqual({ n: 10, median: 500, p90: 900, p99: 1000, max: 1000 });
  });

  it('leaves out coins with no hours value, and says how many were used', () => {
    const [m] = sizeTargetSet([big(1, 10), big(2, null), big(3, 30), big(4, 0)]);
    expect(m!.hours).toMatchObject({ n: 3, max: 30, median: 10 });
  });

  it('is null when no coin reaches $100k', () => {
    const [m] = sizeTargetSet([big(1, 10, 99_999)]);
    expect(m!.hours).toBeNull();
  });
});

describe('sizeTotals', () => {
  it('counts every coin across months and takes the statistic over all of them', () => {
    const rows = [
      row('a', '2024-01-10T00:00:00Z', 150_000, { hours: 10 }),
      row('b', '2024-05-10T00:00:00Z', 2_000_000, { hours: 30 }),
      row('c', '2025-01-10T00:00:00Z', 40_000, { hours: 99 }),
      row('d', '2025-01-11T00:00:00Z', null),
    ];
    const t = sizeTotals(rows);
    expect(t.month).toBe('total');
    expect(t.graduated).toBe(4);
    expect(t.reached).toMatchObject({ '30000': 3, '100000': 2, '1000000': 1, '10000000': 0 });
    expect(t.hours).toEqual({ n: 2, median: 10, p90: 30, p99: 30, max: 30 });
    // The month rows add up to the totals row.
    const months = sizeTargetSet(rows);
    expect(months.reduce((s, m) => s + m.graduated, 0)).toBe(t.graduated);
    expect(months.reduce((s, m) => s + (m.reached['100000'] as number), 0)).toBe(
      t.reached['100000'],
    );
  });

  it('is zeros for an empty list', () => {
    expect(sizeTotals([])).toMatchObject({ graduated: 0, hours: null });
  });
});

describe('order', () => {
  it('gives the same output in any row order', () => {
    const rows = Array.from({ length: 200 }, (_, i) =>
      row(`m${i}`, `2024-${String((i % 12) + 1).padStart(2, '0')}-10T00:00:00Z`, i * 7_000, {
        hours: i * 3,
      }),
    );
    const base = sizeTargetSet(rows);
    for (const seed of [1, 2, 3]) expect(sizeTargetSet(shuffled(rows, seed))).toEqual(base);
    expect(sizeTotals(shuffled(rows, 9))).toEqual(sizeTotals(rows));
  });
});

describe('formatSizingTable', () => {
  it('prints one line per month under a header, and the totals row last', () => {
    const rows = [row('a', JAN, 1e6, { hours: 5 })];
    const lines = formatSizingTable(sizeTargetSet(rows), sizeTotals(rows)).split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('>=30k');
    expect(lines[1]!.startsWith('2025-01\t1\t')).toBe(true);
    expect(lines[2]!.startsWith('total\t1\t')).toBe(true);
  });
});
