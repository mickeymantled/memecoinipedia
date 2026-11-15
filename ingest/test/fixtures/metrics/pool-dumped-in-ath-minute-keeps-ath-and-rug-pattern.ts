import type { MetricFixture } from '../../../src/metrics/types.js';
import { bar, input, minute, pool } from './build.js';

const bars = [
  bar(minute(0), 0.001, { volumeUsd: 300, liquidityUsd: 40_000 }),
  bar(minute(1), 0.001, { volumeUsd: 300, liquidityUsd: 40_000 }),
  bar(minute(2), 0.00008, {
    o: 0.001,
    h: 0.001,
    volumeUsd: 5_000,
    traders: 30,
    liquidityUsd: 900,
  }),
  bar(minute(3), 0.00004, { volumeUsd: 3_000, traders: 20, liquidityUsd: 800 }),
];

export const poolDumpedInAthMinuteKeepsAthAndRugPattern: MetricFixture = {
  name: 'pool-dumped-in-ath-minute-keeps-ath-and-rug-pattern',
  description:
    'A funded pool is dumped in the minute that sets the ATH: the dump bar reports 900 USD of liquidity, but the window also holds the funded bars before it. The window is funded, so the ATH and the wick stay, and the fast fall is a rug pattern.',
  reasoning: `
One primary pool. Bars (close, USD, traders, liquidity):
m0 .001, 300, 6, 40,000; m1 .001, 300, 6, 40,000;
m2 o .001, h .001, l .00008, c .00008, 5,000, 30, 900 (the dump);
m3 .00004, 3,000, 20, 800. asOf = m4, launchedAt = T0.

Windows:
m0: one bar, not strict, price .001, liquidity 40,000.
m1: bars m0, m1: volume 600, under 1,000: not strict. Price .001.
m2: bars m0, m1, m2: closes .001, .001, .00008 -> .001. Volume 5,600, traders 30. Liquidity = the largest of 40,000, 40,000 and 900 = 40,000: funded. Strict, price .001.
m3: bars m1, m2, m3: closes .001, .00008, .00004 -> .00008. Volume 8,300, liquidity max(40,000, 900, 800) = 40,000: funded. Strict, price .00008.

ATH: strict 1-minute points m2 (.001) and m3 (.00008): ATH 1,000,000 at m2, secondsToAth 120. athLiquidityUsd 40,000, the window's largest, not the dump bar's 900. athHourVolumeUsd: m0, m1, m2 = 300 + 300 + 5,000 = 5,600.
Wick: m0 and m1 have 300 USD: no. m2: 5,000 USD, 30 traders, liquidity max(900, previous bar's 40,000) = 40,000: candidate, value max(.001, .00008) = .001. m3: 3,000 USD, 20 traders, liquidity max(800, 900) = 900: not funded. Best candidate .001 at m2; the ATH price is not higher, so the wick stays on the candidate: 1,000,000 at m2, pool-a.

Level: m0 and m1 do nothing (level undefined, not strict). m2 sets .001, m3 sets .00008. Holds: m2 -> m3 60 s at $1,000,000 (above $100k and $1M); m3 -> asOf 60 s at $80,000 (not above). secondsAbove [60, 60, 0, 0].
Drawdown (.001 - .00008) / .001 = 92.
Rug: the level point at m3 is after the ATH, within 1,800 s, at .00008, at or below 20% of the ATH (.0002). No strict point after m3: nothing recovers. True.
`,
  input: input([pool('pool-a', bars)], minute(4)),
  expected: {
    athMarketCapUsd: 1_000_000,
    athAt: 1_699_920_120,
    athPoolAddress: 'pool-a',
    secondsToAth: 120,
    athWickMarketCapUsd: 1_000_000,
    athWickAt: 1_699_920_120,
    athWickPoolAddress: 'pool-a',
    athLiquidityUsd: 40_000,
    athHourVolumeUsd: 5_600,
    secondsAbove: [60, 60, 0, 0],
    maxDrawdownPct: 92,
    rugPattern: true,
    flags: [],
  },
};
