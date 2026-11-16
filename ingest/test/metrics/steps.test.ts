import { describe, expect, it } from 'vitest';
import { computeAth, computeWick, peakOutsideMinuteCoverage } from '../../src/metrics/ath.js';
import { maxDrawdownPct } from '../../src/metrics/drawdown.js';
import type { CleanPool, CoinPoint, LevelPoint } from '../../src/metrics/internal.js';
import { buildLevelSeries } from '../../src/metrics/level.js';
import { findCrashPoint, rugPattern } from '../../src/metrics/rug.js';
import { holdSeconds, secondsAbove } from '../../src/metrics/timeAbove.js';
import { DEFAULT_METRIC_PARAMS } from '../../src/metrics/types.js';
import { DAY, M0, bar } from './helpers.js';

const SUPPLY = 1_000_000_000;

const pt = (t: number, price: number, strict = true, over: Partial<CoinPoint> = {}): CoinPoint => ({
  t,
  price,
  high: over.high ?? price,
  strict,
  poolAddress: 'P',
  resolution: '1m',
  ...over,
});

describe('section 6: ATH and wick', () => {
  it('ATH is the highest strict 1-minute point; market cap, time and pool follow', () => {
    // Prices 0.0001, 0.0003 (strict), 0.0009 (not strict), 0.0002 -> ATH 0.0003, i.e. $300,000.
    const points = [
      pt(M0, 0.0001),
      pt(M0 + 60, 0.0003, true, { poolAddress: 'Q' }),
      pt(M0 + 120, 0.0009, false),
      pt(M0 + 180, 0.0002),
    ];
    const { fields, athPrice, flags } = computeAth(points, M0 - 100, SUPPLY);
    expect(fields).toEqual({
      athMarketCapUsd: 0.0003 * SUPPLY,
      athAt: M0 + 60,
      athPoolAddress: 'Q',
      secondsToAth: 160,
    });
    expect(athPrice).toBe(0.0003);
    expect(flags).toEqual([]);
  });

  it('on equal prices the earliest point is the ATH', () => {
    const { fields } = computeAth(
      [pt(M0 + 60, 5), pt(M0, 5, true, { poolAddress: 'Q' })],
      M0,
      SUPPLY,
    );
    expect(fields.athAt).toBe(M0);
    expect(fields.athPoolAddress).toBe('Q');
  });

  it('hourly and daily points never set the ATH', () => {
    const { fields } = computeAth(
      [
        pt(M0, 1),
        pt(M0 + 3_600, 50, true, { resolution: '1h' }),
        pt(DAY + 86_400, 90, true, { resolution: '1d' }),
      ],
      M0,
      SUPPLY,
    );
    expect(fields.athMarketCapUsd).toBe(1 * SUPPLY);
  });

  it('keeps a negative secondsToAth and raises ath_before_launch', () => {
    const { fields, flags } = computeAth([pt(M0, 1)], M0 + 50, SUPPLY);
    expect(fields.secondsToAth).toBe(-50);
    expect(flags).toEqual(['ath_before_launch']);
  });

  it('no strict 1-minute point: all four null and no_qualifying_window', () => {
    const { fields, athPrice, flags } = computeAth(
      [pt(M0, 1, false), pt(M0 + 3_600, 2, true, { resolution: '1h' })],
      M0,
      SUPPLY,
    );
    expect(fields).toEqual({
      athMarketCapUsd: null,
      athAt: null,
      athPoolAddress: null,
      secondsToAth: null,
    });
    expect(athPrice).toBeNull();
    expect(flags).toEqual(['no_qualifying_window']);
  });

  it('wick is the highest of o, h, l, c over every bar of every resolution and pool', () => {
    // Pool P minute bar: high 0.0004. Pool S hourly bar: high 0.0007 (the wick). Daily: 0.0005.
    const pools: CleanPool[] = [
      {
        address: 'P',
        isPrimary: true,
        bars1m: [bar(M0, 0.0001, { h: 0.0004 })],
        bars1h: [],
        bars1d: [],
      },
      {
        address: 'S',
        isPrimary: false,
        bars1m: [],
        bars1h: [bar(M0 + 3_600, 0.0001, { h: 0.0007 })],
        bars1d: [bar(DAY, 0.0005)],
      },
    ];
    expect(computeWick(pools, SUPPLY)).toEqual({
      athWickMarketCapUsd: 0.0007 * SUPPLY,
      athWickAt: M0 + 3_600,
      athWickPoolAddress: 'S',
    });
  });

  it('wick: the earliest bar wins, and on equal t the smallest address, in either pool order', () => {
    const mk = (address: string, t: number): CleanPool => ({
      address,
      isPrimary: true,
      bars1m: [bar(t, 3)],
      bars1h: [],
      bars1d: [],
    });
    const early = computeWick([mk('B', M0 + 60), mk('Z', M0)], SUPPLY);
    expect(early.athWickAt).toBe(M0);
    expect(computeWick([mk('B', M0), mk('A', M0)], SUPPLY).athWickPoolAddress).toBe('A');
    expect(computeWick([mk('A', M0), mk('B', M0)], SUPPLY).athWickPoolAddress).toBe('A');
  });

  it('wick is null without clean bars', () => {
    expect(computeWick([], SUPPLY)).toEqual({
      athWickMarketCapUsd: null,
      athWickAt: null,
      athWickPoolAddress: null,
    });
  });

  it('peak_outside_minute_coverage: strict coarse point above the ATH, or any while the ATH is null', () => {
    const hourly = (price: number, strict = true) =>
      pt(M0 + 3_600, price, strict, { resolution: '1h' });
    expect(peakOutsideMinuteCoverage([pt(M0, 1), hourly(2)], 1)).toBe(true);
    // The flag reads the bar's high, not its close: a spike that collapsed inside the hour counts.
    const spike = (high: number, over: Partial<CoinPoint> = {}) =>
      pt(M0 + 3_600, 0.001, true, { resolution: '1h', high, ...over });
    expect(peakOutsideMinuteCoverage([pt(M0, 1), spike(4)], 1)).toBe(true);
    expect(peakOutsideMinuteCoverage([pt(M0, 1), spike(1)], 1)).toBe(false);
    expect(peakOutsideMinuteCoverage([pt(M0, 1), spike(4, { strict: false })], 1)).toBe(false);
    expect(peakOutsideMinuteCoverage([pt(M0, 1), spike(4, { resolution: '1d' })], 1)).toBe(true);
    expect(peakOutsideMinuteCoverage([pt(M0, 1), spike(0.5, { resolution: '1d' })], 1)).toBe(false);
    expect(peakOutsideMinuteCoverage([pt(M0, 1), hourly(1)], 1)).toBe(false); // equal is not above
    expect(peakOutsideMinuteCoverage([pt(M0, 1), hourly(2, false)], 1)).toBe(false); // not strict
    expect(peakOutsideMinuteCoverage([hourly(0.1)], null)).toBe(true);
    expect(peakOutsideMinuteCoverage([pt(M0, 1, false)], null)).toBe(false);
    expect(peakOutsideMinuteCoverage([pt(DAY, 9, true, { resolution: '1d' })], 1)).toBe(true);
  });
});

describe('section 7: the level series', () => {
  it('only non-strict points can lower the level; leading non-strict points do nothing', () => {
    // t0 not strict 9 (level undefined: nothing)
    // t1 strict 5 -> level 5
    // t2 not strict 7 -> above the level, level stays 5
    // t3 not strict 3 -> lowers, level 3
    // t4 not strict 4 -> not below 3, level stays 3
    // t5 strict 4 -> sets, level 4
    // t6 strict 8 -> sets, level 8
    const series = buildLevelSeries([
      pt(0, 9, false),
      pt(60, 5),
      pt(120, 7, false),
      pt(180, 3, false),
      pt(240, 4, false),
      pt(300, 4),
      pt(360, 8),
    ]);
    expect(series).toEqual([
      { t: 60, level: 5 },
      { t: 120, level: 5 },
      { t: 180, level: 3 },
      { t: 240, level: 3 },
      { t: 300, level: 4 },
      { t: 360, level: 8 },
    ]);
  });

  it('is empty when no point is strict', () => {
    expect(buildLevelSeries([pt(0, 1, false), pt(60, 2, false)])).toEqual([]);
  });
});

describe('section 8: time above', () => {
  const L = (t: number, level: number): LevelPoint => ({ t, level });

  it('each point holds until the next, the last until asOf', () => {
    // Holds: 100 until next, 400 until asOf (t=500).
    expect(holdSeconds([L(0, 1), L(100, 1)], 500, 86_400)).toEqual([100, 400]);
  });

  it('caps a hold at 24 hours, between points and at the end', () => {
    const day = 86_400;
    expect(holdSeconds([L(0, 1), L(5 * day, 1)], 7 * day, day)).toEqual([day, day]);
    expect(holdSeconds([L(0, 1)], 3 * day, 100)).toEqual([100]);
  });

  it('the last hold ends at asOf and is never negative', () => {
    expect(holdSeconds([L(1_000, 1)], 1_250, 86_400)).toEqual([250]);
    expect(holdSeconds([L(1_000, 1)], 900, 86_400)).toEqual([0]);
  });

  it('threshold comparison is inclusive: exactly $100,000 counts', () => {
    // Level 0.0001 * 1e9 = 100,000. Level 0.00009999 * 1e9 = 99,990.
    const series = [L(0, 0.0001), L(100, 0.00009999)];
    expect(secondsAbove(series, [100_000, 1_000_000], SUPPLY, 300, 86_400)).toEqual([100, 0]);
  });

  it('sums the holds of every level point at or above each threshold, in threshold order', () => {
    // Levels: $150k for 100s, $2M for 200s, $50k for 50s (until asOf 350).
    const series = [L(0, 0.00015), L(100, 0.002), L(300, 0.00005)];
    expect(
      secondsAbove(series, [100_000, 1_000_000, 10_000_000, 100_000_000], SUPPLY, 350, 86_400),
    ).toEqual([300, 200, 0, 0]);
    expect(secondsAbove(series, [1_000_000, 100_000], SUPPLY, 350, 86_400)).toEqual([200, 300]);
  });

  it('is all zeros without a level series', () => {
    expect(secondsAbove([], [1, 2, 3], SUPPLY, 100, 86_400)).toEqual([0, 0, 0]);
  });
});

describe('section 9: max drawdown', () => {
  const L = (t: number, level: number): LevelPoint => ({ t, level });

  it('largest fall from the running peak, as a percentage', () => {
    // Levels 10, 20, 5, 15: peak 20, low 5 -> (20 - 5) / 20 = 75%. The rise to 15 does not matter.
    expect(maxDrawdownPct([L(0, 10), L(1, 20), L(2, 5), L(3, 15)])).toBeCloseTo(75, 10);
  });

  it('uses the peak so far, not the global peak', () => {
    // 10, 5 (50% down), then 100: the fall happened before the peak of 100.
    expect(maxDrawdownPct([L(0, 10), L(1, 5), L(2, 100)])).toBeCloseTo(50, 10);
  });

  it('is 0 when the level never falls, null with no level points', () => {
    expect(maxDrawdownPct([L(0, 1), L(1, 1), L(2, 2)])).toBe(0);
    expect(maxDrawdownPct([])).toBeNull();
  });
});

describe('section 10: rug pattern', () => {
  const params = DEFAULT_METRIC_PARAMS;
  const A = M0;
  const athPrice = 0.001; // $1M

  it('crash point: after athAt, within the window, at or below 20% of ATH; earliest wins', () => {
    const series: LevelPoint[] = [
      { t: A, level: 0.001 },
      { t: A + 60, level: 0.0005 },
      { t: A + 120, level: 0.0002 },
      { t: A + 180, level: 0.0001 },
    ];
    expect(findCrashPoint(series, A, athPrice, params)).toEqual({ t: A + 120, level: 0.0002 });
  });

  it('crash window is inclusive at athAt + rugWithinSec and excludes athAt itself', () => {
    expect(findCrashPoint([{ t: A + 1_800, level: 0.0001 }], A, athPrice, params)).not.toBeNull();
    expect(findCrashPoint([{ t: A + 1_801, level: 0.0001 }], A, athPrice, params)).toBeNull();
    expect(findCrashPoint([{ t: A, level: 0.0001 }], A, athPrice, params)).toBeNull();
  });

  it('a level just above the limit is not a crash', () => {
    expect(findCrashPoint([{ t: A + 60, level: 0.00021 }], A, athPrice, params)).toBeNull();
  });

  it('is false without an ATH', () => {
    expect(rugPattern({ athAt: null, athPrice: null }, [], [], params)).toBe(false);
  });

  it('true when crashed and never recovered; a strict point exactly at 50% cancels it', () => {
    const series: LevelPoint[] = [{ t: A + 60, level: 0.0001 }];
    const ath = { athAt: A, athPrice };
    const crashPoint = pt(A + 60, 0.0001);
    // The crash point itself is not "after" the crash point: true.
    expect(rugPattern(ath, series, [crashPoint], params)).toBe(true);
    // Recovery to exactly 50% of ATH ($500k) by a strict point after the crash: false.
    expect(rugPattern(ath, series, [crashPoint, pt(A + 120, 0.0005)], params)).toBe(false);
    // Just below 50%: still a rug.
    expect(rugPattern(ath, series, [crashPoint, pt(A + 120, 0.00049)], params)).toBe(true);
    // A recovery that is not strict does not count.
    expect(rugPattern(ath, series, [crashPoint, pt(A + 120, 0.0009, false)], params)).toBe(true);
    // A strict hourly point counts, at any resolution.
    expect(
      rugPattern(
        ath,
        series,
        [crashPoint, pt(A + 3_600, 0.0006, true, { resolution: '1h' })],
        params,
      ),
    ).toBe(false);
  });

  it('an exact 80% drop is a crash despite binary floating point', () => {
    // (1 - 0.8) * 0.001 is not exactly 0.0002 in floating point; the rule is inclusive.
    expect(findCrashPoint([{ t: A + 60, level: 0.0002 }], A, athPrice, params)).not.toBeNull();
  });

  it('non-default rug parameters', () => {
    const series: LevelPoint[] = [{ t: A + 60, level: 0.0005 }];
    const ath = { athAt: A, athPrice };
    const points = [pt(A + 60, 0.0005)];
    expect(rugPattern(ath, series, points, params)).toBe(false); // only a 50% fall
    expect(rugPattern(ath, series, points, { ...params, rugDropPct: 50 })).toBe(true);
    expect(
      rugPattern(ath, [{ t: A + 100, level: 0.0001 }], points, { ...params, rugWithinSec: 99 }),
    ).toBe(false);
    const recovery = [...points, pt(A + 120, 0.0003)];
    expect(
      rugPattern(ath, series, recovery, { ...params, rugDropPct: 50, rugRecoveryFraction: 0.3 }),
    ).toBe(false);
  });
});
