import type { MetricFixture } from '../../../src/metrics/types.js';
import { bar, input, minute, pool } from './build.js';

export const justBelowVolumeAndTraders: MetricFixture = {
  name: 'just-below-volume-and-traders',
  description:
    'One window with 999 USD of volume and one with 4 traders: both just miss the thresholds, so nothing is strict. No ATH; the wick still sees both.',
  reasoning: `
One primary pool. m0: close .0002, 500 USD, 6 traders. m1: close .0002, 499 USD, 6 traders. m10: close .0003, 2,000 USD, 4 traders. m11: close .0003, 2,000 USD, 4 traders. asOf = m12, launchedAt = T0.

Windows:
m0: one bar, not strict.
m1: two bars, volume 500+499 = 999 < 1000: not strict (traders 6 is fine). Price .0002.
m10: one bar (m8, m9 absent), not strict.
m11: two bars, volume 4000, traders max(4,4) = 4 < 5: not strict. Price .0003.
No strict point anywhere: ATH fields null, flag no_qualifying_window.

Wick: highest bar max is .0003 first at m10 (T0+600): 300,000.
Level: the level never becomes defined (every point is not strict), so there are no level points: secondsAbove [0,0,0,0], maxDrawdownPct null. Rug false (ATH null).
No hourly or daily bars, so no peak_outside_minute_coverage.
`,
  input: input(
    [
      pool('pool-a', [
        bar(minute(0), 0.0002),
        bar(minute(1), 0.0002, { volumeUsd: 499 }),
        bar(minute(10), 0.0003, { volumeUsd: 2_000, traders: 4 }),
        bar(minute(11), 0.0003, { volumeUsd: 2_000, traders: 4 }),
      ]),
    ],
    minute(12),
  ),
  expected: {
    athMarketCapUsd: null,
    athAt: null,
    athPoolAddress: null,
    secondsToAth: null,
    athWickMarketCapUsd: 300_000,
    athWickAt: 1_699_920_600,
    athWickPoolAddress: 'pool-a',
    secondsAbove: [0, 0, 0, 0],
    maxDrawdownPct: null,
    rugPattern: false,
    flags: ['no_qualifying_window'],
  },
};
