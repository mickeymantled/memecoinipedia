import type { MetricFixture } from '../../../src/metrics/types.js';
import { bar, input, minute, pool } from './build.js';

export const sparseWindowTwoBars120sApart: MetricFixture = {
  name: 'sparse-window-two-bars-120s-apart',
  description:
    'Bars at t-120 and t only: the window has two bars, so it can be strict, and its price is the lower of the two closes.',
  reasoning: `
One primary pool. m0: close .0002, 500 USD, 6 traders. m2: close .0003, 500 USD, 6 traders. No bar at m1. asOf = m3, launchedAt = T0.

Windows:
m0: bars m-2..m0 -> only m0. One bar, not strict, price .0002.
m2: bars at t-120 (m0), t-60 (absent), t (m2): two bars. Volume 1000 >= 1000, traders 6 >= 5, so strict. Lower median of closes .0002 and .0003 is the lower one, .0002.

ATH = .0002 * 1e9 = 200,000 at m2: athAt = T0+120, secondsToAth 120.
Wick: .0003 at m2 (T0+120): 300,000 (the window used the lower close, the wick sees the higher).
Level: m0 ignored (undefined, not strict). m2 strict: level .0002, one level point at T0+120 holding to asOf (T0+180) = 60 s. secondsAbove [60,0,0,0]. Drawdown 0. Rug: no level point after athAt, false.
`,
  input: input([pool('pool-a', [bar(minute(0), 0.0002), bar(minute(2), 0.0003)])], minute(3)),
  expected: {
    athMarketCapUsd: 200_000,
    athAt: 1_699_920_120,
    athPoolAddress: 'pool-a',
    secondsToAth: 120,
    athWickMarketCapUsd: 300_000,
    athWickAt: 1_699_920_120,
    athWickPoolAddress: 'pool-a',
    secondsAbove: [60, 0, 0, 0],
    maxDrawdownPct: 0,
    rugPattern: false,
    flags: [],
  },
};
