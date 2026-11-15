import type { MetricFixture } from '../../../src/metrics/types.js';
import { bar, input, minute, pool } from './build.js';

const bars = [
  bar(minute(0), 0.0002, { volumeUsd: 600 }),
  bar(minute(1), 0.0002, { volumeUsd: 600 }),
  bar(minute(2), 0.0004, { volumeUsd: 1_500 }),
  // A wild high inside a minute that opened and closed at .0002.
  bar(minute(10), 0.0002, { h: 0.5, volumeUsd: 1_500 }),
  // A higher close on 900 USD, and one on four traders.
  bar(minute(20), 0.0009, { volumeUsd: 900 }),
  bar(minute(30), 0.0008, { volumeUsd: 1_500, traders: 4 }),
];

export const wickIgnoresWildHighAndThinMinutes: MetricFixture = {
  name: 'wick-ignores-wild-high-and-thin-minutes',
  description:
    'The wick is the highest open or close of a 1-minute bar with 1,000 USD and 5 traders of its own. A bar high of $500 million, a close on 900 USD and a close on 4 traders do not count; a lone busy minute above the ATH does.',
  reasoning: `
One primary pool, liquidity null, 6 traders unless stated. asOf = m31, launchedAt = T0.
m0 .0002, 600 USD; m1 .0002, 600 USD; m2 .0004, 1,500 USD;
m10 o .0002, h .5, l .0002, c .0002, 1,500 USD (wild high);
m20 .0009, 900 USD; m30 .0008, 1,500 USD, 4 traders.

Windows: m0 one bar, not strict. m1 (m0, m1) 1,200 USD, strict, .0002. m2 (m0, m1, m2): closes .0002, .0002, .0004 -> .0002, 2,700 USD, strict. m10, m20, m30 are alone in their 3 minutes: one bar, never strict; their prices (.0002, .0009, .0008) are not below the level.
ATH: .0002 at m1: 200,000, secondsToAth 60. athLiquidityUsd null. athHourVolumeUsd: m0 + m1 = 1,200.
Wick candidates: m0, m1 (600 USD): no. m2 (1,500 USD, 6 traders, unknown liquidity): yes, value .0004. m10 (1,500 USD, 6 traders): yes, value max(o, c) = .0002; its high of .5 is not read. m20: 900 USD, no. m30: 4 traders, no. The best is .0004 at m2, above the ATH: wick 400,000 at m2, pool-a. (The old rule would have stored $500,000,000 from the m10 high.)
Level: m1, m2 strict .0002; m10, m20, m30 not strict and not below: level .0002 at every level point m1, m2, m10, m20, m30. Holds: 60, 480, 600, 600, and m30 -> asOf 60 = 1,800 s above $100k. Drawdown 0. Rug false.
`,
  input: input([pool('pool-a', bars)], minute(31)),
  expected: {
    athMarketCapUsd: 200_000,
    athAt: 1_699_920_060,
    athPoolAddress: 'pool-a',
    secondsToAth: 60,
    athWickMarketCapUsd: 400_000,
    athWickAt: 1_699_920_120,
    athWickPoolAddress: 'pool-a',
    athLiquidityUsd: null,
    athHourVolumeUsd: 1_200,
    secondsAbove: [1_800, 0, 0, 0],
    maxDrawdownPct: 0,
    rugPattern: false,
    flags: [],
  },
};
