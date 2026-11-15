/**
 * Rules version 6 only adds an output and a flag; nothing reads them. This runs every
 * existing (version 5) fixture and compares each version 5 output with the result the
 * library gave under rules version 5, recorded before version 6 was written
 * (`version-5-results.json`), exactly: no tolerance, no inspection.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { computeCoinMetrics } from '../../src/metrics/index.js';
import { metricFixtures } from '../fixtures/metrics/index.js';

const recorded = JSON.parse(
  readFileSync(new URL('../fixtures/metrics/version-5-results.json', import.meta.url), 'utf8'),
  (_key, value: unknown) => (value === '-0' ? -0 : value),
) as Record<string, Record<string, unknown>>;

describe('rules version 6 leaves every version 5 output as it was', () => {
  it('recorded a result for every existing fixture', () => {
    expect(Object.keys(recorded).sort()).toEqual(metricFixtures.map((f) => f.name).sort());
  });

  for (const fixture of metricFixtures) {
    it(fixture.name, () => {
      const { athNearVolumeUsd, ...rest } = computeCoinMetrics(fixture.input, fixture.params);
      const version5 = { ...rest, flags: rest.flags.filter((f) => f !== 'ath_thinly_traded') };
      expect(version5).toEqual(recorded[fixture.name]);
      // The new output is null exactly when the ATH is.
      expect(athNearVolumeUsd === null).toBe(rest.athMarketCapUsd === null);
    });
  }
});
