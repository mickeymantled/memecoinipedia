import { describe, expect, it } from 'vitest';
import { DEFAULT_METRIC_PARAMS, computeCoinMetrics, mergeParams } from '../../src/metrics/index.js';
import { metricFixturesV6 } from '../fixtures/metrics/index.js';
import { deepFreeze } from './helpers.js';

const fixture = (name: string) => {
  const found = metricFixturesV6.find((f) => f.name === name);
  if (!found) throw new Error(`no fixture ${name}`);
  return found;
};

describe('version 6 parameters', () => {
  it('has the documented defaults', () => {
    expect(DEFAULT_METRIC_PARAMS.nearAthFraction).toBe(0.5);
    expect(DEFAULT_METRIC_PARAMS.minAthNearVolumeShare).toBe(0.05);
  });

  it('validates them like the others', () => {
    for (const bad of [0, -0.1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => mergeParams({ nearAthFraction: bad })).toThrow(RangeError);
    }
    for (const bad of [-0.01, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => mergeParams({ minAthNearVolumeShare: bad })).toThrow(RangeError);
    }
    expect(mergeParams({ nearAthFraction: 1 }).nearAthFraction).toBe(1);
    expect(mergeParams({ minAthNearVolumeShare: 0 }).minAthNearVolumeShare).toBe(0);
  });

  it('nearAthFraction moves the line: .9 of .2 leaves only the bars closing at .2', () => {
    const f = fixture('near-ath-close-exactly-half-counts-just-under-does-not');
    expect(computeCoinMetrics(f.input, { nearAthFraction: 0.9 }).athNearVolumeUsd).toBe(3_000);
    expect(computeCoinMetrics(f.input, { nearAthFraction: 0.5 }).athNearVolumeUsd).toBe(3_111);
  });

  it('minAthNearVolumeShare moves the flag', () => {
    const f = fixture('near-ath-close-exactly-half-counts-just-under-does-not');
    // 3,111 of a 200,000,000 ATH is 0.0015555%.
    const flagged = (share: number) =>
      computeCoinMetrics(f.input, { minAthNearVolumeShare: share }).flags.includes(
        'ath_thinly_traded',
      );
    expect(flagged(0.000015)).toBe(false);
    expect(flagged(0.00002)).toBe(true);
    expect(flagged(0.05)).toBe(true);
    expect(flagged(0)).toBe(false);
  });
});

describe('athNearVolumeUsd', () => {
  it('does not depend on the order of pools or bars, and does not modify the input', () => {
    const f = fixture('near-ath-sums-pools-that-count-and-ignores-dropped');
    const frozen = deepFreeze(structuredClone(f.input));
    const reversed = {
      ...structuredClone(f.input),
      pools: [...structuredClone(f.input.pools)].reverse().map((p) => ({
        ...p,
        bars1m: [...p.bars1m].reverse(),
      })),
    };
    expect(computeCoinMetrics(reversed)).toEqual(computeCoinMetrics(frozen));
  });

  it('counts a 1-minute bar on its own close, not on its window median', () => {
    // m3 of the sum fixture: pool-c's .04 bar sits in a window whose median is .12 (counted
    // as a price), but its own close is under the line, so its 600 USD adds nothing.
    const f = fixture('near-ath-sums-pools-that-count-and-ignores-dropped');
    expect(computeCoinMetrics(f.input).athNearVolumeUsd).toBe(3_650);
  });
});
