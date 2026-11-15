import { describe, expect, it } from 'vitest';
import {
  MAX_BUCKETS_PER_REQUEST,
  RESOLUTION_SECONDS,
  barsFromColumns,
  planBarRequests,
  sortAndDedupeBars,
} from '../../../src/sources/codex/bars.js';
import { barsDataSchema } from '../../../src/sources/codex/schemas.js';
import type { BarResolution } from '../../../src/sources/codex/queries.js';
import { loadFixture } from '../helpers.js';

const DAY = 86_400;

function checkPlan(from: number, to: number, resolution: BarResolution) {
  const step = RESOLUTION_SECONDS[resolution];
  const windows = planBarRequests({ from, to, resolution });
  let total = 0;
  windows.forEach((w, i) => {
    expect(w.buckets).toBeGreaterThan(0);
    expect(w.buckets).toBeLessThanOrEqual(MAX_BUCKETS_PER_REQUEST);
    expect(w.from % step).toBe(0);
    expect((w.to - w.from + 1) / step).toBe(w.buckets);
    if (i > 0) expect(w.from).toBe(windows[i - 1]!.to + 1);
    total += w.buckets;
  });
  return { windows, total };
}

describe('planBarRequests', () => {
  it('48 hours of 1-minute bars is 2880 buckets in 2 requests', () => {
    const from = 1_788_220_800;
    const { windows, total } = checkPlan(from, from + 2 * DAY, '1');
    expect(total).toBe(2880);
    expect(windows.map((w) => w.buckets)).toEqual([1500, 1380]);
    expect(windows[0]!.from).toBe(from);
    expect(windows[1]!.to).toBe(from + 2 * DAY - 1);
  });

  it('48 hours starting mid-minute still takes 2 requests and covers the range', () => {
    const from = 1_788_220_837;
    const to = from + 2 * DAY;
    const { windows } = checkPlan(from, to, '1');
    expect(windows).toHaveLength(2);
    expect(windows[0]!.from).toBe(1_788_220_800);
    expect(windows.at(-1)!.to).toBeGreaterThanOrEqual(to - 1);
  });

  it('one year of hourly bars is 8760 buckets in 6 requests', () => {
    const from = 1_767_225_600; // 2026-01-01T00:00:00Z, a multiple of 3600
    const { windows, total } = checkPlan(from, from + 365 * DAY, '60');
    expect(total).toBe(8760);
    expect(windows).toHaveLength(6);
    expect(windows.map((w) => w.buckets)).toEqual([1500, 1500, 1500, 1500, 1500, 1260]);
  });

  it('exactly 1500 buckets is one request and 1501 is two', () => {
    expect(checkPlan(0, 1500 * 60, '1').windows).toHaveLength(1);
    const two = checkPlan(0, 1501 * 60, '1').windows;
    expect(two.map((w) => w.buckets)).toEqual([1500, 1]);
  });

  it('handles daily bars, tiny ranges and empty ranges', () => {
    expect(checkPlan(0, 4 * 365 * DAY, '1D').windows).toHaveLength(1);
    expect(checkPlan(10, 11, '1').total).toBe(1);
    expect(planBarRequests({ from: 100, to: 100, resolution: '1' })).toEqual([]);
    expect(planBarRequests({ from: 100, to: 50, resolution: '1' })).toEqual([]);
  });

  it('never duplicates or skips a bucket, for assorted ranges', () => {
    for (const resolution of ['1', '60', '1D'] as const) {
      for (const [from, span] of [
        [1_700_000_001, 12_345],
        [1_700_000_001, 5_000_000],
        [1_700_000_001, 400_000_000],
        [59, 2],
      ] as const) {
        const { windows, total } = checkPlan(from, from + span, resolution);
        const step = RESOLUTION_SECONDS[resolution];
        const expected = Math.floor((from + span - 1) / step) - Math.floor(from / step) + 1;
        expect(total).toBe(expected);
        expect(windows.length).toBe(Math.ceil(expected / MAX_BUCKETS_PER_REQUEST));
      }
    }
  });

  it('rejects non-finite input', () => {
    expect(() => planBarRequests({ from: NaN, to: 10, resolution: '1' })).toThrow(TypeError);
  });
});

describe('barsFromColumns', () => {
  it('maps the 2026 one-minute fixture into Bar', () => {
    const cols = barsDataSchema.parse(loadFixture('bars-1m-2026').data).getBars;
    const bars = barsFromColumns(cols);
    expect(bars).toHaveLength(20);
    const raw = loadFixture('bars-1m-2026').data.getBars;
    const first = bars[0]!;
    expect(first).toEqual({
      t: raw.t[0],
      o: raw.o[0],
      h: raw.h[0],
      l: raw.l[0],
      c: raw.c[0],
      volumeUsd: Number(raw.volume[0]),
      trades: raw.transactions[0],
      traders: raw.traders[0],
      liquidityUsd: Number(raw.liquidity[0]),
    });
    expect(bars.map((b) => b.t)).toEqual([...bars.map((b) => b.t)].sort((a, b) => a - b));
  });

  it('maps the 2024 hourly fixture and keeps hourly spacing', () => {
    const bars = barsFromColumns(barsDataSchema.parse(loadFixture('bars-1h-2024').data).getBars);
    expect(bars).toHaveLength(20);
    expect(bars.every((b) => b.t % 3600 === 0)).toBe(true);
    expect(bars.every((b) => b.h >= b.l && b.volumeUsd > 0 && b.trades > 0)).toBe(true);
  });

  it('treats the price fields as USD: the 2026 first full minute matches GeckoTerminal within 0.5%', () => {
    // Recorded 2026-11-14 from GeckoTerminal with currency=usd for the same pool and minute:
    // open 0.0016741880689728084, close 0.0016908015967177607, volume 128.7960079084153.
    const bars = barsFromColumns(barsDataSchema.parse(loadFixture('bars-1m-2026').data).getBars);
    const bar = bars.find((b) => b.t === 1_788_220_980)!;
    expect(Math.abs(bar.o / 0.0016741880689728084 - 1)).toBeLessThan(0.005);
    expect(Math.abs(bar.c / 0.0016908015967177607 - 1)).toBeLessThan(0.005);
    expect(Math.abs(bar.volumeUsd / 128.7960079084153 - 1)).toBeLessThan(0.005);
  });

  it('keeps a bar with null liquidity as liquidityUsd null', () => {
    const cols = barsDataSchema.parse({
      getBars: {
        t: [60, 120],
        o: [1, 2],
        h: [1, 2],
        l: [1, 2],
        c: [1, 2],
        volume: ['10', '20'],
        transactions: [3, 4],
        traders: [2, 2],
        liquidity: [null, '5000'],
      },
    }).getBars;
    const bars = barsFromColumns(cols);
    expect(bars.map((b) => b.liquidityUsd)).toEqual([null, 5000]);
  });

  it('reads a non-finite value ("NaN" arrived from the live API) as null, not as a failed response', () => {
    const cols = barsDataSchema.parse({
      getBars: {
        t: [60, 120, 180],
        o: [1, 'NaN', 3],
        h: [1, 2, 3],
        l: [1, 2, 3],
        c: [1, 2, 3],
        volume: ['10', '20', 'Infinity'],
        transactions: [3, 4, 5],
        traders: [2, 2, 2],
        liquidity: ['NaN', '5000', ''],
      },
    }).getBars;
    const bars = barsFromColumns(cols);
    // The row with a NaN price is dropped; a NaN liquidity is unknown; a NaN volume counts as 0.
    expect(bars.map((b) => b.t)).toEqual([60, 180]);
    expect(bars.map((b) => b.liquidityUsd)).toEqual([null, null]);
    expect(bars.map((b) => b.volumeUsd)).toEqual([10, 0]);
  });

  it('drops empty buckets and rows with missing prices', () => {
    const cols = barsDataSchema.parse({
      getBars: {
        t: [60, 120, 180],
        o: [1, 1, null],
        h: [1, 1, 1],
        l: [1, 1, 1],
        c: [1, 1, 1],
        volume: ['0', '5', '5'],
        transactions: [0, 2, 2],
        traders: [0, 1, 1],
        liquidity: [null, null, null],
      },
    }).getBars;
    expect(barsFromColumns(cols).map((b) => b.t)).toEqual([120]);
  });

  it('returns [] for null columns', () => {
    expect(barsFromColumns(null)).toEqual([]);
  });
});

describe('sortAndDedupeBars', () => {
  const bar = (t: number, c = 1) => ({
    t,
    o: 1,
    h: 1,
    l: 1,
    c,
    volumeUsd: 1,
    trades: 1,
    traders: 1,
    liquidityUsd: null,
  });

  it('sorts and keeps one bar per t across a window boundary', () => {
    const window1 = [bar(0), bar(60), bar(120, 7)];
    const window2 = [bar(120, 9), bar(180)]; // boundary bucket returned by both windows
    const out = sortAndDedupeBars([...window2, ...window1]);
    expect(out.map((b) => b.t)).toEqual([0, 60, 120, 180]);
  });

  it('does not mutate its input', () => {
    const input = [bar(60), bar(0)];
    sortAndDedupeBars(input);
    expect(input.map((b) => b.t)).toEqual([60, 0]);
  });
});
