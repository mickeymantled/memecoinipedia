import type { MetricFixture } from '../../../src/metrics/types.js';
import { bar, input, minute, pool } from './build.js';

export const exactMarketCapThresholds: MetricFixture = {
  name: 'exact-market-cap-thresholds',
  description:
    'A level of exactly $100,000 counts as at or above the $100k threshold, and exactly $1,000,000 counts at the $1M threshold: both inclusive.',
  reasoning: `
One primary pool. m0,m1,m2: close .0001 (exactly $100,000), 500 USD, 6 traders. m10,m11,m12: close .001 (exactly $1,000,000), same volume. asOf = m13, launchedAt = T0.

Windows:
m0: one bar, not strict.
m1: strict, .0001. m2: strict, .0001.
m10: bars m8..m10 -> only m10, not strict, price .001.
m11: bars m10,m11 strict, .001. m12: bars m10,m11,m12 strict, .001.

ATH: highest strict price .001, first at m11: athAt = T0+660, ATH = $1,000,000, secondsToAth 660.
Wick: .001 first reached by the m10 bar: T0+600, $1,000,000.

Level: m0 ignored. m1 .0001, m2 .0001. m10 is not strict and above the level, so the level stays .0001 and m10 still gives a level point (.0001). m11 .001, m12 .001.
Level points: m1 (.0001), m2 (.0001), m10 (.0001), m11 (.001), m12 (.001).
Holds: m1->m2 60; m2->m10 480 (under 86,400); m10->m11 60; m11->m12 60; m12 (T0+720) -> asOf (T0+780) 60.
At or above $100k (inclusive, $100,000 counts): all five points: 60+480+60+60+60 = 720.
At or above $1M (inclusive, $1,000,000 counts): m11 and m12: 60+60 = 120. Above $10M: 0.
Drawdown 0 (level never falls). Rug false.

Rules v4 (this paragraph supersedes any wick figure above). athLiquidityUsd null (no bar of the ATH window reports liquidity); athHourVolumeUsd 2,500 (volume of the clean 1-minute bars of every pool in the hour ending at m11). Wick: only a clean 1-minute bar with at least $1,000 of volume and 5 traders of its own, funded or of unknown liquidity, is a candidate, valued at max(open, close); the ATH takes over when higher. Here the best candidate is not above the ATH (or there is none), so the wick is the ATH: 1,000,000 at m11.
`,
  input: input(
    [
      pool('pool-a', [
        bar(minute(0), 0.0001),
        bar(minute(1), 0.0001),
        bar(minute(2), 0.0001),
        bar(minute(10), 0.001),
        bar(minute(11), 0.001),
        bar(minute(12), 0.001),
      ]),
    ],
    minute(13),
  ),
  expected: {
    athMarketCapUsd: 1_000_000,
    athAt: 1_699_920_660,
    athPoolAddress: 'pool-a',
    secondsToAth: 660,
    athWickMarketCapUsd: 1_000_000,
    athWickAt: 1_699_920_660,
    athWickPoolAddress: 'pool-a',
    athLiquidityUsd: null,
    athHourVolumeUsd: 2_500,
    secondsAbove: [720, 120, 0, 0],
    maxDrawdownPct: 0,
    rugPattern: false,
    flags: [],
  },
};
