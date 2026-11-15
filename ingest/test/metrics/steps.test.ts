import { describe, expect, it } from 'vitest';
import {
  athHourVolume,
  computeAth,
  computeWick,
  peakOutsideMinuteCoverage,
} from '../../src/metrics/ath.js';
import { maxDrawdownPct } from '../../src/metrics/drawdown.js';
import type { CleanPool, CoinPoint, LevelPoint } from '../../src/metrics/internal.js';
import { buildLevelSeries } from '../../src/metrics/level.js';
import { findCrashPoint, rugPattern } from '../../src/metrics/rug.js';
import { holdSeconds, secondsAbove } from '../../src/metrics/timeAbove.js';
import { DEFAULT_METRIC_PARAMS, type Bar } from '../../src/metrics/types.js';
import { DAY, M0, bar } from './helpers.js';

const SUPPLY = 1_000_000_000;

const pt = (t: number, price: number, strict = true, over: Partial<CoinPoint> = {}): CoinPoint => ({
  t,
  price,
  high: over.high ?? price,
  strict,
  liquidity: null,
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
      athLiquidityUsd: null,
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
      athLiquidityUsd: null,
    });
    expect(athPrice).toBeNull();
    expect(flags).toEqual(['no_qualifying_window']);
  });

  describe('wick', () => {
    const NO_ATH = computeAth([], M0, SUPPLY);
    const W = DEFAULT_METRIC_PARAMS;
    const mkPool = (address: string, bars1m: Bar[], extra: Partial<CleanPool> = {}): CleanPool => ({
      address,
      isPrimary: true,
      bars1m,
      bars1h: [],
      bars1d: [],
      ...extra,
    });
    const wick = (pools: CleanPool[], ath = NO_ATH) => computeWick(pools, ath, W, SUPPLY);
    const athAt = (price: number, t: number, address = 'P') =>
      computeAth([pt(t, price, true, { poolAddress: address })], M0 - 100, SUPPLY);

    it('is the highest max(open, close) of a candidate 1-minute bar; highs and lows do not count', () => {
      const bars = [bar(M0, 0.0001, { h: 0.0009 }), bar(M0 + 60, 0.0002, { o: 0.0003 })];
      expect(wick([mkPool('P', bars)])).toEqual({
        athWickMarketCapUsd: 0.0003 * SUPPLY,
        athWickAt: M0 + 60,
        athWickPoolAddress: 'P',
      });
    });

    it('ignores hourly and daily bars', () => {
      const pools = [
        mkPool('P', [bar(M0, 0.0001)], {
          bars1h: [bar(M0 + 3_600, 0.0007)],
          bars1d: [bar(DAY + 86_400, 0.0009)],
        }),
      ];
      expect(wick(pools).athWickMarketCapUsd).toBe(0.0001 * SUPPLY);
    });

    it('ignores a thin minute: volume or traders under the window minimums', () => {
      const bars = [
        bar(M0, 0.0001),
        bar(M0 + 60, 0.0005, { volumeUsd: 999 }),
        bar(M0 + 120, 0.0006, { traders: 4 }),
      ];
      expect(wick([mkPool('P', bars)]).athWickAt).toBe(M0);
      const exact = [bar(M0, 0.0001), bar(M0 + 60, 0.0005, { volumeUsd: 1_000, traders: 5 })];
      expect(wick([mkPool('P', exact)]).athWickAt).toBe(M0 + 60);
    });

    it('ignores an unfunded minute, but a funded previous bar of the pool funds it', () => {
      const bars = [
        bar(M0, 0.0001, { liquidityUsd: 4_999 }),
        bar(M0 + 60, 0.0005, { liquidityUsd: 4_999 }),
      ];
      expect(wick([mkPool('P', bars)]).athWickAt).toBeNull(); // neither bar is funded
      const drained = [
        bar(M0, 0.0001, { liquidityUsd: 5_000 }),
        bar(M0 + 600, 0.0005, { liquidityUsd: 100 }), // not adjacent: still "previous"
      ];
      expect(wick([mkPool('P', drained)]).athWickAt).toBe(M0 + 600);
      // Unknown liquidity counts as funded.
      expect(wick([mkPool('P', [bar(M0, 0.0001)])]).athWickAt).toBe(M0);
    });

    it('is the ATH when the ATH is higher, or when there is no candidate', () => {
      const bars = [bar(M0, 0.0001)];
      const high = athAt(0.0003, M0 + 120, 'Q');
      expect(wick([mkPool('P', bars)], high)).toEqual({
        athWickMarketCapUsd: 0.0003 * SUPPLY,
        athWickAt: M0 + 120,
        athWickPoolAddress: 'Q',
      });
      const thin = [bar(M0, 0.0009, { volumeUsd: 5 })];
      expect(wick([mkPool('P', thin)], high).athWickAt).toBe(M0 + 120);
    });

    it('stays on the candidate bar when the ATH price is equal', () => {
      const tied = athAt(0.0001, M0 + 120, 'Q');
      expect(wick([mkPool('P', [bar(M0, 0.0001)])], tied)).toMatchObject({
        athWickAt: M0,
        athWickPoolAddress: 'P',
      });
    });

    it('the earliest bar wins, and on equal t the smallest address, in either pool order', () => {
      const mk = (address: string, t: number): CleanPool => mkPool(address, [bar(t, 3)]);
      expect(wick([mk('B', M0 + 60), mk('Z', M0)]).athWickAt).toBe(M0);
      expect(wick([mk('B', M0), mk('A', M0)]).athWickPoolAddress).toBe('A');
      expect(wick([mk('A', M0), mk('B', M0)]).athWickPoolAddress).toBe('A');
    });

    it('is null only with neither a candidate nor an ATH', () => {
      expect(wick([])).toEqual({
        athWickMarketCapUsd: null,
        athWickAt: null,
        athWickPoolAddress: null,
      });
    });
  });

  it('athHourVolume sums 1-minute volume of every pool in (athAt - 3600, athAt]', () => {
    const a = [bar(M0 - 60, 1, { volumeUsd: 7 }), bar(M0, 1, { volumeUsd: 10 })];
    const b = [bar(M0 + 3_600, 1, { volumeUsd: 20 }), bar(M0 + 3_660, 1, { volumeUsd: 99 })];
    const pools: CleanPool[] = [
      { address: 'P', isPrimary: true, bars1m: a, bars1h: [], bars1d: [] },
      { address: 'Q', isPrimary: true, bars1m: b, bars1h: [bar(M0 + 3_600, 1)], bars1d: [] },
    ];
    // At M0 + 3,600 the window is (M0, M0 + 3,600]: P's M0 bar is out, Q's bar at the end is in.
    expect(athHourVolume(pools, M0 + 3_600)).toBe(20);
    expect(athHourVolume(pools, M0)).toBe(17); // (M0 - 3,600, M0]
    expect(athHourVolume(pools, null)).toBeNull();
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
