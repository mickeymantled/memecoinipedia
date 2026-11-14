import type { MetricFixture } from '../../../src/metrics/types.js';
import { bar, flatRun, input, minute, pool } from './build.js';

export const rugThinRecoveryDoesNotCancel: MetricFixture = {
  name: 'rug-thin-recovery-does-not-cancel',
  description:
    'After a 90% crash, a single thin print back at 60% of the ATH is not a strict point, so it does not cancel the rug pattern.',
  reasoning: `
One primary pool. m0..m4: close .002; m5..m9: close .0002 (500 USD, 6 traders each). Then one bar at m20: close .0012, 100 USD, 1 trader. asOf = m21 (T0+1,260), launchedAt = T0.

Windows: same as the plain rug case for m0..m9 (m1..m5 strict at .002, m6..m9 strict at .0002).
m20: bars m18, m19 absent: one bar, not strict, price .0012.

ATH = 2,000,000 at m1 (athAt = T0+60, secondsToAth 60). Wick .002 at m0 (T0): 2,000,000 (the m20 print is lower).
Level: m1..m5 .002; m6..m9 .0002. m20 not strict, price .0012 above the level .0002: unchanged, level point (m20, .0002).
Level points: m1..m9 and m20.
Holds: m1..m8, 60 s each; m9 (T0+540) -> m20 (T0+1,200) 660; m20 -> asOf (T0+1,260) 60.
At .002 ($2M): m1..m5: 5 * 60 = 300. At .0002: m6, m7, m8 = 180, m9 = 660, m20 = 60 -> 900.
Above $100k: 300 + 900 = 1,200. Above $1M: 300.
Drawdown 90%.

Rug: crash point m6 (level .0002 <= .0004, at T0+360 within T0+1,860). Strict coin points after m6 at or above .001: m20 has price .0012 but is not strict (one bar), so it does not count. rugPattern = true.
`,
  input: input(
    [
      pool('pool-a', [
        ...flatRun(0, 5, 0.002),
        ...flatRun(5, 5, 0.0002),
        bar(minute(20), 0.0012, { volumeUsd: 100, trades: 1, traders: 1 }),
      ]),
    ],
    minute(21),
  ),
  expected: {
    athMarketCapUsd: 2_000_000,
    athAt: 1_699_920_060,
    athPoolAddress: 'pool-a',
    secondsToAth: 60,
    athWickMarketCapUsd: 2_000_000,
    athWickAt: 1_699_920_000,
    athWickPoolAddress: 'pool-a',
    secondsAbove: [1_200, 300, 0, 0],
    maxDrawdownPct: 90,
    rugPattern: true,
    flags: [],
  },
};
