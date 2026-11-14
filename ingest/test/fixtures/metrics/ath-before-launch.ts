import type { MetricFixture } from '../../../src/metrics/types.js';
import { flatRun, input, minute, pool } from './build.js';

export const athBeforeLaunch: MetricFixture = {
  name: 'ath-before-launch',
  description:
    'The ATH falls before launchedAt: secondsToAth is kept as a negative number and ath_before_launch is flagged.',
  reasoning: `
One primary pool, 1-minute bars m0, m1, m2: close .0002, 500 USD, 6 traders. launchedAt = T0+3,600 (an hour after the bars), asOf = m3 (T0+180).

Windows: m0 not strict; m1, m2 strict .0002.
ATH = 200,000 at m1: athAt = T0+60. secondsToAth = athAt - launchedAt = 60 - 3,600 = -3,540. It is negative, so keep it and raise ath_before_launch.
Wick: .0002 at m0 (T0): 200,000.
Level points m1, m2: holds m1 -> m2 60; m2 (T0+120) -> asOf (T0+180) 60. Total 120 above $100k.
Drawdown 0. Rug false.
`,
  input: input([pool('pool-a', flatRun(0, 3, 0.0002))], minute(3), 1_699_923_600),
  expected: {
    athMarketCapUsd: 200_000,
    athAt: 1_699_920_060,
    athPoolAddress: 'pool-a',
    secondsToAth: -3_540,
    athWickMarketCapUsd: 200_000,
    athWickAt: 1_699_920_000,
    athWickPoolAddress: 'pool-a',
    secondsAbove: [120, 0, 0, 0],
    maxDrawdownPct: 0,
    rugPattern: false,
    flags: ['ath_before_launch'],
  },
};
