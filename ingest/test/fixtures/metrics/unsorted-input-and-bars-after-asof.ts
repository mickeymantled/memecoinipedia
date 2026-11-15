import type { MetricFixture } from '../../../src/metrics/types.js';
import { bar, input, minute, pool } from './build.js';

export const unsortedInputAndBarsAfterAsOf: MetricFixture = {
  name: 'unsorted-input-and-bars-after-asof',
  description:
    'Bars arrive in scrambled order. Bars after asOf are ignored before any validity check, so a bad bar and an implausible bar after asOf raise no flag.',
  reasoning: `
One primary pool. Bars, in this scrambled input order: m3, m6, m1, m4, m7, m0, m5, m2. asOf = m4 (T0+240), launchedAt = T0.
m0..m4: close .0002 (500 USD, 6 traders).
m5: close .001 (valid, but after asOf).
m6: all prices 0 (would be bad, but after asOf).
m7: all prices 50 (would be above $20B, but after asOf).

Clean: step 1 ignores every bar with t > asOf: m5, m6, m7 go first. Because they are ignored before the validity checks, neither bad_bar nor implausible_market_cap is raised. The m4 bar has t = asOf and stays. After sorting by t: m0..m4.

Windows: m0 one bar, not strict. m1..m4 strict .0002.
ATH = 200,000 at m1: athAt = T0+60, secondsToAth 60.
Wick: .0002 at m0 (T0): 200,000. The .001 bar after asOf does not count.
Level points m1, m2, m3, m4: holds 60, 60, 60, and m4 (T0+240) to asOf (T0+240) = 0. Total 180 above $100k.
Drawdown 0. Rug false. No flags.

Rules v4 (this paragraph supersedes any wick figure above). athLiquidityUsd null (no bar of the ATH window reports liquidity); athHourVolumeUsd 1,000 (volume of the clean 1-minute bars of every pool in the hour ending at m1). Wick: only a clean 1-minute bar with at least $1,000 of volume and 5 traders of its own, funded or of unknown liquidity, is a candidate, valued at max(open, close); the ATH takes over when higher. Here the best candidate is not above the ATH (or there is none), so the wick is the ATH: 200,000 at m1.
`,
  input: input(
    [
      pool('pool-a', [
        bar(minute(3), 0.0002),
        bar(minute(6), 0, { o: 0, h: 0, l: 0 }),
        bar(minute(1), 0.0002),
        bar(minute(4), 0.0002),
        bar(minute(7), 50),
        bar(minute(0), 0.0002),
        bar(minute(5), 0.001),
        bar(minute(2), 0.0002),
      ]),
    ],
    minute(4),
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
    secondsAbove: [180, 0, 0, 0],
    maxDrawdownPct: 0,
    rugPattern: false,
    flags: [],
  },
};
