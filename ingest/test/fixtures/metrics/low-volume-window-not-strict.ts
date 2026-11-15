import type { MetricFixture } from '../../../src/metrics/types.js';
import { bar, input, minute, pool } from './build.js';

export const lowVolumeWindowNotStrict: MetricFixture = {
  name: 'low-volume-window-not-strict',
  description:
    'Two higher closes on tiny volume make a window whose median is high but whose volume is under 1,000. It is not strict, so it cannot set the ATH or raise the level, and its thin minutes are not wick candidates either.',
  reasoning: `
One primary pool, 1-minute bars m0..m7. m0..m3 and m6,m7: close .0002, 500 USD, 6 traders. m4 and m5: close .0005, 100 USD, 6 traders. asOf = m8, launchedAt = T0.

Windows:
m0: one bar, not strict, .0002.
m1: .0002,.0002, volume 1000 (exactly the minimum), strict, .0002.
m2: strict .0002. m3: strict .0002.
m4: bars m2,m3,m4 closes .0002,.0002,.0005 -> .0002. Volume 500+500+100 = 1100, strict.
m5: bars m3,m4,m5 closes .0002,.0005,.0005 -> median .0005. Volume 500+100+100 = 700 < 1000: NOT strict.
m6: bars m4,m5,m6 closes .0005,.0005,.0002 -> .0005. Volume 100+100+500 = 700: NOT strict.
m7: bars m5,m6,m7 closes .0005,.0002,.0002 -> .0002. Volume 1100, strict.

ATH: strict prices are all .0002. ATH = 200,000, earliest strict m1: athAt = T0+60, secondsToAth 60.
Wick: .0005 first at m4 (T0+240): 500,000.

Level: m0 undefined/ignored. m1..m4 strict set .0002. m5 and m6 are not strict with price .0005, above the level, so the level stays .0002 but each still produces a level point. m7 strict .0002. Level points m1..m7, all .0002, 60 s each (m7 at T0+420 to asOf T0+480). 7 * 60 = 420 above $100k.
Drawdown 0. Rug false.

Rules v4 (this paragraph supersedes any wick figure above). athLiquidityUsd null (no bar of the ATH window reports liquidity); athHourVolumeUsd 1,000 (volume of the clean 1-minute bars of every pool in the hour ending at m1). Wick: only a clean 1-minute bar with at least $1,000 of volume and 5 traders of its own, funded or of unknown liquidity, is a candidate, valued at max(open, close); the ATH takes over when higher. Here the best candidate is not above the ATH (or there is none), so the wick is the ATH: 200,000 at m1.
`,
  input: input(
    [
      pool('pool-a', [
        bar(minute(0), 0.0002),
        bar(minute(1), 0.0002),
        bar(minute(2), 0.0002),
        bar(minute(3), 0.0002),
        bar(minute(4), 0.0005, { volumeUsd: 100 }),
        bar(minute(5), 0.0005, { volumeUsd: 100 }),
        bar(minute(6), 0.0002),
        bar(minute(7), 0.0002),
      ]),
    ],
    minute(8),
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
    athHourVolumeUsd: 1_000,
    secondsAbove: [420, 0, 0, 0],
    maxDrawdownPct: 0,
    rugPattern: false,
    flags: [],
  },
};
