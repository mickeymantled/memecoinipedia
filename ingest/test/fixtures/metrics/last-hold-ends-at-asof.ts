import type { MetricFixture } from '../../../src/metrics/types.js';
import { bar, input, minute, pool } from './build.js';

export const lastHoldEndsAtAsOf: MetricFixture = {
  name: 'last-hold-ends-at-asof',
  description:
    'The last level point holds until asOf when asOf is within the carry-forward limit: one hour after the last bar gives 3,600 seconds.',
  reasoning: `
One primary pool, bars m0 and m1: close .0002, 500 USD, 6 traders. asOf = T0+3,660 (one hour after m1), launchedAt = T0.

Windows: m0 one bar, not strict. m1 two bars, volume 1000, traders 6: strict, .0002.
ATH = 200,000 at m1: athAt = T0+60, secondsToAth 60. Wick: .0002 at m0 (T0): 200,000.
Level: one level point (m1, .0002). It is the last one so it holds until asOf: 3,660 - 60 = 3,600 s, which is under 86,400, so uncapped.
secondsAbove [3600,0,0,0]. Drawdown 0. Rug false.
`,
  input: input([pool('pool-a', [bar(minute(0), 0.0002), bar(minute(1), 0.0002)])], 1_699_923_660),
  expected: {
    athMarketCapUsd: 200_000,
    athAt: 1_699_920_060,
    athPoolAddress: 'pool-a',
    secondsToAth: 60,
    athWickMarketCapUsd: 200_000,
    athWickAt: 1_699_920_000,
    athWickPoolAddress: 'pool-a',
    secondsAbove: [3_600, 0, 0, 0],
    maxDrawdownPct: 0,
    rugPattern: false,
    flags: [],
  },
};
