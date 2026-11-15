import { describe, expect, it } from 'vitest';
import { decideStatus, STATUS_RULES, type MetricPoolInput } from '../src/coinMetrics.js';
import type { CandleBar } from '../src/candles.js';

const DAY = 86_400;
const HOUR = 3_600;
const T0 = 1_767_225_600;

const bar = (t: number, volumeUsd: number, liquidityUsd: number | null): CandleBar => ({
  t,
  o: 0.001,
  h: 0.001,
  l: 0.001,
  c: 0.001,
  volumeUsd,
  trades: 5,
  traders: 3,
  liquidityUsd,
});

const pool = (over: Partial<MetricPoolInput> = {}): MetricPoolInput => ({
  address: 'P',
  dex: 'PumpSwap',
  isPrimary: true,
  bars1m: [],
  bars1h: [],
  bars1d: [],
  ...over,
});

const calm = { rugPattern: false };

describe('decideStatus (plan Q3)', () => {
  it('has the Q3 numbers', () => {
    expect(STATUS_RULES).toEqual({
      minVolume24hUsd: 1_000,
      minLiquidityUsd: 5_000,
      deadAfterDays: 7,
    });
  });

  it('is rugged whenever the rug pattern is set, before anything else', () => {
    const asOf = T0 + 30 * DAY;
    const lively = pool({ bars1h: [bar(asOf - HOUR, 50_000, 90_000)] });
    expect(decideStatus({ pools: [lively], asOf }, { rugPattern: true })).toBe('rugged');
  });

  it('is unknown with no stored bars', () => {
    expect(decideStatus({ pools: [pool()], asOf: T0 + DAY }, calm)).toBe('unknown');
    expect(decideStatus({ pools: [], asOf: T0 + DAY }, calm)).toBe('unknown');
  });

  it('is alive with $1,000 of volume in 24 hours and $5,000 of liquidity, both inclusive', () => {
    const asOf = T0 + 30 * DAY;
    const mk = (volume: number, liq: number) =>
      decideStatus({ pools: [pool({ bars1h: [bar(asOf - 2 * HOUR, volume, liq)] })], asOf }, calm);
    expect(mk(1_000, 5_000)).toBe('alive');
    expect(mk(999.99, 5_000)).not.toBe('alive');
    expect(mk(1_000, 4_999.99)).not.toBe('alive');
  });

  it('counts volume over the 24 hours before asOf only', () => {
    const asOf = T0 + 30 * DAY;
    const old = pool({
      bars1h: [
        bar(asOf - 8 * DAY, 9_000, 20_000),
        bar(asOf - 23 * HOUR, 400, 20_000),
        bar(asOf - HOUR, 400, 20_000),
      ],
    });
    // 800 inside the window; the 9,000 bar is 8 days back, outside the last 7 days' windows.
    expect(decideStatus({ pools: [old], asOf }, calm)).not.toBe('alive');
    const enough = pool({
      bars1h: [
        bar(asOf - 8 * DAY, 9_000, 20_000),
        bar(asOf - 23 * HOUR, 600, 20_000),
        bar(asOf - HOUR, 400, 20_000),
      ],
    });
    expect(decideStatus({ pools: [enough], asOf }, calm)).toBe('alive');
  });

  it('is dead after 7 days below the line, with bars from at least 7 days back', () => {
    const asOf = T0 + 60 * DAY;
    // Traded on day 1 only, liquidity stays high, nothing since.
    const dead = pool({ bars1h: [bar(T0 + DAY, 80_000, 60_000)] });
    expect(decideStatus({ pools: [dead], asOf }, calm)).toBe('dead');
  });

  it('is alive when the line was met on any of the last 7 days, and dead only after 7 days below it', () => {
    const asOf = T0 + 60 * DAY;
    const quiet = pool({ bars1h: [bar(asOf - 3 * DAY, 80_000, 60_000)] });
    expect(decideStatus({ pools: [quiet], asOf }, calm)).toBe('alive');
    // The last bar is 6.5 days back: the line was met at the end of the day 6 days ago.
    const edge = pool({ bars1h: [bar(asOf - 6 * DAY - 12 * HOUR, 80_000, 60_000)] });
    expect(decideStatus({ pools: [edge], asOf }, calm)).toBe('alive');
    // 7 days and an hour back: below the line on each of the last 7 days.
    const gone = pool({ bars1h: [bar(asOf - 7 * DAY - HOUR, 80_000, 60_000)] });
    expect(decideStatus({ pools: [gone], asOf }, calm)).toBe('dead');
    const dead = pool({ bars1h: [bar(asOf - 8 * DAY, 80_000, 60_000)] });
    expect(decideStatus({ pools: [dead], asOf }, calm)).toBe('dead');
  });

  it('is unknown for a coin younger than 7 days that never met the line, alive if it did', () => {
    const asOf = T0 + 3 * DAY;
    const young = pool({ bars1h: [bar(T0 + HOUR, 80_000, 1_000)] });
    expect(decideStatus({ pools: [young], asOf }, calm)).toBe('unknown');
    const metIt = pool({ bars1h: [bar(T0 + HOUR, 80_000, 60_000)] });
    expect(decideStatus({ pools: [metIt], asOf }, calm)).toBe('alive');
  });

  it('is dead when liquidity is under the line even with volume', () => {
    const asOf = T0 + 60 * DAY;
    const drained = pool({ bars1h: [bar(T0, 100, 60_000), bar(asOf - HOUR, 90_000, 1_000)] });
    expect(decideStatus({ pools: [drained], asOf }, calm)).toBe('dead');
  });

  it('counts another pool only on bars with enough liquidity', () => {
    const asOf = T0 + 60 * DAY;
    const main = pool({ bars1h: [bar(asOf - HOUR, 10, 20_000)] });
    const dust = pool({
      address: 'D',
      isPrimary: false,
      bars1h: [bar(asOf - HOUR, 50_000, 300)],
    });
    expect(decideStatus({ pools: [main, dust], asOf }, calm)).not.toBe('alive');
    const real = pool({
      address: 'R',
      isPrimary: false,
      bars1h: [bar(asOf - HOUR, 50_000, 8_000)],
    });
    expect(decideStatus({ pools: [main, real], asOf }, calm)).toBe('alive');
  });

  it('reads 1-minute bars when a pool has no hourly bars, and liquidity from any resolution', () => {
    const asOf = T0 + 60 * DAY;
    const p = pool({
      bars1m: [bar(asOf - 60, 2_000, null)],
      bars1d: [bar(T0 + 59 * DAY, 1, 9_000)],
    });
    expect(decideStatus({ pools: [p], asOf }, calm)).toBe('alive');
  });

  it('ignores bars after asOf', () => {
    const asOf = T0 + 60 * DAY;
    const p = pool({ bars1h: [bar(T0 + DAY, 80_000, 60_000), bar(asOf + HOUR, 80_000, 60_000)] });
    expect(decideStatus({ pools: [p], asOf }, calm)).toBe('dead');
  });

  describe('bars of different resolutions cover different periods', () => {
    const asOf = T0 + 120 * DAY;
    const oldHourly = [
      bar(T0 + 10 * DAY, 90_000, 60_000),
      bar(T0 + 10 * DAY + HOUR, 90_000, 60_000),
    ];
    const recentDaily = (volume: number, liq: number | null) =>
      [0, 1, 2, 3, 4, 5, 6].map((k) => bar(asOf - k * DAY - 12 * HOUR, volume, liq));

    it('hourly bars months ago and daily bars since: $2,000 a day with $10,000 liquidity is alive', () => {
      const p = pool({ bars1h: oldHourly, bars1d: recentDaily(2_000, 10_000) });
      expect(decideStatus({ pools: [p], asOf }, calm)).toBe('alive');
    });

    it('the same with $500 a day is dead', () => {
      const p = pool({ bars1h: oldHourly, bars1d: recentDaily(500, 10_000) });
      expect(decideStatus({ pools: [p], asOf }, calm)).toBe('dead');
    });

    it('hourly and daily bars covering the same day are not added together', () => {
      const p = pool({
        bars1h: [bar(asOf - 5 * HOUR, 300, 10_000), bar(asOf - 6 * HOUR, 300, 10_000)],
        bars1d: [bar(asOf - 12 * HOUR, 600, 10_000)],
      });
      expect(decideStatus({ pools: [p], asOf }, calm)).not.toBe('alive');
      // The largest single resolution counts: 600 hourly would still be under the line, 1,200 is not.
      const q = pool({
        bars1h: [bar(asOf - 5 * HOUR, 700, 10_000), bar(asOf - 6 * HOUR, 700, 10_000)],
        bars1d: [bar(asOf - 12 * HOUR, 600, 10_000)],
      });
      expect(decideStatus({ pools: [q], asOf }, calm)).toBe('alive');
    });

    it("a secondary pool's daily bars count only when they pass the liquidity rule", () => {
      const main = pool({ bars1h: oldHourly, bars1d: recentDaily(10, 20_000) });
      const dust = pool({ address: 'D', isPrimary: false, bars1d: recentDaily(50_000, 300) });
      expect(decideStatus({ pools: [main, dust], asOf }, calm)).toBe('dead');
      const real = pool({ address: 'R', isPrimary: false, bars1d: recentDaily(50_000, 8_000) });
      expect(decideStatus({ pools: [main, real], asOf }, calm)).toBe('alive');
    });
  });
});
