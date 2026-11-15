import type { MetricFixture } from '../../../src/metrics/types.js';
import { bar, input, minute, pool } from './build.js';

export const barAtAsOfCountsLastHoldZero: MetricFixture = {
  name: 'bar-at-asof-counts-last-hold-zero',
  description:
    'A bar with t exactly equal to asOf is kept (only t greater than asOf is ignored), and its level point then holds for zero seconds. A later, higher bar is ignored.',
  reasoning: `
One primary pool, bars m0, m1, m2: close .0002, 500 USD, 6 traders. Also a bar at m3 with close .001 (500 USD, 6 traders). asOf = m2 (T0+120), launchedAt = T0.

Clean: the m3 bar has t = T0+180 > asOf, so it is ignored (before any other check). The m2 bar has t = asOf, which is not greater, so it is kept.

Windows: m0 one bar, not strict. m1 strict .0002. m2 bars m0,m1,m2, volume 1500, strict, .0002.
ATH = 200,000 at m1: athAt = T0+60, secondsToAth 60.
Wick: .0002 at m0 (T0): 200,000. The ignored m3 bar's .001 does not count.
Level points: m1 (.0002), m2 (.0002).
Holds: m1->m2 60 s; m2 (T0+120) -> asOf (T0+120) = 0 s.
secondsAbove [60,0,0,0]. Drawdown 0. Rug false.
`,
  input: input(
    [
      pool('pool-a', [
        bar(minute(0), 0.0002),
        bar(minute(1), 0.0002),
        bar(minute(2), 0.0002),
        bar(minute(3), 0.001),
      ]),
    ],
    minute(2),
  ),
  expected: {
    athMarketCapUsd: 200_000,
    athAt: 1_699_920_060,
    athPoolAddress: 'pool-a',
    secondsToAth: 60,
    athWickMarketCapUsd: 200_000,
    athWickAt: 1_699_920_000,
    athWickPoolAddress: 'pool-a',
    secondsAbove: [60, 0, 0, 0],
    maxDrawdownPct: 0,
    rugPattern: false,
    flags: [],
  },
};
