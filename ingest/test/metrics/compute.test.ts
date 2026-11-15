import { describe, expect, it } from 'vitest';
import { DEFAULT_METRIC_PARAMS, computeCoinMetrics } from '../../src/metrics/index.js';
import { DAY, M0, bar, input, minuteBars, pool } from './helpers.js';

const SUPPLY = 1_000_000_000;

/** Bars that make every window strict: 2,000 USD and 10 wallets a minute. */
const busy = { volumeUsd: 2_000, traders: 10 };

describe('computeCoinMetrics, worked examples', () => {
  it('full 3-bar window', () => {
    // Bars at M0, +60, +120: closes 0.0001, 0.0002, 0.00015; volume 400 each; traders 5.
    // Window at M0: one bar, not strict, level undefined. At +60: closes .0001/.0002 -> .0001,
    // volume 800 < 1000, not strict. At +120: median .00015, volume 1200, traders 5: strict.
    // ATH = .00015 * 1e9 = 150,000 at M0+120; launchedAt = M0-600 -> 720 s.
    // Wick = highest high = .0002 -> 200,000 at M0+60.
    // Level: only the point at M0+120 (150k) holds until asOf = M0+3600: 3480 s above $100k.
    const bars = [
      bar(M0, 0.0001, { volumeUsd: 400 }),
      bar(M0 + 60, 0.0002, { volumeUsd: 400 }),
      bar(M0 + 120, 0.00015, { volumeUsd: 400 }),
    ];
    const result = computeCoinMetrics(input([pool({ bars1m: bars })]));
    expect(result.athMarketCapUsd).toBeCloseTo(150_000, 6);
    expect(result).toMatchObject({
      athAt: M0 + 120,
      athPoolAddress: 'P',
      secondsToAth: 720,
      athWickAt: M0 + 60,
      athWickPoolAddress: 'P',
      secondsAbove: [3_480, 0, 0, 0],
      maxDrawdownPct: 0,
      rugPattern: false,
      flags: [],
    });
    expect(result.athWickMarketCapUsd).toBeCloseTo(200_000, 6);
  });

  it('a coin with no clean bars at all', () => {
    const result = computeCoinMetrics(input([pool()]));
    expect(result).toEqual({
      athMarketCapUsd: null,
      athAt: null,
      athPoolAddress: null,
      secondsToAth: null,
      athWickMarketCapUsd: null,
      athWickAt: null,
      athWickPoolAddress: null,
      secondsAbove: [0, 0, 0, 0],
      maxDrawdownPct: null,
      rugPattern: false,
      flags: ['no_qualifying_window'],
    });
    expect(computeCoinMetrics(input([])).flags).toEqual(['no_qualifying_window']);
  });

  it('ignores bars after asOf entirely', () => {
    const bars = [...minuteBars(M0, [0.0001, 0.0001], busy), bar(M0 + 3_660, 0.01, busy)];
    const withLate = computeCoinMetrics(input([pool({ bars1m: bars })]));
    const without = computeCoinMetrics(input([pool({ bars1m: bars.slice(0, 2) })]));
    expect(withLate).toEqual(without);
    expect(withLate.flags).toEqual([]);
  });

  it('duplicate t: the last bar wins and the flag is raised', () => {
    // Without the dedupe the first bar's high of 0.0009 would be the wick.
    const bars = [
      bar(M0, 0.0001, { ...busy, h: 0.0009 }),
      bar(M0, 0.0002, busy),
      bar(M0 + 60, 0.0002, busy),
    ];
    const result = computeCoinMetrics(input([pool({ bars1m: bars })]));
    expect(result.athWickMarketCapUsd).toBeCloseTo(200_000, 6);
    expect(result.flags).toEqual(['duplicate_bar']);
  });

  it('flags come out alphabetically, each once', () => {
    const bars = [
      bar(M0, 0.0001, { ...busy, o: 0 }),
      bar(M0 + 60, 30, busy),
      bar(M0 + 120, 0.0001, busy),
      bar(M0 + 120, 0.0001, busy),
    ];
    const result = computeCoinMetrics(input([pool({ bars1m: bars })]));
    expect(result.flags).toEqual([
      'bad_bar',
      'duplicate_bar',
      'implausible_market_cap',
      'no_qualifying_window',
    ]);
  });

  it('ath_before_launch keeps the negative number', () => {
    const result = computeCoinMetrics(
      input([pool({ bars1m: minuteBars(M0, [0.0001, 0.0001], busy) })], { launchedAt: M0 + 600 }),
    );
    expect(result.secondsToAth).toBe(-540);
    expect(result.flags).toEqual(['ath_before_launch']);
  });

  it('busiest pool, not the highest price, sets the point; a thin secondary cannot', () => {
    // P (primary): closes .0001 x2, volume 600 each. S (secondary): closes .0003 x2, volume 900 each.
    // At M0+60 S has the bigger window (1800 vs 1200), so ATH = .0003 -> $300k from S.
    const p = pool({ bars1m: minuteBars(M0, [0.0001, 0.0001], { volumeUsd: 600 }) });
    const s = (liquidityUsd: number | null) =>
      pool({
        address: 'S',
        isPrimary: false,
        bars1m: minuteBars(M0, [0.0003, 0.0003], { volumeUsd: 900, liquidityUsd }),
      });
    const busier = computeCoinMetrics(input([p, s(10_000)]));
    expect(busier.athPoolAddress).toBe('S');
    expect(busier.athMarketCapUsd).toBeCloseTo(300_000, 6);
    // Exactly the liquidity floor still counts.
    expect(computeCoinMetrics(input([p, s(5_000)])).athPoolAddress).toBe('S');
    // Below the floor and null liquidity: the pool is gone, P decides, and the wick ignores S too.
    for (const liq of [4_999, null]) {
      const result = computeCoinMetrics(input([p, s(liq)]));
      expect(result.athPoolAddress).toBe('P');
      expect(result.athMarketCapUsd).toBeCloseTo(100_000, 6);
      expect(result.athWickPoolAddress).toBe('P');
    }
  });

  it('busiest pool ties: primary beats secondary, then the smaller address', () => {
    const mk = (address: string, isPrimary: boolean, c: number) =>
      pool({
        address,
        isPrimary,
        bars1m: minuteBars(M0, [c, c], { ...busy, liquidityUsd: 9_000 }),
      });
    // Equal volume in each pool: the primary one ('Z') wins at both timestamps despite its address.
    expect(
      computeCoinMetrics(input([mk('A', false, 0.0003), mk('Z', true, 0.0001)])).athPoolAddress,
    ).toBe('Z');
    // Two secondaries, equal volume: 'A' wins whatever the order.
    expect(
      computeCoinMetrics(input([mk('B', false, 0.0003), mk('A', false, 0.0001)])).athPoolAddress,
    ).toBe('A');
    expect(
      computeCoinMetrics(input([mk('A', false, 0.0001), mk('B', false, 0.0003)])).athPoolAddress,
    ).toBe('A');
  });

  it('hourly bar with finer data in its hour is not a window, but still sets the wick', () => {
    const hour = bar(M0, 0.0001, { ...busy, h: 0.01 });
    const result = computeCoinMetrics(
      input([pool({ bars1m: minuteBars(M0 + 600, [0.0001, 0.0001], busy), bars1h: [hour] })]),
    );
    expect(result.athMarketCapUsd).toBeCloseTo(100_000, 6);
    expect(result.athWickMarketCapUsd).toBeCloseTo(10_000_000, 4);
    expect(result.athWickAt).toBe(M0);
    expect(result.flags).toEqual([]); // the hourly bar is not a coin point, so no coverage flag
  });

  it('daily bar with finer data in its day is not a window', () => {
    const dayBar = bar(DAY, 0.0005, busy);
    const result = computeCoinMetrics(
      input([pool({ bars1m: minuteBars(M0, [0.0001, 0.0001], busy), bars1d: [dayBar] })]),
    );
    expect(result.flags).toEqual([]);
    expect(result.athWickMarketCapUsd).toBeCloseTo(500_000, 6);
  });

  it('peak_outside_minute_coverage: strict hourly point above the minute ATH', () => {
    // Minute ATH $100k at M0+60. Hourly bar in a different hour closes at .0005 (strict).
    const bars1h = [bar(M0 + 7_200, 0.0005, busy)];
    const result = computeCoinMetrics(
      input([pool({ bars1m: minuteBars(M0, [0.0001, 0.0001], busy), bars1h })], {
        asOf: M0 + 14_400,
      }),
    );
    expect(result.athMarketCapUsd).toBeCloseTo(100_000, 6); // hourly never sets the ATH
    expect(result.flags).toEqual(['peak_outside_minute_coverage']);
    // A lower hourly point raises no flag.
    const lower = computeCoinMetrics(
      input(
        [
          pool({
            bars1m: minuteBars(M0, [0.0001, 0.0001], busy),
            bars1h: [bar(M0 + 7_200, 0.00005, busy)],
          }),
        ],
        { asOf: M0 + 14_400 },
      ),
    );
    expect(lower.flags).toEqual([]);
  });

  it('only hourly data: ATH null, flags both, level still drives time above', () => {
    // Strict hourly point at M0 closing .0005 ($500k). asOf = M0 + 7200: hold 7200 s.
    const result = computeCoinMetrics(
      input([pool({ bars1h: [bar(M0, 0.0005, busy)] })], { asOf: M0 + 7_200 }),
    );
    expect(result.athMarketCapUsd).toBeNull();
    expect(result.flags).toEqual(['no_qualifying_window', 'peak_outside_minute_coverage']);
    expect(result.athWickMarketCapUsd).toBeCloseTo(500_000, 6);
    expect(result.secondsAbove).toEqual([7_200, 0, 0, 0]);
    expect(result.maxDrawdownPct).toBe(0);
    expect(result.rugPattern).toBe(false);
  });

  it('a hold is capped at 24 hours, and the last hold ends at asOf', () => {
    // Strict point at M0+60 (level $200k). asOf three days later: capped at 86,400.
    const bars = minuteBars(M0, [0.0002, 0.0002], busy);
    const long = computeCoinMetrics(
      input([pool({ bars1m: bars })], { asOf: M0 + 60 + 3 * 86_400 }),
    );
    expect(long.secondsAbove).toEqual([86_400, 0, 0, 0]);
    const short = computeCoinMetrics(input([pool({ bars1m: bars })], { asOf: M0 + 60 + 500 }));
    expect(short.secondsAbove).toEqual([500, 0, 0, 0]);
  });

  it('a thin low trade lowers the level and ends time above; a thin high one does not raise it', () => {
    // Strict at M0+60, level $200k. A lone bar at M0+600 closing $50k (thin: one bar) lowers the level.
    // Holds: M0+60 -> M0+600 = 540 s above $100k; then $50k until asOf, not above.
    // The lone bar at M0+1200 closing $900k does not raise the level (not strict).
    const bars = [
      ...minuteBars(M0, [0.0002, 0.0002], busy),
      bar(M0 + 600, 0.00005, { volumeUsd: 1, traders: 1 }),
      bar(M0 + 1_200, 0.0009, { volumeUsd: 1, traders: 1 }),
    ];
    const result = computeCoinMetrics(input([pool({ bars1m: bars })]));
    expect(result.secondsAbove).toEqual([540, 0, 0, 0]);
    expect(result.athMarketCapUsd).toBeCloseTo(200_000, 6);
    expect(result.athWickMarketCapUsd).toBeCloseTo(900_000, 6);
    // Drawdown: levels .0002 (M0+60), .00005 (M0+600), .00005 (M0+1200) -> 75%.
    expect(result.maxDrawdownPct).toBeCloseTo(75, 9);
  });

  describe('rug pattern', () => {
    // ATH $1M at A = M0 + 60 (two strict-priced busy minutes at .001).
    const A = M0 + 60;
    const base = minuteBars(M0, [0.001, 0.001], busy);
    const run = (extra: ReturnType<typeof minuteBars>) =>
      computeCoinMetrics(input([pool({ bars1m: [...base, ...extra] })], { asOf: M0 + 7_200 }));

    it('true: fast fall to 10% and no recovery', () => {
      // Busy closes .0001 at A+60 and A+120. Window at A+60: closes .001,.001,.0001 -> .001.
      // Window at A+120: .001,.0001,.0001 -> .0001 strict: level $100k, crash within 1800 s.
      const result = run(minuteBars(A + 60, [0.0001, 0.0001], busy));
      expect(result.athAt).toBe(A);
      expect(result.rugPattern).toBe(true);
      expect(result.maxDrawdownPct).toBeCloseTo(90, 9);
    });

    it('cancelled by a strict recovery to 50% of ATH', () => {
      // Then .0006 at A+180 and A+240: window at A+240 median .0006 >= .0005, strict.
      const result = run(minuteBars(A + 60, [0.0001, 0.0001, 0.0006, 0.0006], busy));
      expect(result.rugPattern).toBe(false);
    });

    it('too slow: the first low bar is more than 1800 s after the ATH', () => {
      const result = run([bar(A + 1_860, 0.0001, busy)]);
      expect(result.rugPattern).toBe(false);
    });

    it('a lone thin low bar exactly 1800 s after the ATH is a crash (inclusive; thin bars can lower the level)', () => {
      const result = run([bar(A + 1_800, 0.0001, { volumeUsd: 1, traders: 1 })]);
      expect(result.rugPattern).toBe(true);
    });

    it('an exact 80% fall counts', () => {
      const result = run([bar(A + 180, 0.0002, { volumeUsd: 1, traders: 1 })]);
      expect(result.rugPattern).toBe(true);
    });

    it('non-default drop percentage', () => {
      const extra = [bar(A + 180, 0.0005, { volumeUsd: 1, traders: 1 })];
      expect(run(extra).rugPattern).toBe(false);
      const result = computeCoinMetrics(
        input([pool({ bars1m: [...base, ...extra] })], { asOf: M0 + 7_200 }),
        { rugDropPct: 50 },
      );
      expect(result.rugPattern).toBe(true);
    });
  });

  it('peak: exact thresholds and non-default thresholds', () => {
    const bars = minuteBars(M0, [0.0001, 0.0001], busy); // exactly $100,000
    const asOf = M0 + 60 + 600;
    expect(computeCoinMetrics(input([pool({ bars1m: bars })], { asOf })).secondsAbove).toEqual([
      600, 0, 0, 0,
    ]);
    const custom = computeCoinMetrics(input([pool({ bars1m: bars })], { asOf }), {
      thresholdsUsd: [50_000, 100_000, 100_001],
    });
    expect(custom.secondsAbove).toEqual([600, 600, 0]);
  });

  it('non-default windowMinutes changes which windows are strict', () => {
    // Two busy bars 4 minutes apart: a 3-minute window sees one bar, a 5-minute window sees both.
    const bars = [bar(M0, 0.0001, busy), bar(M0 + 240, 0.0001, busy)];
    expect(computeCoinMetrics(input([pool({ bars1m: bars })])).athMarketCapUsd).toBeNull();
    const wide = computeCoinMetrics(input([pool({ bars1m: bars })]), { windowMinutes: 5 });
    expect(wide.athMarketCapUsd).toBeCloseTo(100_000, 6);
  });

  it('non-default liquidity, volume and traders thresholds', () => {
    const thin = pool({
      address: 'S',
      isPrimary: false,
      bars1m: minuteBars(M0, [0.0001, 0.0001], { volumeUsd: 50, traders: 2, liquidityUsd: 100 }),
    });
    expect(computeCoinMetrics(input([thin])).athMarketCapUsd).toBeNull();
    const result = computeCoinMetrics(input([thin]), {
      minSecondaryPoolLiquidityUsd: 100,
      minWindowVolumeUsd: 100,
      minWindowTraders: 2,
    });
    expect(result.athMarketCapUsd).toBeCloseTo(100_000, 6);
  });

  it('merges partial params over the defaults and keeps the default for undefined', () => {
    const bars = minuteBars(M0, [0.0001, 0.0001], busy);
    const a = computeCoinMetrics(input([pool({ bars1m: bars })]));
    const b = computeCoinMetrics(input([pool({ bars1m: bars })]), {
      windowMinutes: undefined,
    });
    const c = computeCoinMetrics(input([pool({ bars1m: bars })]), DEFAULT_METRIC_PARAMS);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(a.secondsAbove).toHaveLength(DEFAULT_METRIC_PARAMS.thresholdsUsd.length);
    expect(a.athMarketCapUsd).toBeCloseTo(100_000, 6);
    expect(SUPPLY).toBe(1_000_000_000);
  });
});
