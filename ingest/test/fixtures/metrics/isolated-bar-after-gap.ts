import type { MetricFixture } from '../../../src/metrics/types.js';
import { bar, input, minute, pool } from './build.js';

export const isolatedBarAfterGap: MetricFixture = {
  name: 'isolated-bar-after-gap',
  description:
    'A single high-volume bar eight minutes after the last trade has a one-bar window: never strict, so it cannot set the ATH or raise the level, but it sets the wick and still produces a level point.',
  reasoning: `
One primary pool. m0, m1: close .0002, 500 USD, 6 traders. m10: close .0004, 5,000 USD, 10 traders. asOf = m11, launchedAt = T0.

Windows:
m0: one bar, not strict.
m1: two bars, volume 1000, traders 6, strict, price .0002.
m10: bars m8,m9 absent, m10 only: ONE bar, not strict (needs at least two bars), however large its volume. Price .0004.

ATH = .0002 * 1e9 = 200,000 at m1: athAt = T0+60, secondsToAth 60.
Wick: .0004 at m10 (T0+600): 400,000.
Level: m1 sets .0002. m10 is not strict and its price is above the level: level stays .0002, a level point (m10, .0002) is still produced.
Level points: m1, m10. Holds: m1->m10 540 s; m10 (T0+600) -> asOf (T0+660) 60 s. Total 600 above $100k.
Drawdown 0. Rug false.
`,
  input: input(
    [
      pool('pool-a', [
        bar(minute(0), 0.0002),
        bar(minute(1), 0.0002),
        bar(minute(10), 0.0004, { volumeUsd: 5_000, traders: 10 }),
      ]),
    ],
    minute(11),
  ),
  expected: {
    athMarketCapUsd: 200_000,
    athAt: 1_699_920_060,
    athPoolAddress: 'pool-a',
    secondsToAth: 60,
    athWickMarketCapUsd: 400_000,
    athWickAt: 1_699_920_600,
    athWickPoolAddress: 'pool-a',
    secondsAbove: [600, 0, 0, 0],
    maxDrawdownPct: 0,
    rugPattern: false,
    flags: [],
  },
};
