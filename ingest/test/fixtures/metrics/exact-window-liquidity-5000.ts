import type { MetricFixture } from '../../../src/metrics/types.js';
import { bar, input, minute, pool } from './build.js';

const bars = [
  bar(minute(0), 0.0002, { volumeUsd: 1_200, liquidityUsd: 5_000 }),
  bar(minute(1), 0.0002, { volumeUsd: 1_200, liquidityUsd: 4_999 }),
  bar(minute(2), 0.0002, { volumeUsd: 1_200, liquidityUsd: 4_999 }),
  bar(minute(3), 0.0004, { volumeUsd: 1_200, liquidityUsd: 4_999 }),
  bar(minute(4), 0.0004, { volumeUsd: 1_200, liquidityUsd: 4_999 }),
];

export const exactWindowLiquidity5000: MetricFixture = {
  name: 'exact-window-liquidity-5000',
  description:
    'A window whose largest liquidity is exactly 5,000 is funded; one at 4,999 is not. The wick tests only the bar and the previous bar of its pool, so the unfunded higher minutes are ignored.',
  reasoning: `
One primary pool, bars m0..m4, each 1,200 USD, 6 traders. Closes and liquidity: m0 .0002 / 5,000; m1 .0002 / 4,999; m2 .0002 / 4,999; m3 .0004 / 4,999; m4 .0004 / 4,999. asOf = m5, launchedAt = T0.

Windows:
m0: one bar, not strict, .0002.
m1: bars m0, m1: liquidity max(5,000, 4,999) = 5,000, exactly the limit: funded (comparisons are inclusive). Volume 2,400. Strict, .0002.
m2: bars m0..m2: largest 5,000: funded, strict, .0002.
m3: bars m1, m2, m3: largest 4,999: not funded, not strict. Closes .0002, .0002, .0004 -> .0002.
m4: bars m2, m3, m4: largest 4,999: not funded, not strict. Closes .0002, .0004, .0004 -> .0004.

ATH: strict points m1, m2, both .0002: 200,000 at m1, secondsToAth 60. The unfunded .0004 at m4 cannot set it. athLiquidityUsd 5,000. athHourVolumeUsd: m0 + m1 = 2,400.
Wick: m0: liquidity 5,000, funded; 1,200 USD, 6 traders: candidate, .0002. m1: own 4,999, previous bar 5,000: funded, candidate, .0002. m2: own 4,999, previous 4,999: not funded. m3 and m4: not funded, so their .0004 is ignored. Best .0002, first at m0; the ATH is not higher: wick 200,000 at m0, pool-a.
Level: m1, m2 strict .0002. m3 not strict, price .0002 is not below the level: unchanged. m4 not strict, .0004 above the level: unchanged. Level points m1..m4 at .0002. Holds 60 each for m1, m2, m3, and m4 -> asOf 60: 240 s above $100k. Drawdown 0. Rug false.
`,
  input: input([pool('pool-a', bars)], minute(5)),
  expected: {
    athMarketCapUsd: 200_000,
    athAt: 1_699_920_060,
    athPoolAddress: 'pool-a',
    secondsToAth: 60,
    athWickMarketCapUsd: 200_000,
    athWickAt: 1_699_920_000,
    athWickPoolAddress: 'pool-a',
    athLiquidityUsd: 5_000,
    athHourVolumeUsd: 2_400,
    secondsAbove: [240, 0, 0, 0],
    maxDrawdownPct: 0,
    rugPattern: false,
    flags: [],
  },
};
