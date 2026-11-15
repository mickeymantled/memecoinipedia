import type { MetricFixture } from '../../../src/metrics/types.js';
import { flatRun, input, minute, pool } from './build.js';

export const rugCancelledByStrictRecovery: MetricFixture = {
  name: 'rug-cancelled-by-strict-recovery',
  description:
    'The same 90% crash as the rug case, but a later strict point recovers to 60% of the ATH, which is above the half-ATH line, so the rug pattern is false. Drawdown still shows 90%.',
  reasoning: `
One primary pool, 500 USD / 6 traders per bar. m0..m4: close .002. m5..m9: close .0002. m10..m13: close .0012. asOf = m14, launchedAt = T0.

Windows:
m0 not strict. m1..m4 strict .002. m5: .002,.002,.0002 -> .002 strict.
m6: .002,.0002,.0002 -> .0002. m7, m8, m9: .0002.
m10: closes m8,m9,m10 = .0002,.0002,.0012 -> .0002, strict.
m11: closes m9,m10,m11 = .0002,.0012,.0012 -> .0012, strict.
m12, m13: .0012, strict.

ATH = .002 * 1e9 = 2,000,000 first at m1: athAt = T0+60, secondsToAth 60. Wick .002 at m0 (T0): 2,000,000.
Level points m1..m13: m1..m5 .002 (5 points), m6..m10 .0002 (5 points), m11..m13 .0012 (3 points). 13 points, 60 s each (m13 at T0+780 to asOf T0+840 = 60): 780.
Above $100k: all, 780. Above $1M: .002 (5 * 60 = 300) and .0012 (3 * 60 = 180): 480.
Drawdown: peak .002, lowest .0002: 90%.

Rug:
2. m6 (T0+360, level .0002) is at or below .0004 and within 1,800 s of athAt: the crash point.
3. m11 is a strict coin point after the crash with price .0012, at or above .5 * .002 = .001. That cancels the rug.
rugPattern = false.

Rules v4 (this paragraph supersedes any wick figure above). athLiquidityUsd null (no bar of the ATH window reports liquidity); athHourVolumeUsd 1,000 (volume of the clean 1-minute bars of every pool in the hour ending at m1). Wick: only a clean 1-minute bar with at least $1,000 of volume and 5 traders of its own, funded or of unknown liquidity, is a candidate, valued at max(open, close); the ATH takes over when higher. Here the best candidate is not above the ATH (or there is none), so the wick is the ATH: 2,000,000 at m1.
`,
  input: input(
    [
      pool('pool-a', [
        ...flatRun(0, 5, 0.002),
        ...flatRun(5, 5, 0.0002),
        ...flatRun(10, 4, 0.0012),
      ]),
    ],
    minute(14),
  ),
  expected: {
    athMarketCapUsd: 2_000_000,
    athAt: 1_699_920_060,
    athPoolAddress: 'pool-a',
    secondsToAth: 60,
    athWickMarketCapUsd: 2_000_000,
    athWickAt: 1_699_920_060,
    athWickPoolAddress: 'pool-a',
    athLiquidityUsd: null,
    athHourVolumeUsd: 1_000,
    secondsAbove: [780, 480, 0, 0],
    maxDrawdownPct: 90,
    rugPattern: false,
    flags: [],
  },
};
