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

Rules v4 (this paragraph supersedes any wick figure above). athLiquidityUsd null (no bar of the ATH window reports liquidity); athHourVolumeUsd 1,000 (volume of the clean 1-minute bars of every pool in the hour ending at m1). Wick: only a clean 1-minute bar with at least $1,000 of volume and 5 traders of its own, funded or of unknown liquidity, is a candidate, valued at max(open, close); the ATH takes over when higher. Here the best candidate is not above the ATH (or there is none), so the wick is the ATH: 200,000 at m1.
`,
  input: input([pool('pool-a', [bar(minute(0), 0.0002), bar(minute(1), 0.0002)])], 1_699_923_660),
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
    secondsAbove: [3_600, 0, 0, 0],
    maxDrawdownPct: 0,
    rugPattern: false,
    flags: [],
  },
};
