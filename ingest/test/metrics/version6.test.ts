/**
 * Rules version 7 moves the share of the flag from 5% to 20% and adds the backed high; nothing else
 * changes. This runs every fixture and compares every output with the result the library gave under
 * rules version 6, recorded before version 7 was written (`version-6-results.json`), exactly: no
 * tolerance. The only difference allowed is the flag `ath_thinly_traded`, and only where the near
 * volume is between 5% and 20% of the ATH market cap.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { computeCoinMetrics } from '../../src/metrics/index.js';
import type { MetricResult } from '../../src/metrics/types.js';
import { allMetricFixtures } from '../fixtures/metrics/index.js';

const recorded = JSON.parse(
  readFileSync(new URL('../fixtures/metrics/version-6-results.json', import.meta.url), 'utf8'),
  (_key, value: unknown) => (value === '-0' ? -0 : value),
) as Record<string, MetricResult>;

const THINLY = 'ath_thinly_traded';
const outsideThinly = (flags: string[]): string[] => flags.filter((f) => f !== THINLY);

/**
 * The two fixtures that test the flag line were rewritten for the new share (their volumes moved
 * from 5% to 20% of the ATH market cap), so the version 6 recording is of other input. They are
 * hand-worked in `near-ath.ts`. Fixtures added in version 7 have no version 6 result.
 */
const rewritten = new Set([
  'near-ath-volume-exactly-at-the-line-no-flag',
  'near-ath-volume-just-under-the-line-flag',
]);
const compared = allMetricFixtures.filter((f) => f.name in recorded && !rewritten.has(f.name));

describe('rules version 7 leaves every version 6 output as it was', () => {
  it('compares every version 6 fixture except the two rewritten for the new share', () => {
    expect(Object.keys(recorded).length - rewritten.size).toBe(compared.length);
    expect(compared.length).toBeGreaterThanOrEqual(64);
  });

  const changed: string[] = [];

  for (const fixture of compared) {
    it(fixture.name, () => {
      const result = computeCoinMetrics(fixture.input, fixture.params);
      const before = recorded[fixture.name] as MetricResult;
      const { athBackedMarketCapUsd, ...now } = result;
      expect({ ...now, flags: outsideThinly(now.flags) }).toEqual({
        ...before,
        flags: outsideThinly(before.flags),
      });
      const flaggedNow = now.flags.includes(THINLY);
      if (before.flags.includes(THINLY) !== flaggedNow) {
        // Where the flag differs it was not raised under version 6 and is raised now, and the
        // near volume is from 5% up to 20% of the ATH market cap.
        const share = (before.athNearVolumeUsd as number) / (before.athMarketCapUsd as number);
        expect(before.flags.includes(THINLY)).toBe(false);
        expect(share).toBeGreaterThanOrEqual(0.05);
        expect(share).toBeLessThan(0.2);
        changed.push(`${fixture.name} (${(share * 100).toFixed(3)}%)`);
      }
      // The backed high is the ATH, the same number, exactly when the flag is not raised.
      if (result.athMarketCapUsd !== null) {
        expect(athBackedMarketCapUsd === result.athMarketCapUsd).toBe(!flaggedNow);
      }
    });
  }

  it('lists the fixtures whose flag changed', () => {
    console.log(`fixtures whose ${THINLY} flag changed: ${changed.join(', ') || 'none'}`);
    expect(changed.length).toBeGreaterThanOrEqual(0);
  });
});
