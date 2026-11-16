import type { MetricFixture } from '../../../src/metrics/types.js';
import { input, minute, flatRun, pool } from './build.js';

export const equalVolumePrimaryPoolWins: MetricFixture = {
  name: 'equal-volume-primary-pool-wins',
  description:
    'Two pools with identical window volumes in every minute: the primary pool wins the tie, even though the secondary pool (listed first) shows a higher price.',
  reasoning: `
pool-b (secondary, liquidity 10,000), listed first: bars m0..m4, close .0003, 600 USD, 6 traders.
pool-a (primary): bars m0..m4, close .0002, 600 USD, 6 traders. asOf = m5, launchedAt = T0.

Windows: both pools have the same window volumes at every t: m0 600 (1 bar, not strict), m1 1200 (strict), m2 1800, m3 1800, m4 1800.
Tie on volume at every timestamp: the primary pool wins. So the coin points are pool-a's: m0 not strict, m1..m4 strict, price .0002.

ATH = .0002 * 1e9 = 200,000 at m1: athAt = T0+60, pool-a, secondsToAth 60.
Wick: .0003 (pool-b, a clean eligible bar), first at m0: T0, pool-b, 300,000.
Level points m1..m4, .0002. Holds 60,60,60 and 60 (m4 at T0+240 to asOf T0+300) = 240 above $100k.
Drawdown 0. Rug false.

Rules v4 (this paragraph supersedes any wick figure above). athLiquidityUsd null (no bar of the ATH window reports liquidity); athHourVolumeUsd 2,400 (volume of the clean 1-minute bars of every pool in the hour ending at m1). Wick: only a clean 1-minute bar with at least $1,000 of volume and 5 traders of its own, funded or of unknown liquidity, is a candidate, valued at max(open, close); the ATH takes over when higher. Here the best candidate is not above the ATH (or there is none), so the wick is the ATH: 200,000 at m1.
`,
  input: input(
    [
      pool('pool-b', flatRun(0, 5, 0.0003, { volumeUsd: 600, liquidityUsd: 10_000 }), {
        isPrimary: false,
      }),
      pool('pool-a', flatRun(0, 5, 0.0002, { volumeUsd: 600 })),
    ],
    minute(5),
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
    athHourVolumeUsd: 2_400,
    secondsAbove: [240, 0, 0, 0],
    maxDrawdownPct: 0,
    rugPattern: false,
    flags: [],
  },
};
