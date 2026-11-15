import type { MetricFixture } from '../../../src/metrics/types.js';
import { bar, input, minute, pool } from './build.js';

export const exactWindowTraders5: MetricFixture = {
  name: 'exact-window-traders-5',
  description:
    'A window whose best minute has exactly 5 traders is strict: the traders comparison is inclusive.',
  reasoning: `
One primary pool, two bars: m0 close .0002, 2,000 USD, traders 5; m1 close .0002, 2,000 USD, traders 5. asOf = m2, launchedAt = T0.

Windows:
m0: one bar, not strict.
m1: two bars, volume 4000 >= 1000, traders max(5,5) = 5 = minWindowTraders exactly. Inclusive: strict. Price .0002.

ATH = 200,000 at m1: athAt = T0+60, secondsToAth 60. Wick: .0002 at T0: 200,000.
Level: one level point at m1 holding 60 s to asOf. secondsAbove [60,0,0,0]. Drawdown 0. Rug false.

Rules v4 (this paragraph supersedes any wick figure above). athLiquidityUsd null (no bar of the ATH window reports liquidity); athHourVolumeUsd 4,000 (volume of the clean 1-minute bars of every pool in the hour ending at m1). Wick: only a clean 1-minute bar with at least $1,000 of volume and 5 traders of its own, funded or of unknown liquidity, is a candidate, valued at max(open, close); the ATH takes over when higher. The wick is unchanged.
`,
  input: input(
    [
      pool('pool-a', [
        bar(minute(0), 0.0002, { volumeUsd: 2_000, traders: 5 }),
        bar(minute(1), 0.0002, { volumeUsd: 2_000, traders: 5 }),
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
    athLiquidityUsd: null,
    athHourVolumeUsd: 4_000,
    secondsAbove: [60, 0, 0, 0],
    maxDrawdownPct: 0,
    rugPattern: false,
    flags: [],
  },
};
