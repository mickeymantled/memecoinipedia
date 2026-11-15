import { describe, expect, it } from 'vitest';
import type { CleanPool, Window } from '../../src/metrics/internal.js';
import { buildCoinPoints } from '../../src/metrics/points.js';
import {
  buildWindows,
  coarseWindow,
  dailyBarIsUsed,
  hourlyBarIsUsed,
  lowerMedian,
  minuteWindows,
} from '../../src/metrics/windows.js';
import { DEFAULT_METRIC_PARAMS } from '../../src/metrics/types.js';
import { DAY, M0, bar } from './helpers.js';

const params = DEFAULT_METRIC_PARAMS;
const P = { address: 'P', isPrimary: true };

function cleanPool(over: Partial<CleanPool> = {}): CleanPool {
  return { address: 'P', isPrimary: true, bars1m: [], bars1h: [], bars1d: [], ...over };
}

describe('section 4: windows', () => {
  it('lowerMedian: middle of three, lower of two, the value itself for one, lower middle for four', () => {
    expect(lowerMedian([3, 1, 2])).toBe(2);
    expect(lowerMedian([5, 3])).toBe(3);
    expect(lowerMedian([7])).toBe(7);
    expect(lowerMedian([4, 1, 3, 2])).toBe(2);
  });

  it('full 3-bar window: median close, summed volume, highest traders', () => {
    // Closes 3, 1, 2 -> sorted 1, 2, 3 -> median 2. Volumes 400+300+300 = 1000.
    // Traders 2, 7, 4 -> 7. Three bars, volume = 1000 (exactly the minimum), traders 7 >= 5: strict.
    const bars = [
      bar(M0, 3, { volumeUsd: 400, traders: 2 }),
      bar(M0 + 60, 1, { volumeUsd: 300, traders: 7 }),
      bar(M0 + 120, 2, { volumeUsd: 300, traders: 4 }),
    ];
    const windows = minuteWindows(bars, P, params);
    expect(windows).toHaveLength(3);
    expect(windows[2]).toMatchObject({
      t: M0 + 120,
      price: 2,
      volume: 1_000,
      traders: 7,
      strict: true,
      resolution: '1m',
    });
  });

  it('two-bar window: lower close; never strict with one bar however large', () => {
    // Window at M0+60 holds closes 5 and 3 -> 3.
    const bars = [
      bar(M0, 5, { volumeUsd: 600, traders: 9 }),
      bar(M0 + 60, 3, { volumeUsd: 600, traders: 1 }),
    ];
    const [one, two] = minuteWindows(bars, P, params);
    expect(two).toMatchObject({ price: 3, volume: 1_200, traders: 9, strict: true });
    // One bar: price is its close, strict is false although volume and traders qualify.
    const [solo] = minuteWindows([bar(M0, 5, { volumeUsd: 50_000, traders: 99 })], P, params);
    expect(solo).toMatchObject({ price: 5, strict: false });
    expect(one?.strict).toBe(false);
  });

  it('a bar 2 minutes back is inside a 3-minute window, 3 minutes back is not', () => {
    const inside = minuteWindows([bar(M0, 1), bar(M0 + 120, 2)], P, params);
    expect(inside[1]?.volume).toBe(2_000); // both bars
    const outside = minuteWindows([bar(M0, 1), bar(M0 + 180, 2)], P, params);
    expect(outside[1]?.volume).toBe(1_000); // only its own bar
    expect(outside[1]?.strict).toBe(false);
  });

  it('volume threshold is inclusive', () => {
    const at = minuteWindows(
      [bar(M0, 1, { volumeUsd: 500 }), bar(M0 + 60, 1, { volumeUsd: 500 })],
      P,
      params,
    );
    expect(at[1]?.strict).toBe(true);
    const below = minuteWindows(
      [bar(M0, 1, { volumeUsd: 500 }), bar(M0 + 60, 1, { volumeUsd: 499.99 })],
      P,
      params,
    );
    expect(below[1]?.strict).toBe(false);
  });

  it('traders threshold is inclusive and uses the highest single minute, not the sum', () => {
    const at = minuteWindows(
      [bar(M0, 1, { traders: 5 }), bar(M0 + 60, 1, { traders: 1 })],
      P,
      params,
    );
    expect(at[1]?.traders).toBe(5);
    expect(at[1]?.strict).toBe(true);
    // 4 + 4 + 4 = 12 wallets in total, but the best single minute has 4: not strict.
    const spread = minuteWindows(
      [
        bar(M0, 1, { traders: 4 }),
        bar(M0 + 60, 1, { traders: 4 }),
        bar(M0 + 120, 1, { traders: 4 }),
      ],
      P,
      params,
    );
    expect(spread[2]).toMatchObject({ traders: 4, strict: false });
  });

  it('non-default windowMinutes and thresholds', () => {
    const bars = [bar(M0, 1), bar(M0 + 240, 2)]; // 4 minutes apart
    // 3 minutes: the bars are not in each other's window. 5 minutes: they are.
    expect(minuteWindows(bars, P, params)[1]?.strict).toBe(false);
    expect(minuteWindows(bars, P, { ...params, windowMinutes: 5 })[1]).toMatchObject({
      strict: true,
      price: 1, // closes 1 and 2: lower median 1
    });
    // 1-minute window: a window is a single bar, so it can never be strict.
    expect(minuteWindows(bars, P, { ...params, windowMinutes: 1 })[1]?.strict).toBe(false);
    // 2-minute window: a bar two minutes back is out.
    const two = minuteWindows([bar(M0, 1), bar(M0 + 120, 2)], P, { ...params, windowMinutes: 2 });
    expect(two[1]?.strict).toBe(false);
    // Lower volume and traders thresholds.
    const light = [
      bar(M0, 1, { volumeUsd: 60, traders: 2 }),
      bar(M0 + 60, 1, { volumeUsd: 40, traders: 1 }),
    ];
    expect(minuteWindows(light, P, params)[1]?.strict).toBe(false);
    expect(
      minuteWindows(light, P, { ...params, minWindowVolumeUsd: 100, minWindowTraders: 2 })[1]
        ?.strict,
    ).toBe(true);
  });

  it('hourly and daily bars are their own window; strictness needs only volume and traders', () => {
    const hourly = coarseWindow(
      bar(M0, 4, { c: 2, volumeUsd: 1_000, traders: 5 }),
      P,
      '1h',
      params,
    );
    expect(hourly).toMatchObject({
      price: 2,
      volume: 1_000,
      traders: 5,
      strict: true,
      resolution: '1h',
    });
    const thin = coarseWindow(bar(DAY, 4, { volumeUsd: 999, traders: 50 }), P, '1d', params);
    expect(thin).toMatchObject({ strict: false, resolution: '1d' });
    const fewTraders = coarseWindow(bar(DAY, 4, { traders: 4 }), P, '1d', params);
    expect(fewTraders.strict).toBe(false);
  });

  it('finer data wins: an hourly bar is unused when any pool has a 1-minute bar in that hour', () => {
    const hourBar = bar(M0, 1);
    const withMinute = [
      cleanPool({ bars1h: [hourBar] }),
      cleanPool({ address: 'S', isPrimary: false, bars1m: [bar(M0 + 3_540, 1)] }), // last minute of the hour
    ];
    expect(hourlyBarIsUsed(withMinute, hourBar)).toBe(false);
    const nextHour = [
      cleanPool({ bars1h: [hourBar] }),
      cleanPool({ address: 'S', bars1m: [bar(M0 + 3_600, 1)] }), // first minute of the next hour
    ];
    expect(hourlyBarIsUsed(nextHour, hourBar)).toBe(true);
  });

  it('finer data wins: a daily bar is unused when any pool has a 1-minute or hourly bar in that day', () => {
    const dayBar = bar(DAY, 1);
    expect(dailyBarIsUsed([cleanPool({ bars1d: [dayBar] })], dayBar)).toBe(true);
    expect(
      dailyBarIsUsed([cleanPool({ bars1d: [dayBar], bars1m: [bar(DAY + 86_340, 1)] })], dayBar),
    ).toBe(false);
    expect(
      dailyBarIsUsed(
        [
          cleanPool({ bars1d: [dayBar] }),
          cleanPool({ address: 'S', bars1h: [bar(DAY + 3_600, 1)] }),
        ],
        dayBar,
      ),
    ).toBe(false);
    expect(
      dailyBarIsUsed([cleanPool({ bars1d: [dayBar], bars1h: [bar(DAY + 86_400, 1)] })], dayBar),
    ).toBe(true);
  });

  it('buildWindows keeps only unsuperseded coarse bars', () => {
    const pools = [
      cleanPool({
        bars1m: [bar(M0, 1)],
        bars1h: [bar(M0, 1), bar(M0 + 7_200, 1)], // the first is superseded, the second is not
        bars1d: [bar(DAY, 1), bar(DAY + 86_400 * 5, 1)], // the first is superseded by minute and hourly
      }),
    ];
    const windows = buildWindows(pools, params);
    expect(windows.map((w) => [w.resolution, w.t])).toEqual([
      ['1m', M0],
      ['1h', M0 + 7_200],
      ['1d', DAY + 86_400 * 5],
    ]);
  });
});

describe('section 5: one point per timestamp', () => {
  const w = (over: Partial<Window>): Window => ({
    t: M0,
    price: 1,
    high: over.high ?? over.price ?? 1,
    volume: 100,
    traders: 5,
    strict: true,
    poolAddress: 'P',
    isPrimary: true,
    resolution: '1m',
    ...over,
  });

  it('keeps the busiest pool, not the highest price', () => {
    const points = buildCoinPoints([
      w({ poolAddress: 'A', price: 9, volume: 100 }),
      w({ poolAddress: 'B', price: 1, volume: 101 }),
    ]);
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({ poolAddress: 'B', price: 1 });
  });

  it('tie on volume: primary wins, even with the larger address', () => {
    const points = buildCoinPoints([
      w({ poolAddress: 'A', isPrimary: false, price: 2 }),
      w({ poolAddress: 'Z', isPrimary: true, price: 3 }),
    ]);
    expect(points[0]).toMatchObject({ poolAddress: 'Z', price: 3 });
  });

  it('tie on volume and primacy: the smaller address wins, in either input order', () => {
    const a = w({ poolAddress: 'A', isPrimary: false, price: 2 });
    const b = w({ poolAddress: 'B', isPrimary: false, price: 3 });
    expect(buildCoinPoints([a, b])[0]?.poolAddress).toBe('A');
    expect(buildCoinPoints([b, a])[0]?.poolAddress).toBe('A');
  });

  it('sorts points by t and keeps one per t', () => {
    const points = buildCoinPoints([
      w({ t: M0 + 60 }),
      w({ t: M0 }),
      w({ t: M0, poolAddress: 'Q', volume: 1 }),
    ]);
    expect(points.map((p) => p.t)).toEqual([M0, M0 + 60]);
  });
});
