import type { MetricFixture } from '../../../src/metrics/types.js';
import { input, minute, minuteRun, pool } from './build.js';

export const rugFalseFallTooSlow: MetricFixture = {
  name: 'rug-false-fall-too-slow',
  description:
    'A 90% fall that first shows up 31 minutes after the ATH (one minute past the 30-minute limit): the rug pattern is false, though the drawdown is 90%.',
  reasoning: `
One primary pool, 500 USD / 6 traders per bar. m0, m1: close .002. m32, m33: close .0002. asOf = m34 (T0+2,040), launchedAt = T0.

Windows:
m0: not strict. m1: strict, .002.
m32: bars m30, m31 absent: one bar, not strict, price .0002.
m33: bars m32, m33 strict, .0002.

ATH = 2,000,000 at m1: athAt = T0+60, secondsToAth 60. Wick .002 at m0 (T0): 2,000,000.
Level: m1 .002. m32 not strict but below the level: level .0002 (point at T0+1,920). m33 strict .0002.
Level points: m1, m32, m33.
Holds: m1 -> m32: 31 * 60 = 1,860 s (under 86,400); m32 -> m33 60; m33 (T0+1,980) -> asOf (T0+2,040) 60.
Above $100k: 1,860 + 60 + 60 = 1,980. Above $1M: 1,860.
Drawdown 90%.

Rug: the crash must be a level point with t in (T0+60, T0+60+1,800 = T0+1,860]. The first level point at or below .0004 is m32 at T0+1,920, which is 60 s too late. rugPattern = false.

Rules v4 (this paragraph supersedes any wick figure above). athLiquidityUsd null (no bar of the ATH window reports liquidity); athHourVolumeUsd 1,000 (volume of the clean 1-minute bars of every pool in the hour ending at m1). Wick: only a clean 1-minute bar with at least $1,000 of volume and 5 traders of its own, funded or of unknown liquidity, is a candidate, valued at max(open, close); the ATH takes over when higher. Here the best candidate is not above the ATH (or there is none), so the wick is the ATH: 2,000,000 at m1.
`,
  input: input(
    [pool('pool-a', [...minuteRun(0, [0.002, 0.002]), ...minuteRun(32, [0.0002, 0.0002])])],
    minute(34),
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
    secondsAbove: [1_980, 1_860, 0, 0],
    maxDrawdownPct: 90,
    rugPattern: false,
    flags: [],
  },
};
