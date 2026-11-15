import { describe, expect, it } from 'vitest';
import { findCoveragePeaks } from '../../src/candles/peaks.js';
import { computeCoinMetrics } from '../../src/metrics/index.js';
import type { Bar, MetricInput } from '../../src/metrics/types.js';

const T0 = 1_767_225_600;
const DAY = 86_400;
const HOUR = 3_600;

const bar = (t: number, price: number, over: Partial<Bar> = {}): Bar => ({
  t,
  o: price,
  h: price,
  l: price,
  c: price,
  volumeUsd: 5_000,
  trades: 20,
  traders: 10,
  liquidityUsd: 50_000,
  ...over,
});

const input = (pool: Partial<MetricInput['pools'][number]>): MetricInput => ({
  totalSupply: 1_000_000_000,
  launchedAt: T0,
  asOf: T0 + 400 * DAY,
  pools: [
    {
      address: 'GRAD',
      dex: 'PumpSwap',
      isPrimary: true,
      bars1m: [],
      bars1h: [],
      bars1d: [],
      ...pool,
    },
  ],
});

describe('findCoveragePeaks', () => {
  it('names the hourly and daily points that raise peak_outside_minute_coverage, highest first', () => {
    const i = input({
      bars1m: [bar(T0, 0.0001), bar(T0 + 60, 0.0001), bar(T0 + 120, 0.0001)],
      bars1h: [bar(T0 + 10 * DAY + 5 * HOUR, 0.002), bar(T0 + 10 * DAY + 6 * HOUR, 0.005)],
      bars1d: [bar(T0 + 20 * DAY, 0.003)],
    });
    expect(computeCoinMetrics(i).flags).toContain('peak_outside_minute_coverage');
    expect(findCoveragePeaks(i)).toEqual([
      { poolAddress: 'GRAD', t: T0 + 10 * DAY + 6 * HOUR, resolution: 3600 },
      { poolAddress: 'GRAD', t: T0 + 20 * DAY, resolution: 86400 },
      { poolAddress: 'GRAD', t: T0 + 10 * DAY + 5 * HOUR, resolution: 3600 },
    ]);
  });

  it('is empty when the flag is not raised', () => {
    const i = input({
      bars1m: [bar(T0, 0.01), bar(T0 + 60, 0.01), bar(T0 + 120, 0.01)],
      bars1h: [bar(T0 + 10 * DAY, 0.002)],
    });
    expect(computeCoinMetrics(i).flags).not.toContain('peak_outside_minute_coverage');
    expect(findCoveragePeaks(i)).toEqual([]);
  });

  it('lists every strict coarse point when there is no minute data at all', () => {
    const i = input({ bars1h: [bar(T0 + HOUR, 0.002), bar(T0 + 3 * HOUR, 0.001)] });
    expect(computeCoinMetrics(i).flags).toContain('peak_outside_minute_coverage');
    expect(findCoveragePeaks(i).map((p) => p.t)).toEqual([T0 + HOUR, T0 + 3 * HOUR]);
  });

  it('ignores points that are not strict and hourly bars hidden by minute bars', () => {
    const thin = { volumeUsd: 10, traders: 1 };
    const i = input({
      bars1m: [
        bar(T0, 0.0001),
        bar(T0 + 60, 0.0001),
        bar(T0 + 120, 0.0001),
        bar(T0 + 5 * HOUR + 60, 0.0001),
      ],
      // Thin: not strict. The other hour has a minute bar inside, so it is not a window.
      bars1h: [bar(T0 + 2 * HOUR, 0.01, thin), bar(T0 + 5 * HOUR, 0.01)],
    });
    expect(findCoveragePeaks(i)).toEqual([]);
  });

  it('yields no target once minute bars cover the hour, so the flag and the targets clear together', () => {
    const i = input({
      bars1h: [bar(T0 + 10 * DAY, 0.005)],
    });
    expect(findCoveragePeaks(i)).toHaveLength(1);
    const refined: MetricInput = {
      ...i,
      pools: [
        {
          ...i.pools[0]!,
          bars1m: [
            bar(T0 + 10 * DAY, 0.001),
            bar(T0 + 10 * DAY + 60, 0.001),
            bar(T0 + 10 * DAY + 120, 0.001),
          ],
        },
      ],
    };
    expect(computeCoinMetrics(refined).flags).not.toContain('peak_outside_minute_coverage');
    expect(findCoveragePeaks(refined)).toEqual([]);
  });
});
