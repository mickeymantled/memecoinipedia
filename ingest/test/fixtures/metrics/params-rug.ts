import type { MetricFixture } from '../../../src/metrics/types.js';
import { flatRun, input, minute, pool } from './build.js';

export const paramsRug: MetricFixture = {
  name: 'params-rug',
  description:
    'Non-default rug parameters: a 50% drop within 300 seconds counts as a crash (an 80% rule would not), landing exactly on the 300-second limit, and a recovery to 60% of the ATH does not cancel because the recovery fraction is 0.9.',
  reasoning: `
Parameters: rugDropPct 50, rugWithinSec 300, rugRecoveryFraction 0.9. Others default.
One primary pool, 500 USD / 6 traders per bar. m0..m4: close .002. m5..m9: close .0009. m10..m12: close .0012. asOf = m13 (T0+780), launchedAt = T0.

Windows:
m0 not strict. m1..m4 strict .002. m5: .002,.002,.0009 -> .002.
m6: .002,.0009,.0009 -> .0009. m7, m8, m9: .0009.
m10: .0009,.0009,.0012 -> .0009.
m11: .0009,.0012,.0012 -> .0012. m12: .0012.
All are strict from m1 on.

ATH = .002 * 1e9 = 2,000,000 first at m1: athAt = T0+60, secondsToAth 60. Wick .002 at m0 (T0): 2,000,000.
Level points m1..m12 (12 points): m1..m5 .002; m6..m10 .0009; m11, m12 .0012. 60 s each (m12 at T0+720 to asOf T0+780 = 60): 720.
Default thresholds: above $100k: 720. Above $1M: .002 (5 * 60 = 300) and .0012 (2 * 60 = 120): 420. Above $10M: 0, above $100M: 0.
Drawdown: (.002-.0009)/.002 = 55%.

Rug:
Crash level: (1 - 50/100) * .002 = .001. Window: t in (T0+60, T0+60+300 = T0+360]. m6 at T0+360 has level .0009 <= .001: crash point (exactly on the limit, inclusive).
Recovery line: .9 * .002 = .0018. Strict coin points after m6: .0009 and .0012, all below .0018: not cancelled.
rugPattern = true. (With the default 80% drop, the level never goes to .0004, so the default parameters would give false.)

Rules v4 (this paragraph supersedes any wick figure above). athLiquidityUsd null (no bar of the ATH window reports liquidity); athHourVolumeUsd 1,000 (volume of the clean 1-minute bars of every pool in the hour ending at m1). Wick: only a clean 1-minute bar with at least $1,000 of volume and 5 traders of its own, funded or of unknown liquidity, is a candidate, valued at max(open, close); the ATH takes over when higher. Here the best candidate is not above the ATH (or there is none), so the wick is the ATH: 2,000,000 at m1.
`,
  params: { rugDropPct: 50, rugWithinSec: 300, rugRecoveryFraction: 0.9 },
  input: input(
    [
      pool('pool-a', [
        ...flatRun(0, 5, 0.002),
        ...flatRun(5, 5, 0.0009),
        ...flatRun(10, 3, 0.0012),
      ]),
    ],
    minute(13),
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
    secondsAbove: [720, 420, 0, 0],
    maxDrawdownPct: 55,
    rugPattern: true,
    flags: [],
  },
};
