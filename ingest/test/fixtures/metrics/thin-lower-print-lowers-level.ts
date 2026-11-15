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

Rules v4 (this paragraph supersedes any wick figure above). athLiquidityUsd null (no bar of the ATH window reports liquidity); athHourVolumeUsd 1,000 (volume of the clean 1-minute bars of every pool in the hour ending at m1). Wick: only a clean 1-minute bar with at least $1,000 of volume and 5 traders of its own, funded or of unknown liquidity, is a candidate, valued at max(open, close); the ATH takes over when higher. Here the best candidate is not above the ATH (or there is none), so the wick is the ATH: 400,000 at m1.
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
    athWickAt: 1_699_920_060,
    athWickPoolAddress: 'pool-a',
    athLiquidityUsd: null,
    athHourVolumeUsd: 1_000,
    secondsAbove: [600, 0, 0, 0],
    maxDrawdownPct: 50,
    rugPattern: false,
    flags: [],
  },
};
