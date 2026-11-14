import type { MetricFixture } from '../../../src/metrics/types.js';
import { bar, input, minute, pool } from './build.js';

export const thinHigherPrintKeepsLevel: MetricFixture = {
  name: 'thin-higher-print-keeps-level',
  description:
    'A non-strict print above the level does not raise it, but it still produces a level point at the unchanged level; the wick sees the high price.',
  reasoning: `
One primary pool. m0, m1, m2: close .0002 (500 USD, 6 traders). m10: close .0008, 100 USD, 1 trader. asOf = m11, launchedAt = T0.

Windows: m0 one bar, not strict. m1, m2 strict .0002. m10 one bar, not strict, price .0008.
ATH = 200,000 at m1: athAt = T0+60, secondsToAth 60.
Wick: .0008 at m10 (T0+600): 800,000.
Level: m1 .0002, m2 .0002. m10 not strict, price .0008 is above the level, so the level stays .0002 (a thin high print is not proof anyone could sell there). A level point (m10, .0002) is still produced.
Level points m1, m2, m10 all .0002. Holds: m1->m2 60; m2->m10 480; m10 (T0+600) -> asOf (T0+660) 60. Total 600 above $100k. None above $1M (the level never reached $800k).
Drawdown 0. Rug false.
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
    athWickMarketCapUsd: 800_000,
    athWickAt: 1_699_920_600,
    athWickPoolAddress: 'pool-a',
    secondsAbove: [600, 0, 0, 0],
    maxDrawdownPct: 0,
    rugPattern: false,
    flags: [],
  },
};
