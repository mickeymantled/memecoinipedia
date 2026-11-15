import type { MetricFixture } from '../../../src/metrics/types.js';
import { bar, input, minute, minuteRun, pool } from './build.js';

export const exactSecondaryLiquidity5000: MetricFixture = {
  name: 'exact-secondary-liquidity-5000',
  description:
    'A secondary pool with liquidity of exactly 5,000 is kept; one with 4,999 is dropped. The kept pool is the busiest, so it sets the ATH; the wick is the ATH too, since no bar has $1,000 of volume of its own.',
  reasoning: `
Three pools, bars m0..m3 each, asOf = m4, launchedAt = T0.
pool-a (primary, liquidity null): close .0002, 300 USD, 6 traders.
pool-b (secondary, liquidity 5,000 exactly): close .0004, 600 USD, 6 traders.
pool-c (secondary, liquidity 4,999): close .001, 900 USD, 6 traders.

Clean: pool-c's bars are dropped (4,999 < 5,000, no flag). pool-b's are kept (5,000 is not below 5,000). pool-a is primary and never dropped.

Windows per pool:
pool-a: m0 vol 300 (1 bar, not strict); m1 vol 600 (not strict); m2 vol 900; m3 vol 900. None strict, none >= 1000.
pool-b: m0 vol 600 (1 bar, not strict); m1 vol 1200 strict, price .0004; m2 vol 1800 strict; m3 vol 1800 strict.
At each t the larger volume wins: pool-b at m0 (600 vs 300), m1 (1200 vs 600), m2 (1800 vs 900), m3 (1800 vs 900). pool-c would have won every minute with higher volume and price if it had not been dropped.

Coin points: m0 pool-b not strict .0004; m1, m2, m3 pool-b strict .0004.
ATH = .0004 * 1e9 = 400,000, first strict point m1: athAt = T0+60, pool-b, secondsToAth 60.
Wick: .0004 at m0 (T0), pool-b (pool-c ignored entirely): 400,000.
Level: m0 ignored (undefined). m1,m2,m3 level .0004. Holds 60,60 and m3 (T0+180) -> asOf (T0+240) 60 = 180 above $100k.
Drawdown 0. Rug false.

Rules v4 (this paragraph supersedes any wick figure above). athLiquidityUsd 5,000 (the largest liquidity of the ATH window); athHourVolumeUsd 1,800 (volume of the clean 1-minute bars of every pool in the hour ending at m1). Wick: only a clean 1-minute bar with at least $1,000 of volume and 5 traders of its own, funded or of unknown liquidity, is a candidate, valued at max(open, close); the ATH takes over when higher. Here the best candidate is not above the ATH (or there is none), so the wick is the ATH: 400,000 at m1.
`,
  input: input(
    [
      pool('pool-a', minuteRun(0, [0.0002, 0.0002, 0.0002, 0.0002], { volumeUsd: 300 })),
      pool(
        'pool-b',
        minuteRun(0, [0.0004, 0.0004, 0.0004, 0.0004], { volumeUsd: 600, liquidityUsd: 5_000 }),
        {
          isPrimary: false,
        },
      ),
      pool(
        'pool-c',
        [0, 1, 2, 3].map((n) => bar(minute(n), 0.001, { volumeUsd: 900, liquidityUsd: 4_999 })),
        { isPrimary: false },
      ),
    ],
    minute(4),
  ),
  expected: {
    athMarketCapUsd: 400_000,
    athAt: 1_699_920_060,
    athPoolAddress: 'pool-b',
    secondsToAth: 60,
    athWickMarketCapUsd: 400_000,
    athWickAt: 1_699_920_060,
    athWickPoolAddress: 'pool-b',
    athLiquidityUsd: 5_000,
    athHourVolumeUsd: 1_800,
    secondsAbove: [180, 0, 0, 0],
    maxDrawdownPct: 0,
    rugPattern: false,
    flags: [],
  },
};
