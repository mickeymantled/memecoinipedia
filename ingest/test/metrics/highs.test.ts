import { describe, expect, it } from 'vitest';
import { computeCoinMetrics } from '../../src/metrics/index.js';
import { buildWindows } from '../../src/metrics/windows.js';
import { cleanPools } from '../../src/metrics/clean.js';
import { mergeParams } from '../../src/metrics/index.js';
import { DAY, M0, bar, input, minuteBars, pool } from './helpers.js';

/** Bars that make every window strict: 2,000 USD and 10 wallets a minute. */
const busy = { volumeUsd: 2_000, traders: 10 };

describe('peak_outside_minute_coverage reads the bar high, not the close', () => {
  const H1 = M0 + 7_200; // two hours after the minute bars
  const minutes = minuteBars(M0, [0.0001, 0.0001, 0.0001, 0.0001], busy); // ATH 100,000
  const flagsFor = (hourly: ReturnType<typeof bar>[], daily: ReturnType<typeof bar>[] = []) =>
    computeCoinMetrics(
      input([pool({ bars1m: minutes, bars1h: hourly, bars1d: daily })], { asOf: DAY + 86_400 * 9 }),
    ).flags;

  it('an hourly bar that closes under the ATH but peaked above it raises the flag', () => {
    expect(flagsFor([bar(H1, 0.00001, { ...busy, h: 0.0004 })])).toContain(
      'peak_outside_minute_coverage',
    );
  });

  it('an hourly bar whose high is under the ATH does not', () => {
    expect(flagsFor([bar(H1, 0.00001, { ...busy, h: 0.00008, o: 0.00008 })])).not.toContain(
      'peak_outside_minute_coverage',
    );
  });

  it('a daily bar likewise', () => {
    expect(flagsFor([], [bar(DAY + 5 * 86_400, 0.00001, { ...busy, h: 0.0004 })])).toContain(
      'peak_outside_minute_coverage',
    );
    expect(
      flagsFor([], [bar(DAY + 5 * 86_400, 0.00001, { ...busy, h: 0.00008, o: 0.00008 })]),
    ).not.toContain('peak_outside_minute_coverage');
  });

  it('a bar that is not strict does not', () => {
    expect(flagsFor([bar(H1, 0.00001, { h: 0.0004, volumeUsd: 10 })])).not.toContain(
      'peak_outside_minute_coverage',
    );
  });

  it('clears once 1-minute bars exist inside the bar', () => {
    const r = computeCoinMetrics(
      input(
        [
          pool({
            bars1m: [...minutes, ...minuteBars(H1 + 600, [0.0001, 0.0001], busy)],
            bars1h: [bar(H1, 0.00001, { ...busy, h: 0.0004 })],
          }),
        ],
        { asOf: DAY },
      ),
    );
    expect(r.flags).not.toContain('peak_outside_minute_coverage');
  });

  it('does not change the price: the ATH and the time above are the same with or without the high', () => {
    const plain = computeCoinMetrics(input([pool({ bars1m: minutes })]));
    const spiky = computeCoinMetrics(
      input([pool({ bars1m: minutes, bars1h: [bar(H1, 0.00001, { ...busy, h: 0.0004 })] })]),
    );
    expect(spiky.athMarketCapUsd).toBe(plain.athMarketCapUsd);
    expect(spiky.athAt).toBe(plain.athAt);
  });
});

describe('windows carry the high', () => {
  it('an hourly window has max(o, h, l, c) of its bar; a 1-minute window has its price', () => {
    const params = mergeParams();
    const p = pool({
      bars1m: minuteBars(M0, [0.0001, 0.0002, 0.0003], busy),
      bars1h: [bar(M0 + 7_200, 0.00001, { ...busy, h: 0.0004, l: 0.000005 })],
    });
    const cleaned = cleanPools([p], input([p], { asOf: M0 + 86_400 }), params);
    const windows = buildWindows(cleaned.pools, params);
    const hourly = windows.find((w) => w.resolution === '1h')!;
    expect(hourly.high).toBeCloseTo(0.0004, 12);
    expect(hourly.price).toBeCloseTo(0.00001, 12);
    for (const w of windows.filter((x) => x.resolution === '1m')) expect(w.high).toBe(w.price);
  });
});
