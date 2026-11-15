import type { MetricFixture } from '../../../src/metrics/types.js';
import { bar, input, minute, pool } from './build.js';

export const twoWalletWashLowTraders: MetricFixture = {
  name: 'two-wallet-wash-low-traders',
  description:
    'Two wallets trading back and forth: huge volume but only 2 traders per minute, so no window is strict. They cannot set the ATH or raise the level, nothing else: the wick needs five traders in the minute as well.',
  reasoning: `
One primary pool. m0..m3: close .00012, 500 USD, 6 traders (honest). m10..m13: close .0004, 5,000 USD each, traders 2 (wash trading). asOf = m14, launchedAt = T0.

Windows:
m0: one bar, not strict.
m1: .00012,.00012, volume 1000, traders 6, strict, .00012. m2, m3 likewise strict .00012.
m10: bars present within m8..m10: only m10. One bar, not strict.
m11: bars m10,m11, volume 10,000 but traders max(2,2) = 2 < 5: NOT strict, price .0004.
m12, m13: same, not strict, price .0004.
(No honest bar is within two minutes of m10, so the honest traders count cannot leak in.)

ATH: strict prices all .00012. ATH = 120,000, earliest m1: athAt = T0+60, secondsToAth 60.
Wick: .0004 at m10 (T0+600): 400,000.

Level: m1,m2,m3 strict .00012. m10..m13 not strict and above the level: level stays .00012 but each gives a level point. Level points: m1,m2,m3,m10,m11,m12,m13 all .00012.
Holds: m1->m2 60, m2->m3 60, m3 (T0+180) -> m10 (T0+600) 420 (under 86,400), m10->m11 60, m11->m12 60, m12->m13 60, m13 (T0+780) -> asOf (T0+840) 60. Total 60+60+420+60+60+60+60 = 780 above $100k ($120k).
Drawdown 0. Rug false.

Rules v4 (this paragraph supersedes any wick figure above). athLiquidityUsd null (no bar of the ATH window reports liquidity); athHourVolumeUsd 1,000 (volume of the clean 1-minute bars of every pool in the hour ending at m1). Wick: only a clean 1-minute bar with at least $1,000 of volume and 5 traders of its own, funded or of unknown liquidity, is a candidate, valued at max(open, close); the ATH takes over when higher. Here the best candidate is not above the ATH (or there is none), so the wick is the ATH: 120,000 at m1.
`,
  input: input(
    [
      pool('pool-a', [
        bar(minute(0), 0.00012),
        bar(minute(1), 0.00012),
        bar(minute(2), 0.00012),
        bar(minute(3), 0.00012),
        bar(minute(10), 0.0004, { volumeUsd: 5_000, traders: 2 }),
        bar(minute(11), 0.0004, { volumeUsd: 5_000, traders: 2 }),
        bar(minute(12), 0.0004, { volumeUsd: 5_000, traders: 2 }),
        bar(minute(13), 0.0004, { volumeUsd: 5_000, traders: 2 }),
      ]),
    ],
    minute(14),
  ),
  expected: {
    athMarketCapUsd: 120_000,
    athAt: 1_699_920_060,
    athPoolAddress: 'pool-a',
    secondsToAth: 60,
    athWickMarketCapUsd: 120_000,
    athWickAt: 1_699_920_060,
    athWickPoolAddress: 'pool-a',
    athLiquidityUsd: null,
    athHourVolumeUsd: 1_000,
    secondsAbove: [780, 0, 0, 0],
    maxDrawdownPct: 0,
    rugPattern: false,
    flags: [],
  },
};
