import type { MetricFixture } from '../../../src/metrics/types.js';
import { bar, input, minute, pool } from './build.js';

export const thinLowerPrintLowersLevel: MetricFixture = {
  name: 'thin-lower-print-lowers-level',
  description:
    'A non-strict (single bar) print below the level lowers the level, so drawdown and time above see it, while the ATH stays on the strict price.',
  reasoning: `
One primary pool. m0, m1, m2: close .0004 (500 USD, 6 traders). m10: close .0002, 100 USD, 1 trader. asOf = m11, launchedAt = T0.

Windows:
m0: one bar, not strict, .0004.
m1: strict, .0004. m2: strict, .0004.
m10: only m10 in its 3 minutes: one bar, not strict, price .0002.

ATH = .0004 * 1e9 = 400,000 at m1: athAt = T0+60, secondsToAth 60. Wick: .0004 at m0 (T0): 400,000.
Level: m0 ignored (undefined). m1 .0004, m2 .0004. m10 not strict, level defined (.0004) and price .0002 is below it, so the level becomes .0002.
Level points: m1 (.0004), m2 (.0004), m10 (.0002).
Holds: m1->m2 60; m2->m10 480; m10 (T0+600) -> asOf (T0+660) 60. Levels $400k, $400k, $200k: all at or above $100k: 60+480+60 = 600. None above $1M.
Drawdown: (.0004-.0002)/.0004 = 50%.
Rug: crash level would have to be at or below .2 * .0004 = .00008. The lowest level is .0002. False.
`,
  input: input(
    [
      pool('pool-a', [
        bar(minute(0), 0.0004),
        bar(minute(1), 0.0004),
        bar(minute(2), 0.0004),
        bar(minute(10), 0.0002, { volumeUsd: 100, trades: 1, traders: 1 }),
      ]),
    ],
    minute(11),
  ),
  expected: {
    athMarketCapUsd: 400_000,
    athAt: 1_699_920_060,
    athPoolAddress: 'pool-a',
    secondsToAth: 60,
    athWickMarketCapUsd: 400_000,
    athWickAt: 1_699_920_000,
    athWickPoolAddress: 'pool-a',
    secondsAbove: [600, 0, 0, 0],
    maxDrawdownPct: 50,
    rugPattern: false,
    flags: [],
  },
};
