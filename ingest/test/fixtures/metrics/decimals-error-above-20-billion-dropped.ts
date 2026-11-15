import type { MetricFixture } from '../../../src/metrics/types.js';
import { bar, input, minute, pool } from './build.js';

export const decimalsErrorAbove20BillionDropped: MetricFixture = {
  name: 'decimals-error-above-20-billion-dropped',
  description:
    'A decimals error puts bars above $20 billion. The whole bar is dropped (even when only the high is bad) and implausible_market_cap is flagged; the bad bars do not touch the wick or the windows.',
  reasoning: `
One primary pool. m0..m3 and m6, m7: close .0002 (500 USD, 6 traders). m4: o .0002, h 30, l .0002, c .0002. m5: o = h = l = c = 200. asOf = m8, launchedAt = T0.

Clean:
m4: largest of o,h,l,c is 30, times 1e9 = $30B > $20B: dropped (the whole bar, though only h is bad), flag implausible_market_cap.
m5: 200 * 1e9 = $200B: dropped.
Remaining bars: m0, m1, m2, m3, m6, m7.

Windows:
m0: not strict (one bar). m1, m2, m3: strict .0002.
m6: bars m4, m5 absent, so one bar: not strict, .0002.
m7: bars m6, m7, volume 1000, traders 6: strict .0002.

ATH = 200,000 at m1: athAt = T0+60, secondsToAth 60.
Wick: over clean bars only: .0002 first at m0, T0: 200,000. The $30B and $200B values do not count.
Level: m1, m2, m3 strict .0002. m6 not strict, price .0002 equals the level (unchanged), level point (m6, .0002). m7 strict .0002.
Level points: m1, m2, m3, m6, m7.
Holds: m1->m2 60; m2->m3 60; m3 (T0+180) -> m6 (T0+360) 180; m6->m7 60; m7 (T0+420) -> asOf (T0+480) 60. Total 420 above $100k.
Drawdown 0. Rug false. Flags: implausible_market_cap only.

Rules v4 (this paragraph supersedes any wick figure above). athLiquidityUsd null (no bar of the ATH window reports liquidity); athHourVolumeUsd 1,000 (volume of the clean 1-minute bars of every pool in the hour ending at m1). Wick: only a clean 1-minute bar with at least $1,000 of volume and 5 traders of its own, funded or of unknown liquidity, is a candidate, valued at max(open, close); the ATH takes over when higher. Here the best candidate is not above the ATH (or there is none), so the wick is the ATH: 200,000 at m1.
`,
  input: input(
    [
      pool('pool-a', [
        bar(minute(0), 0.0002),
        bar(minute(1), 0.0002),
        bar(minute(2), 0.0002),
        bar(minute(3), 0.0002),
        bar(minute(4), 0.0002, { h: 30 }),
        bar(minute(5), 200),
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
    flags: ['implausible_market_cap'],
  },
};
