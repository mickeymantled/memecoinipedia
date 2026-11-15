import type { MetricFixture } from '../../../src/metrics/types.js';
import { flatRun, input, minute, minuteRun, pool } from './build.js';

const poolA = pool('pool-a', flatRun(0, 5, 0.0002, { volumeUsd: 600, liquidityUsd: 20_000 }));
const poolB = pool(
  'pool-b',
  minuteRun(5, [0.002, 0.002, 0.002, 0.00005, 0.00005], {
    volumeUsd: 3_000,
    traders: 10,
    liquidityUsd: 300,
  }),
);

export const neverFundedPoolCannotSetAthAndLowersLevel: MetricFixture = {
  name: 'never-funded-pool-cannot-set-ath-and-lowers-level',
  description:
    'A primary pool whose every bar reports 300 USD of liquidity trades at ten times the real price on heavy volume, then prints a very low price. Its windows are never funded, so never strict: it cannot set the ATH or raise the level, but its low print still lowers the level.',
  reasoning: `
pool-a (primary): bars m0..m4, close .0002, 600 USD, 6 traders, liquidity 20,000.
pool-b (primary): bars m5..m9, closes .002, .002, .002, .00005, .00005; each 3,000 USD, 10 traders, liquidity 300 (under minWindowLiquidityUsd 5,000 on every bar). asOf = m10, launchedAt = T0.

Clean: nothing dropped (pool-b is primary, so the secondary liquidity rule does not touch it).

Windows. pool-a: m0 one bar, not strict. m1..m4: two or three bars, volume 1,200 to 1,800, traders 6, liquidity 20,000 (funded): strict, price .0002.
pool-b: liquidity is 300 in every window, below 5,000: not funded, so not strict whatever the volume. Prices: m5 .002 (one bar); m6 .002; m7 .002; m8 closes .002,.002,.00005 -> .002; m9 closes .002,.00005,.00005 -> .00005.
The two pools never share a minute, so every minute is that pool's point.

ATH: strict 1-minute points are m1..m4 of pool-a, all .0002: ATH 200,000 at m1 (earliest), pool-a, secondsToAth 60. pool-b's .002 ($2,000,000) cannot set it.
athLiquidityUsd: the ATH window (m0, m1) reports 20,000. athHourVolumeUsd: bars of every pool in (m1 - 3,600, m1]: pool-a m0 and m1, 600 + 600 = 1,200 (pool-b starts at m5).
Wick: pool-a bars have 600 USD, under 1,000, so they are not candidates. pool-b bars have the volume and traders but are not funded (own liquidity 300, previous bar 300). No candidate: the wick is the ATH, 200,000 at m1, pool-a.

Level: m0 does nothing. m1..m4 strict, level .0002. m5..m8 are not strict and their price .002 is above the level: the level stays .0002 (they still give level points). m9 is not strict and its price .00005 is below the level: the level becomes .00005.
Level points m1..m9. Holds: m1..m8 60 s each at .0002 = 480 s above $100k; m9 holds 60 s at $50,000, not above. secondsAbove [480, 0, 0, 0].
Drawdown (.0002 - .00005) / .0002 = 75. Rug: the lowest level .00005 is above 20% of the ATH (.00004): false.
`,
  input: input([poolA, poolB], minute(10)),
  expected: {
    athMarketCapUsd: 200_000,
    athAt: 1_699_920_060,
    athPoolAddress: 'pool-a',
    secondsToAth: 60,
    athWickMarketCapUsd: 200_000,
    athWickAt: 1_699_920_060,
    athWickPoolAddress: 'pool-a',
    athLiquidityUsd: 20_000,
    athHourVolumeUsd: 1_200,
    secondsAbove: [480, 0, 0, 0],
    maxDrawdownPct: 75,
    rugPattern: false,
    flags: [],
  },
};
