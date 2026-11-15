import type { MetricFixture } from '../../../src/metrics/types.js';
import { bar, flatRun, hourAt, input, pool } from './build.js';

export const strictHourlyBelowAthNoCoverageFlag: MetricFixture = {
  name: 'strict-hourly-below-ath-no-coverage-flag',
  description:
    'A strict hourly point below the 1-minute ATH does not raise peak_outside_minute_coverage, but it still sets the level (lowering it), which drives drawdown.',
  reasoning: `
One primary pool. 1-minute bars m0..m3: close .0004, 500 USD, 6 traders. Hourly bar H1 at T0+3,600: o = h = l = c = .0003, 5,000 USD, 10 traders. asOf = T0+7,200, launchedAt = T0.

Windows: m0 not strict; m1, m2, m3 strict .0004. H1: no 1-minute bar in hour 1, so a window: strict (5,000 USD, 10 traders), price .0003.

ATH = .0004 * 1e9 = 400,000 at m1: athAt = T0+60, secondsToAth 60.
Wick: .0004 at m0 (T0): 400,000.
Coverage: H1's price .0003 is not above the ATH price .0004: no flag.

Level: m1, m2, m3 .0004. H1 is strict so it sets the level to its price even though that is lower: .0003.
Level points: m1, m2, m3, H1 (T0+3,600).
Holds: 60, 60, m3 (T0+180) -> H1 3,420, H1 -> asOf 3,600. All at or above $100k ($400k, $300k): 60+60+3,420+3,600 = 7,140. None above $1M.
Drawdown: (.0004-.0003)/.0004 = 25%.
Rug: nothing at or below .2 * .0004 = .00008. False. No flags.

Rules v4 (this paragraph supersedes any wick figure above). athLiquidityUsd null (no bar of the ATH window reports liquidity); athHourVolumeUsd 1,000 (volume of the clean 1-minute bars of every pool in the hour ending at m1). Wick: only a clean 1-minute bar with at least $1,000 of volume and 5 traders of its own, funded or of unknown liquidity, is a candidate, valued at max(open, close); the ATH takes over when higher. Here the best candidate is not above the ATH (or there is none), so the wick is the ATH: 400,000 at m1.
`,
  input: input(
    [
      pool('pool-a', flatRun(0, 4, 0.0004), {
        bars1h: [bar(hourAt(1), 0.0003, { volumeUsd: 5_000, traders: 10 })],
      }),
    ],
    hourAt(2),
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
    secondsAbove: [7_140, 0, 0, 0],
    maxDrawdownPct: 25,
    rugPattern: false,
    flags: [],
  },
};
