import type { MetricFixture } from '../../../src/metrics/types.js';
import { bar, input, minute, pool } from './build.js';

export const duplicateWithBadLastBar: MetricFixture = {
  name: 'duplicate-with-bad-last-bar',
  description:
    'Two bars at the same t where the later one is invalid. Bad bars are dropped before duplicates are looked at, so the earlier good bar survives and only bad_bar is flagged, not duplicate_bar.',
  reasoning: `
One primary pool. Input: m0, m1, m2, m3 (.0002 each, 500 USD, 6 traders), then a second bar at m3: o = h = l = .0009, c = 0, 500 USD (bad: close is not above zero). asOf = m4, launchedAt = T0.

Clean, in the order of the rules:
Step 2 drops the second m3 bar (c = 0) and raises bad_bar.
Step 4 (duplicates): only one m3 bar is left, so there is no duplicate and no duplicate_bar flag.
Clean bars: m0..m3, .0002.

Windows: m0 not strict; m1, m2, m3 strict .0002.
ATH = 200,000 at m1: athAt = T0+60, secondsToAth 60.
Wick: .0002 at m0 (T0): 200,000 (the dropped bar's .0009 does not count).
Level points m1, m2, m3: 60 + 60 + 60 (m3 at T0+180 to asOf T0+240) = 180 above $100k.
Drawdown 0. Rug false. Flags: bad_bar only.
`,
  input: input(
    [
      pool('pool-a', [
        bar(minute(0), 0.0002),
        bar(minute(1), 0.0002),
        bar(minute(2), 0.0002),
        bar(minute(3), 0.0002),
        bar(minute(3), 0.0009, { c: 0 }),
      ]),
    ],
    minute(4),
  ),
  expected: {
    athMarketCapUsd: 200_000,
    athAt: 1_699_920_060,
    athPoolAddress: 'pool-a',
    secondsToAth: 60,
    athWickMarketCapUsd: 200_000,
    athWickAt: 1_699_920_000,
    athWickPoolAddress: 'pool-a',
    secondsAbove: [180, 0, 0, 0],
    maxDrawdownPct: 0,
    rugPattern: false,
    flags: ['bad_bar'],
  },
};
