/**
 * The status is now decided by `statusFromEvidence` from `last_alive_at`, the stored rug pattern
 * and the coin's history, with `last_alive_at` taken from the bars. For a coin with nothing stored
 * yet that must give the status the rule gave before the column existed. This runs every fixture
 * (at its own `asOf` and at 3, 8 and 20 days later, so that alive, dead and unknown all occur)
 * and compares with the statuses recorded from the earlier code, `status-before-last-alive.json`,
 * exactly.
 */
import { readFileSync } from 'node:fs';
import {
  decideStatus,
  hasWeekOfBars,
  lastAliveFromBars,
  statusFromEvidence,
} from '@memecoinipedia/db';
import { describe, expect, it } from 'vitest';
import { computeCoinMetrics } from '../../src/metrics/index.js';
import { metricFixtures } from '../fixtures/metrics/index.js';

const recorded = JSON.parse(
  readFileSync(
    new URL('../fixtures/metrics/status-before-last-alive.json', import.meta.url),
    'utf8',
  ),
) as Record<string, string>;

const OFFSETS_DAYS = [0, 3, 8, 20];

describe('the status from last_alive_at equals the status before the column existed', () => {
  it('recorded a status for every fixture and offset, with all four statuses present', () => {
    expect(Object.keys(recorded).sort()).toEqual(
      metricFixtures.flatMap((f) => OFFSETS_DAYS.map((d) => `${f.name}@+${d}d`)).sort(),
    );
    expect(new Set(Object.values(recorded))).toEqual(
      new Set(['alive', 'dead', 'rugged', 'unknown']),
    );
  });

  for (const fixture of metricFixtures) {
    for (const d of OFFSETS_DAYS) {
      it(`${fixture.name} at +${d} days`, () => {
        const input = { pools: fixture.input.pools, asOf: fixture.input.asOf + d * 86_400 };
        const result = computeCoinMetrics(fixture.input, fixture.params);
        // The way the metrics computation does it with nothing stored: from the bars alone.
        const status = statusFromEvidence({
          rugPattern: result.rugPattern,
          lastAliveAt: lastAliveFromBars(input),
          hasWeekOfHistory: hasWeekOfBars(input),
          now: input.asOf,
        });
        expect(status).toBe(recorded[`${fixture.name}@+${d}d`]);
        expect(decideStatus(input, result)).toBe(status);
      });
    }
  }
});
