import type { MetricFixture } from '../../../src/metrics/types.js';
import { input, minute, flatRun, pool } from './build.js';

export const equalVolumeSmallestAddressWins: MetricFixture = {
  name: 'equal-volume-smallest-address-wins',
  description:
    'Two primary pools with identical window volumes: neither is preferred as primary, so the smallest address wins, even though it has the lower price and is listed second.',
  reasoning: `
Both pools are primary (for example a bonding curve record and the graduated pool). pool-b is listed first.
pool-b: bars m0..m4, close .0003, 600 USD, 6 traders.
pool-a: bars m0..m4, close .0002, 600 USD, 6 traders. asOf = m5, launchedAt = T0.

Windows: identical volumes in both pools at every t (600, 1200, 1800, 1800, 1800), so a tie. Both are primary, so the tie goes to the smallest address by string comparison: "pool-a" < "pool-b". Coin points are pool-a's, price .0002, strict from m1.
(Choosing the higher price or the later pool would give .0003; the rule gives .0002.)

ATH = 200,000 at m1: athAt = T0+60, pool-a, secondsToAth 60.
Wick: .0003 from pool-b, first at m0: T0, pool-b, 300,000.
Level points m1..m4 .0002: 60+60+60+60 = 240 above $100k.
Drawdown 0. Rug false.
`,
  input: input(
    [
      pool('pool-b', flatRun(0, 5, 0.0003, { volumeUsd: 600 })),
      pool('pool-a', flatRun(0, 5, 0.0002, { volumeUsd: 600 })),
    ],
    minute(5),
  ),
  expected: {
    athMarketCapUsd: 200_000,
    athAt: 1_699_920_060,
    athPoolAddress: 'pool-a',
    secondsToAth: 60,
    athWickMarketCapUsd: 300_000,
    athWickAt: 1_699_920_000,
    athWickPoolAddress: 'pool-b',
    secondsAbove: [240, 0, 0, 0],
    maxDrawdownPct: 0,
    rugPattern: false,
    flags: [],
  },
};
