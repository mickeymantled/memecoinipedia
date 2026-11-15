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
        bar(asOf - 25 * HOUR, 9_000, 20_000),
        bar(asOf - 23 * HOUR, 400, 20_000),
        bar(asOf - HOUR, 400, 20_000),
      ],
    });
    // 800 inside the window; the 9,000 bar is too old.
    expect(decideStatus({ pools: [old], asOf }, calm)).not.toBe('alive');
    const enough = pool({
      bars1h: [
        bar(asOf - 25 * HOUR, 9_000, 20_000),
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

  it('is unknown, not dead, when the coin went quiet less than 7 days ago', () => {
    const asOf = T0 + 60 * DAY;
    const quiet = pool({ bars1h: [bar(asOf - 3 * DAY, 80_000, 60_000)] });
    expect(decideStatus({ pools: [quiet], asOf }, calm)).toBe('unknown');
    // Exactly 7 days: alive at the end of day asOf - 6d? The last bar is 6.5 days back, so yes.
    const edge = pool({ bars1h: [bar(asOf - 6 * DAY - 12 * HOUR, 80_000, 60_000)] });
    expect(decideStatus({ pools: [edge], asOf }, calm)).toBe('unknown');
    const dead = pool({ bars1h: [bar(asOf - 8 * DAY, 80_000, 60_000)] });
    expect(decideStatus({ pools: [dead], asOf }, calm)).toBe('dead');
  });

  it('is unknown for a coin younger than 7 days that is not alive', () => {
    const asOf = T0 + 3 * DAY;
    const young = pool({ bars1h: [bar(T0 + HOUR, 80_000, 60_000)] });
    expect(decideStatus({ pools: [young], asOf }, calm)).toBe('unknown');
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
});
