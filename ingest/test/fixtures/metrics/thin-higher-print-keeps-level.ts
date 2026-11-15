import type { MetricFixture } from '../../../src/metrics/types.js';
import { bar, input, minute, pool } from './build.js';

export const thinHigherPrintKeepsLevel: MetricFixture = {
  name: 'thin-higher-print-keeps-level',
  description:
    'A non-strict print above the level does not raise it, but it still produces a level point at the unchanged level; the wick ignores it (a thin minute is not a candidate).',
  reasoning: `
One primary pool. m0, m1, m2: close .0002 (500 USD, 6 traders). m10: close .0008, 100 USD, 1 trader. asOf = m11, launchedAt = T0.

Windows: m0 one bar, not strict. m1, m2 strict .0002. m10 one bar, not strict, price .0008.
ATH = 200,000 at m1: athAt = T0+60, secondsToAth 60.
Wick: .0008 at m10 (T0+600): 800,000.
Level: m1 .0002, m2 .0002. m10 not strict, price .0008 is above the level, so the level stays .0002 (a thin high print is not proof anyone could sell there). A level point (m10, .0002) is still produced.
Level points m1, m2, m10 all .0002. Holds: m1->m2 60; m2->m10 480; m10 (T0+600) -> asOf (T0+660) 60. Total 600 above $100k. None above $1M (the level never reached $800k).
Drawdown 0. Rug false.

Rules v4 (this paragraph supersedes any wick figure above). athLiquidityUsd null (no bar of the ATH window reports liquidity); athHourVolumeUsd 1,000 (volume of the clean 1-minute bars of every pool in the hour ending at m1). Wick: only a clean 1-minute bar with at least $1,000 of volume and 5 traders of its own, funded or of unknown liquidity, is a candidate, valued at max(open, close); the ATH takes over when higher. Here the best candidate is not above the ATH (or there is none), so the wick is the ATH: 200,000 at m1.
`,
  input: input(
    [
      pool('pool-a', [
        bar(minute(0), 0.0002),
        bar(minute(1), 0.0002),
        bar(minute(2), 0.0002),
        bar(minute(10), 0.0008, { volumeUsd: 100, trades: 1, traders: 1 }),
      ]),
    ],
    minute(11),
  ),
  expected: {
    athMarketCapUsd: 200_000,
    athAt: 1_699_920_060,
    athPoolAddress: 'pool-a',
    secondsToAth: 60,
    athWickMarketCapUsd: 200_000,
    athWickAt: 1_699_920_060,
    athWickPoolAddress: 'pool-a',
    athLiquidityUsd: null,
    athHourVolumeUsd: 1_000,
    secondsAbove: [600, 0, 0, 0],
    maxDrawdownPct: 0,
    rugPattern: false,
    flags: [],
  },
};
