import { describe, expect, it } from 'vitest';
import { cleanBars, cleanPools } from '../../src/metrics/clean.js';
import { DEFAULT_METRIC_PARAMS } from '../../src/metrics/types.js';
import { M0, bar, pool } from './helpers.js';

const supply = { totalSupply: 1_000_000_000, asOf: M0 + 3_600 };
const params = DEFAULT_METRIC_PARAMS;

describe('section 3: clean the bars', () => {
  it('ignores bars after asOf without a flag, and keeps a bar exactly at asOf', () => {
    // asOf = M0 + 3600. The bar at asOf stays; the bar one minute later goes.
    const result = cleanBars(
      [bar(M0 + 3_660, 0.0001), bar(M0 + 3_600, 0.0001), bar(M0, 0.0001)],
      true,
      supply,
      params,
    );
    expect(result.bars.map((b) => b.t)).toEqual([M0, M0 + 3_600]);
    expect(result.flags).toEqual([]);
  });

  it('drops bad bars and raises bad_bar; zero volume is fine', () => {
    const bad = [
      bar(M0, 0.0001, { o: 0 }),
      bar(M0 + 60, 0.0001, { h: Number.NaN }),
      bar(M0 + 120, 0.0001, { l: -1 }),
      bar(M0 + 180, 0.0001, { c: Number.POSITIVE_INFINITY }),
      bar(M0 + 240, 0.0001, { volumeUsd: -0.01 }),
      bar(M0 + 300, 0.0001, { volumeUsd: Number.NaN }),
    ];
    const result = cleanBars(bad, true, supply, params);
    expect(result.bars).toEqual([]);
    expect(result.flags).toEqual(['bad_bar']);

    const zeroVolume = cleanBars([bar(M0, 0.0001, { volumeUsd: 0 })], true, supply, params);
    expect(zeroVolume.bars).toHaveLength(1);
    expect(zeroVolume.flags).toEqual([]);
  });

  it('drops the whole bar when any field is above the market cap limit (inclusive at the limit)', () => {
    // Limit 20e9 over supply 1e9 is a price of 20. Price 20 is allowed, 20.001 is not,
    // and a high of 20.001 drops the bar even though the close is fine.
    const result = cleanBars(
      [bar(M0, 20), bar(M0 + 60, 20.001), bar(M0 + 120, 0.0001, { h: 20.001 })],
      true,
      supply,
      params,
    );
    expect(result.bars.map((b) => b.t)).toEqual([M0]);
    expect(result.flags).toEqual(['implausible_market_cap']);
  });

  it('keeps the last of two bars with the same t and raises duplicate_bar', () => {
    const first = bar(M0, 0.0001, { h: 0.0009 });
    const last = bar(M0, 0.0002);
    const result = cleanBars([first, last], true, supply, params);
    expect(result.bars).toEqual([last]);
    expect(result.flags).toEqual(['duplicate_bar']);
  });

  it('applies the rules in order: a bad last duplicate is dropped first, so no duplicate remains', () => {
    const good = bar(M0, 0.0001);
    const result = cleanBars([good, bar(M0, 0.0001, { o: 0 })], true, supply, params);
    expect(result.bars).toEqual([good]);
    expect(result.flags).toEqual(['bad_bar']);
  });

  it('drops secondary bars with null or low liquidity; exactly the minimum stays; primary never drops', () => {
    const bars = [
      bar(M0, 0.0001, { liquidityUsd: null }),
      bar(M0 + 60, 0.0001, { liquidityUsd: 4_999.99 }),
      bar(M0 + 120, 0.0001, { liquidityUsd: 5_000 }),
    ];
    const secondary = cleanBars(bars, false, supply, params);
    expect(secondary.bars.map((b) => b.t)).toEqual([M0 + 120]);
    expect(secondary.flags).toEqual([]);

    const primary = cleanBars(bars, true, supply, params);
    expect(primary.bars).toHaveLength(3);
  });

  it('sorts the output by t and does not touch the input', () => {
    const input = [bar(M0 + 120, 0.0001), bar(M0, 0.0001), bar(M0 + 60, 0.0001)];
    const copy = structuredClone(input);
    const result = cleanBars(input, true, supply, params);
    expect(result.bars.map((b) => b.t)).toEqual([M0, M0 + 60, M0 + 120]);
    expect(input).toEqual(copy);
  });

  it('applies the rules to every resolution of every pool and merges the flags', () => {
    const result = cleanPools(
      [
        pool({ bars1m: [bar(M0, 0.0001, { o: 0 })], bars1h: [bar(M0, 25)] }),
        pool({
          address: 'S',
          isPrimary: false,
          bars1d: [bar(M0, 0.0001, { liquidityUsd: 1 })],
        }),
      ],
      supply,
      params,
    );
    expect(result.flags.sort()).toEqual(['bad_bar', 'implausible_market_cap']);
    expect(result.pools.map((p) => [p.bars1m.length, p.bars1h.length, p.bars1d.length])).toEqual([
      [0, 0, 0],
      [0, 0, 0],
    ]);
  });
});
