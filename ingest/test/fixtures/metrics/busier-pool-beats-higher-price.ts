import type { MetricFixture } from '../../../src/metrics/types.js';
import { input, minute, flatRun, pool } from './build.js';

export const busierPoolBeatsHigherPrice: MetricFixture = {
  name: 'busier-pool-beats-higher-price',
  description:
    'Two eligible pools trade in the same minutes. The less busy pool shows a higher price, but the busier pool wins every timestamp. No bar of either pool has $1,000 of volume of its own, so none is a wick candidate and the wick is the ATH.',
  reasoning: `
pool-a (primary): bars m0..m4, close .0002, 800 USD, 6 traders.
pool-b (secondary, liquidity 10,000, passes): bars m0..m4, close .0003, 400 USD, 6 traders. asOf = m5, launchedAt = T0.

Windows per pool (volume = sum over bars present):
pool-a: m0 800 (1 bar, not strict), m1 1600 strict, m2 2400 strict, m3 2400, m4 2400, price .0002.
pool-b: m0 400 (1 bar), m1 800 (not strict: under 1000), m2 1200 strict, m3 1200, m4 1200, price .0003.

One point per timestamp: the largest window volume wins. pool-a wins at m0 (800 v 400), m1 (1600 v 800), m2, m3, m4 (2400 v 1200). pool-b never wins, though its price is higher.
Coin points: m0 not strict; m1..m4 strict; all pool-a at .0002.

ATH = .0002 * 1e9 = 200,000 at m1: athAt = T0+60, pool-a, secondsToAth 60.
Wick: over every clean bar of both pools, the highest value is .0003 (pool-b), first at m0: T0, pool-b, 300,000.
Level points m1..m4 (m0 ignored), .0002. Holds 60,60,60 and m4 (T0+240) to asOf (T0+300) 60 = 240 above $100k.
Drawdown 0. Rug false.

Rules v4 (this paragraph supersedes any wick figure above). athLiquidityUsd null (no bar of the ATH window reports liquidity); athHourVolumeUsd 2,400 (volume of the clean 1-minute bars of every pool in the hour ending at m1). Wick: only a clean 1-minute bar with at least $1,000 of volume and 5 traders of its own, funded or of unknown liquidity, is a candidate, valued at max(open, close); the ATH takes over when higher. Here the best candidate is not above the ATH (or there is none), so the wick is the ATH: 200,000 at m1.
`,
  input: input(
    [
      pool('pool-a', flatRun(0, 5, 0.0002, { volumeUsd: 800 })),
      pool('pool-b', flatRun(0, 5, 0.0003, { volumeUsd: 400, liquidityUsd: 10_000 }), {
        isPrimary: false,
      }),
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
