import { describe, expect, it } from 'vitest';
import { findCoveragePeaks } from '../../src/candles/peaks.js';
import type { Bar, MetricInput } from '../../src/metrics/types.js';

const M0 = 1_767_225_600;
const mk = (t: number, c: number, over: Partial<Bar> = {}): Bar => ({
  t,
  o: c,
  h: c,
  l: c,
  c,
  volumeUsd: 2_000,
  trades: 3,
  traders: 10,
  liquidityUsd: null,
  ...over,
});

describe('findCoveragePeaks reads highs', () => {
  const minutes = [0, 60, 120, 180].map((s) => mk(M0 + s, 0.0001));
  const input: MetricInput = {
    totalSupply: 1_000_000_000,
    launchedAt: M0 - 600,
    asOf: M0 + 10 * 86_400,
    pools: [
      {
        address: 'P',
        dex: 'x',
        isPrimary: true,
        bars1m: minutes,
        // The closes are tiny; the highs differ and the later hour has the higher one.
        bars1h: [mk(M0 + 7_200, 0.00001, { h: 0.0003 }), mk(M0 + 14_400, 0.00001, { h: 0.0005 })],
        bars1d: [mk(M0 + 86_400 * 3, 0.00001, { h: 0.0002 })],
      },
    ],
  };

  it('orders by high, highest first, and carries the high as a market cap', () => {
    const peaks = findCoveragePeaks(input);
    expect(peaks.map((p) => [p.resolution, p.t])).toEqual([
      [3600, M0 + 14_400],
      [3600, M0 + 7_200],
      [86400, M0 + 86_400 * 3],
    ]);
    expect(peaks.map((p) => Math.round(p.highUsd ?? -1))).toEqual([500_000, 300_000, 200_000]);
  });

  it('leaves out a bar whose high is under the ATH', () => {
    const quiet: MetricInput = {
      ...input,
      pools: [
        {
          ...input.pools[0]!,
          bars1h: [mk(M0 + 7_200, 0.00001, { h: 0.00005, o: 0.00005 })],
          bars1d: [],
        },
      ],
    };
    expect(findCoveragePeaks(quiet)).toEqual([]);
  });
});
