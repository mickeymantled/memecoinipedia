import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HALF_YEARS,
  drawSample,
  halfYearOf,
  sampleToCsv,
  type GraduateRow,
  type SampleRow,
} from '../../src/discovery/index.js';
import { row, shuffled } from './helpers.js';

const sha = (m: string) => createHash('sha256').update(m).digest('hex');

/** Mid-points of the five cells, in USD. */
const PEAK = { c30: 40_000, c50: 70_000, c100: 500_000, c1m: 5_000_000, c10m: 50_000_000 } as const;
const HY_DATE: Record<string, string> = {
  '2024-H1': '2024-03-01T00:00:00Z',
  '2024-H2': '2024-09-01T00:00:00Z',
  '2025-H1': '2025-03-01T00:00:00Z',
  '2025-H2': '2025-09-01T00:00:00Z',
  '2026-H1': '2026-03-01T00:00:00Z',
  '2026-H2': '2026-09-01T00:00:00Z',
};

function coins(prefix: string, hy: string, peak: number, n: number): GraduateRow[] {
  return Array.from({ length: n }, (_, i) => row(`${prefix}-${hy}-${i}`, HY_DATE[hy]!, peak));
}

/** Plenty of coins in every cell of every half-year. */
function plenty(n = 80): GraduateRow[] {
  return DEFAULT_HALF_YEARS.flatMap((hy) =>
    (Object.keys(PEAK) as Array<keyof typeof PEAK>).flatMap((k) => coins(k, hy, PEAK[k], n)),
  );
}

const count = (s: SampleRow[], hy: string, cell: string) =>
  s.filter((r) => !r.probe && r.halfYear === hy && r.cell === cell).length;

const probes20 = Array.from({ length: 20 }, (_, i) => `probe-${i}`);

describe('quota table', () => {
  it('draws 5, 10, 30, 20 and 15 per half-year, and 500 coins with 20 probes', () => {
    const rows = [...plenty(), ...probes20.map((p) => row(p, HY_DATE['2025-H1']!, PEAK.c1m))];
    const s = drawSample(rows, { probes: probes20 });
    for (const hy of DEFAULT_HALF_YEARS) {
      expect(count(s, hy, '30k-50k')).toBe(5);
      expect(count(s, hy, '50k-100k')).toBe(10);
      expect(count(s, hy, '100k-1M')).toBe(30);
      expect(count(s, hy, '1M-10M')).toBe(20);
      expect(count(s, hy, '10M+')).toBe(15);
    }
    expect(s).toHaveLength(500);
    expect(s.filter((r) => r.probe)).toHaveLength(20);
    expect(new Set(s.map((r) => r.mint)).size).toBe(500);
  });

  it('never returns more than 500 whatever the input size', () => {
    const s = drawSample(
      [...plenty(500), ...probes20.map((p) => row(p, '2025-02-01T00:00:00Z', 1e6))],
      {
        probes: probes20,
      },
    );
    expect(s.length).toBeLessThanOrEqual(500);
  });

  it('refuses options whose quotas could pass the limit', () => {
    expect(() => drawSample([], { probes: Array.from({ length: 21 }, (_, i) => `p${i}`) })).toThrow(
      RangeError,
    );
    expect(() => drawSample([], { fillCell: 'nope' })).toThrow(/fill cell/);
  });
});

describe('cell and half-year boundaries', () => {
  const one = (peak: number | null, created = HY_DATE['2025-H1']!) =>
    drawSample([row('x', created, peak)], {});

  it('puts a coin at a lower bound in the cell above, and one cent below in the cell below', () => {
    expect(one(29_999.99)).toEqual([]);
    expect(one(30_000)[0]!.cell).toBe('30k-50k');
    expect(one(49_999.99)[0]!.cell).toBe('30k-50k');
    expect(one(50_000)[0]!.cell).toBe('50k-100k');
    expect(one(99_999.99)[0]!.cell).toBe('50k-100k');
    expect(one(100_000)[0]!.cell).toBe('100k-1M');
    expect(one(999_999.99)[0]!.cell).toBe('100k-1M');
    expect(one(1_000_000)[0]!.cell).toBe('1M-10M');
    expect(one(9_999_999.99)[0]!.cell).toBe('1M-10M');
    expect(one(10_000_000)[0]!.cell).toBe('10M+');
    expect(one(1e12)[0]!.cell).toBe('10M+');
  });

  it('does not draw a coin with no rough peak', () => {
    expect(one(null)).toEqual([]);
  });

  it('uses the UTC half of created_at', () => {
    expect(halfYearOf(Date.parse('2024-06-30T23:59:59Z'))).toBe('2024-H1');
    expect(halfYearOf(Date.parse('2024-07-01T00:00:00Z'))).toBe('2024-H2');
    expect(halfYearOf(Date.parse('2024-07-01T00:00:00+02:00'))).toBe('2024-H1'); // June 30, 22:00 UTC
    expect(halfYearOf(Date.parse('2024-12-31T23:59:59Z'))).toBe('2024-H2');
    expect(one(1e6, '2024-01-01T00:00:00Z')[0]!.halfYear).toBe('2024-H1');
  });

  it('does not draw coins outside the half-years', () => {
    expect(one(1e6, '2023-12-31T23:59:59Z')).toEqual([]);
    expect(one(1e6, '2027-01-01T00:00:00Z')).toEqual([]);
    expect(one(1e6, '2026-12-31T23:59:59Z')).toHaveLength(1);
  });
});

describe('fill rule', () => {
  it('adds the other cells shortfall to the $100k to $1M cell of the same half-year', () => {
    const hy = '2025-H1';
    const rows = [
      ...coins('z', hy, PEAK.c30, 2), // short by 3
      ...coins('a', hy, PEAK.c50, 4), // short by 6
      ...coins('b', hy, PEAK.c100, 100), // plenty
      ...coins('c', hy, PEAK.c1m, 20), // exactly full
      ...coins('d', hy, PEAK.c10m, 2), // short by 13
    ];
    const s = drawSample(rows);
    expect(count(s, hy, '30k-50k')).toBe(2);
    expect(count(s, hy, '50k-100k')).toBe(4);
    expect(count(s, hy, '1M-10M')).toBe(20);
    expect(count(s, hy, '10M+')).toBe(2);
    expect(count(s, hy, '100k-1M')).toBe(30 + 3 + 6 + 13);
    expect(s).toHaveLength(2 + 4 + 20 + 2 + 52);
  });

  it('takes what exists when the fill cell is short too', () => {
    const hy = '2025-H1';
    const s = drawSample([...coins('b', hy, PEAK.c100, 40), ...coins('d', hy, PEAK.c10m, 1)]);
    expect(count(s, hy, '100k-1M')).toBe(40);
    expect(count(s, hy, '10M+')).toBe(1);
  });

  it('does not move a surplus from one half-year to another', () => {
    const s = drawSample([
      ...coins('b', '2025-H1', PEAK.c100, 100),
      ...coins('c', '2025-H2', PEAK.c1m, 1),
    ]);
    expect(count(s, '2025-H1', '100k-1M')).toBe(80); // 30 plus 50 of shortfall, from its own half-year only
    expect(count(s, '2025-H2', '100k-1M')).toBe(0);
    expect(count(s, '2025-H2', '1M-10M')).toBe(1);
  });

  it('gives a half-year with no coins no rows and does not disturb the others', () => {
    const s = drawSample(coins('b', '2024-H1', PEAK.c100, 100));
    expect(s.every((r) => r.halfYear === '2024-H1')).toBe(true);
    expect(s).toHaveLength(80); // 30 plus the 50 of shortfall from the four empty cells
    for (const hy of DEFAULT_HALF_YEARS.slice(1))
      expect(s.filter((r) => r.halfYear === hy)).toEqual([]);
  });

  it('returns an empty sample for an empty list', () => {
    expect(drawSample([])).toEqual([]);
  });
});

describe('probes', () => {
  it('are always included, flagged, and listed first in the order given', () => {
    const rows = [
      ...plenty(),
      row('p-b', HY_DATE['2024-H1']!, PEAK.c1m),
      row('p-a', HY_DATE['2026-H2']!, PEAK.c50),
    ];
    const s = drawSample(rows, { probes: ['p-a', 'p-b'] });
    expect(s.slice(0, 2)).toEqual([
      expect.objectContaining({
        mint: 'p-a',
        probe: true,
        probeMissing: false,
        halfYear: '2026-H2',
        cell: '50k-100k',
      }),
      expect.objectContaining({
        mint: 'p-b',
        probe: true,
        probeMissing: false,
        halfYear: '2024-H1',
        cell: '1M-10M',
      }),
    ]);
    expect(s.slice(2).every((r) => !r.probe)).toBe(true);
  });

  it('do not count against the quotas, and appear once', () => {
    // The probes are the coins that would be drawn first in the cell. Removing them from the
    // pool means the cell still gets its full quota from the other coins.
    const hy = '2025-H1';
    const pool = coins('b', hy, PEAK.c100, 60);
    const byHash = [...pool].sort((a, b) => (sha(a.mint) < sha(b.mint) ? -1 : 1));
    const probes = byHash.slice(0, 5).map((r) => r.mint);
    const s = drawSample(pool, { probes });
    expect(count(s, hy, '100k-1M')).toBe(55); // quota 30 plus 50 of shortfall is 80, but only 55 coins are left
    expect(s.filter((r) => r.probe)).toHaveLength(5);
    expect(s.length).toBe(5 + 55);
    expect(new Set(s.map((r) => r.mint)).size).toBe(s.length);
    // The coins next in hash order took their place.
    const drawn = new Set(s.filter((r) => !r.probe).map((r) => r.mint));
    expect(drawn.has(byHash[5]!.mint)).toBe(true);
    expect(drawn.size).toBe(55);
  });

  it('are returned flagged as missing when they are not in the list', () => {
    const s = drawSample([], { probes: ['gone'] });
    expect(s).toEqual([
      { mint: 'gone', halfYear: null, cell: null, probe: true, probeMissing: true, row: null },
    ]);
  });

  it('are kept when outside every half-year or without a peak, with the cell or half-year left null', () => {
    const s = drawSample(
      [row('old', '2023-01-01T00:00:00Z', 1e6), row('flat', HY_DATE['2025-H1']!, null)],
      { probes: ['old', 'flat'] },
    );
    expect(s).toEqual([
      expect.objectContaining({ mint: 'old', halfYear: '2023-H1', cell: '1M-10M', probe: true }),
      expect.objectContaining({ mint: 'flat', halfYear: '2025-H1', cell: null, probe: true }),
    ]);
  });

  it('listed twice are returned once', () => {
    const s = drawSample([row('p', HY_DATE['2025-H1']!, 1e6)], { probes: ['p', 'p'] });
    expect(s).toHaveLength(1);
  });
});

describe('determinism', () => {
  it('orders a cell by the SHA-256 of the mint, then the mint', () => {
    const hy = '2025-H1';
    const pool = coins('b', hy, PEAK.c1m, 60);
    const s = drawSample(pool).filter((r) => r.cell === '1M-10M');
    const expected = pool
      .map((r) => r.mint)
      .sort((a, b) => (sha(a) < sha(b) ? -1 : sha(a) > sha(b) ? 1 : a < b ? -1 : 1))
      .slice(0, 20);
    expect(s.map((r) => r.mint)).toEqual(expected);
  });

  it('gives the same sample in any row order', () => {
    const rows = [...plenty(90), ...probes20.map((p) => row(p, HY_DATE['2024-H2']!, PEAK.c10m))];
    const base = drawSample(rows, { probes: probes20 });
    for (const seed of [1, 2, 3, 4]) {
      expect(drawSample(shuffled(rows, seed), { probes: probes20 })).toEqual(base);
    }
  });

  it('reduces a repeated mint to one row whichever copy comes first', () => {
    const early = row('dup', '2025-02-01T00:00:00Z', 70_000);
    const late = row('dup', '2025-08-01T00:00:00Z', 5_000_000);
    const a = drawSample([early, late]);
    const b = drawSample([late, early]);
    expect(a).toEqual(b);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ halfYear: '2025-H1', cell: '50k-100k' });
  });
});

describe('sampleToCsv', () => {
  it('writes one line per coin under the header, with times as ISO 8601', () => {
    const full = row('a', '2025-02-01T00:00:00Z', 1e6, {
      creator: 'CreatorX',
      hours: 77,
      peakMaxUsd: 2e6,
      peakAtMs: Date.parse('2025-03-01T12:00:00Z'),
    });
    const s = drawSample([full], { probes: ['gone'] });
    const lines = sampleToCsv(s).trim().split('\n');
    expect(lines[0]).toBe(
      'mint,half_year,cell,probe,probe_missing,created_at,creator,graduated_at,hours,peak_max_usd,peak_p999_usd,peak_at',
    );
    expect(lines[1]).toBe('gone,,,true,true,,,,,,,');
    expect(lines[2]).toBe(
      'a,2025-H1,1M-10M,false,false,2025-02-01T00:00:00.000Z,CreatorX,2025-02-01T01:00:00.000Z,77,2000000,1000000,2025-03-01T12:00:00.000Z',
    );
  });

  it('leaves optional fields empty', () => {
    const lines = sampleToCsv(drawSample([row('b', '2025-02-01T00:00:00Z', 60_000)]))
      .trim()
      .split('\n');
    expect(lines[1]).toBe(
      'b,2025-H1,50k-100k,false,false,2025-02-01T00:00:00.000Z,,2025-02-01T01:00:00.000Z,,60000,60000,',
    );
  });

  it('quotes a field that needs it', () => {
    const csv = sampleToCsv([
      { mint: 'a,b', halfYear: null, cell: null, probe: true, probeMissing: true, row: null },
    ]);
    expect(csv.split('\n')[1]!.startsWith('"a,b",')).toBe(true);
  });
});
