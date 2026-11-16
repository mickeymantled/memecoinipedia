/**
 * Well-formedness checks on the hand-worked fixtures. Nothing here computes a
 * metric: it only checks that the fixtures are complete and self-consistent.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_METRIC_PARAMS,
  type MetricFlag,
  type MetricResult,
} from '../../../src/metrics/types.js';
import { allMetricFixtures as metricFixtures } from './index.js';

const KNOWN_FLAGS: readonly MetricFlag[] = [
  'ath_before_launch',
  'ath_thinly_traded',
  'bad_bar',
  'duplicate_bar',
  'implausible_market_cap',
  'no_qualifying_window',
  'peak_outside_minute_coverage',
];

const RESULT_FIELDS: readonly (keyof MetricResult)[] = [
  'athMarketCapUsd',
  'athAt',
  'athPoolAddress',
  'secondsToAth',
  'athWickMarketCapUsd',
  'athWickAt',
  'athWickPoolAddress',
  'athLiquidityUsd',
  'athHourVolumeUsd',
  'athNearVolumeUsd',
  'secondsAbove',
  'maxDrawdownPct',
  'rugPattern',
  'flags',
];

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

describe('metric fixtures are well formed', () => {
  it('has at least 20 fixtures', () => {
    expect(metricFixtures.length).toBeGreaterThanOrEqual(20);
  });

  it('has unique kebab-case names', () => {
    const names = metricFixtures.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(KEBAB);
  });

  describe.each(metricFixtures.map((f) => [f.name, f] as const))('%s', (_name, fixture) => {
    it('has a description and a reasoning of a few hundred characters', () => {
      expect(fixture.description.trim().length).toBeGreaterThan(20);
      expect(fixture.reasoning.trim().length).toBeGreaterThanOrEqual(300);
    });

    it('has every bar on a bucket boundary', () => {
      for (const p of fixture.input.pools) {
        for (const b of p.bars1m) expect(b.t % 60).toBe(0);
        for (const b of p.bars1h) expect(b.t % 3_600).toBe(0);
        for (const b of p.bars1d) expect(b.t % 86_400).toBe(0);
      }
    });

    it('has every field of MetricResult and nothing else', () => {
      // Fixtures from before rules version 6 may leave out `athNearVolumeUsd`; the new ones list it.
      const optional = 'athNearVolumeUsd';
      const without = (keys: readonly string[]): string[] =>
        keys.filter((k) => k !== optional).sort();
      expect(without(Object.keys(fixture.expected))).toEqual(without(RESULT_FIELDS));
    });

    it('has one non-increasing secondsAbove entry per threshold', () => {
      const thresholds = fixture.params?.thresholdsUsd ?? DEFAULT_METRIC_PARAMS.thresholdsUsd;
      const above = fixture.expected.secondsAbove;
      expect(above).toHaveLength(thresholds.length);
      for (let i = 0; i < above.length; i += 1) {
        expect(Number.isFinite(above[i])).toBe(true);
        expect(above[i]).toBeGreaterThanOrEqual(0);
        if (i > 0) expect(above[i]).toBeLessThanOrEqual(above[i - 1] as number);
      }
    });

    it('has sorted, unique, known flags', () => {
      const flags = fixture.expected.flags;
      expect([...flags].sort()).toEqual(flags);
      expect(new Set(flags).size).toBe(flags.length);
      for (const flag of flags) expect(KNOWN_FLAGS).toContain(flag);
    });

    it('keeps the ATH group all-null or all-set, and the ATH within the wick', () => {
      const e = fixture.expected;
      const athFields = [e.athMarketCapUsd, e.athAt, e.athPoolAddress, e.secondsToAth];
      const nulls = athFields.filter((v) => v === null).length;
      expect(nulls === 0 || nulls === athFields.length).toBe(true);
      expect(e.flags.includes('no_qualifying_window')).toBe(e.athMarketCapUsd === null);
      const wickFields = [e.athWickMarketCapUsd, e.athWickAt, e.athWickPoolAddress];
      const wickNulls = wickFields.filter((v) => v === null).length;
      expect(wickNulls === 0 || wickNulls === wickFields.length).toBe(true);
      if (e.athMarketCapUsd !== null && e.athWickMarketCapUsd !== null) {
        expect(e.athMarketCapUsd).toBeLessThanOrEqual(e.athWickMarketCapUsd);
      }
    });

    it('has a drawdown between 0 and 100, or null', () => {
      const d = fixture.expected.maxDrawdownPct;
      if (d !== null) {
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThanOrEqual(100);
      }
    });
  });
});
