import type { MetricFixture } from '../../../src/metrics/types.js';
import { flatRun, input, minute, pool } from './build.js';

export const unknownLiquidityCountsAsFunded: MetricFixture = {
  name: 'unknown-liquidity-counts-as-funded',
  description:
    'No bar reports liquidity. Unknown is not low: the windows are funded, the ATH is set, and athLiquidityUsd is null.',
  reasoning: `
One primary pool, bars m0..m2: close .0003, 600 USD, 6 traders, liquidity null. asOf = m3, launchedAt = T0.

Windows: m0 one bar, not strict. m1: bars m0, m1, volume 1,200, traders 6. No bar reports liquidity, so the window's liquidity is null and it is funded. Strict, price .0003. m2: bars m0..m2, volume 1,800, funded, strict, .0003.
ATH: .0003 * 1e9 = 300,000 at m1 (earliest), secondsToAth 60. athLiquidityUsd null: no bar of the window reports it. athHourVolumeUsd: m0 + m1 = 600 + 600 = 1,200.
Wick: every bar has 600 USD, under 1,000: no candidate, so the wick is the ATH, 300,000 at m1.
Level: m0 nothing; m1 and m2 .0003. Holds: m1 -> m2 60; m2 -> asOf 60. 120 s above $100k, none above $1M. Drawdown 0. Rug false.
`,
  input: input([pool('pool-a', flatRun(0, 3, 0.0003, { volumeUsd: 600 }))], minute(3)),
  expected: {
    athMarketCapUsd: 300_000,
    athAt: 1_699_920_060,
    athPoolAddress: 'pool-a',
    secondsToAth: 60,
    athWickMarketCapUsd: 300_000,
    athWickAt: 1_699_920_060,
    athWickPoolAddress: 'pool-a',
    athLiquidityUsd: null,
    athHourVolumeUsd: 1_200,
    secondsAbove: [120, 0, 0, 0],
    maxDrawdownPct: 0,
    rugPattern: false,
    flags: [],
  },
};
