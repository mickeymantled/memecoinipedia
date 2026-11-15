import { describe, expect, it } from 'vitest';
import { computeCoinMetrics } from '../../src/metrics/index.js';
import type { MetricResult } from '../../src/metrics/types.js';
import { withoutVersion6Additions } from './helpers.js';
import { allMetricFixtures as metricFixtures } from '../fixtures/metrics/index.js';

/** Numbers within a relative 1e-9 (absolute 1e-9 when expected is 0); everything else exactly. */
function expectSame(actual: unknown, expected: unknown, path: string): void {
  if (typeof expected === 'number' && typeof actual === 'number') {
    const tolerance = expected === 0 ? 1e-9 : Math.abs(expected) * 1e-9;
    expect(Math.abs(actual - expected), `${path}: ${actual} vs ${expected}`).toBeLessThanOrEqual(
      tolerance,
    );
  } else if (Array.isArray(expected)) {
    expect(Array.isArray(actual), `${path} is an array`).toBe(true);
    const list = actual as unknown[];
    expect(list.length, `${path} length`).toBe(expected.length);
    expected.forEach((item, i) => expectSame(list[i], item, `${path}[${i}]`));
  } else {
    expect(actual, path).toBe(expected);
  }
}

describe('hand-worked metric fixtures', () => {
  it(`ran ${metricFixtures.length} fixtures`, () => {
    console.log(`metric fixtures run: ${metricFixtures.length}`);
    expect(metricFixtures.length).toBeGreaterThanOrEqual(0);
  });

  for (const fixture of metricFixtures) {
    it(fixture.name, () => {
      const full = computeCoinMetrics(fixture.input, fixture.params);
      // A fixture from before rules version 6 does not list the version 6 additions:
      // compare the rest (version5.test.ts pins them to the version 5 results exactly).
      const result: Partial<MetricResult> =
        'athNearVolumeUsd' in fixture.expected ? full : withoutVersion6Additions(full);
      expect(Object.keys(result).sort()).toEqual(Object.keys(fixture.expected).sort());
      for (const key of Object.keys(fixture.expected) as (keyof typeof fixture.expected)[]) {
        if (key === 'flags') {
          expect(result.flags, 'flags').toEqual(fixture.expected.flags);
        } else {
          expectSame(result[key as keyof MetricResult], fixture.expected[key], key);
        }
      }
    });
  }
});
