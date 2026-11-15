import type { MetricFixture } from '../../../src/metrics/types.js';
import { input, minute, minuteRun, pool } from './build.js';

export const rugFallExactlyAt30Minutes: MetricFixture = {
  name: 'rug-fall-exactly-at-30-minutes',
  description:
    'The crash level point lands exactly 1,800 seconds after athAt: inclusive, so the rug pattern is true.',
  reasoning: `
One primary pool, 500 USD / 6 traders per bar. m0, m1: close .002. m31, m32: close .0002. asOf = m33 (T0+1,980), launchedAt = T0.

Windows: m0 not strict; m1 strict .002; m31 one bar, not strict, .0002; m32 two bars, strict, .0002.
ATH = 2,000,000 at m1: athAt = T0+60, secondsToAth 60. Wick .002 at m0 (T0): 2,000,000.
Level: m1 .002. m31 not strict, below the level: level .0002 (point at T0+1,860). m32 strict .0002.
Level points: m1, m31, m32. Holds: m1 -> m31 30 * 60 = 1,800; m31 -> m32 60; m32 (T0+1,920) -> asOf (T0+1,980) 60.
Above $100k: 1,800 + 60 + 60 = 1,920. Above $1M: 1,800.
Drawdown 90%.

Rug: m31 is at T0+1,860 = athAt + 1,800, which is "no later than athAt + rugWithinSec": allowed. Its level .0002 <= .0004: crash point. No strict point afterwards at or above .001 (m32 is .0002). rugPattern = true.
`,
  input: input(
    [pool('pool-a', [...minuteRun(0, [0.002, 0.002]), ...minuteRun(31, [0.0002, 0.0002])])],
    minute(33),
  ),
  expected: {
    athMarketCapUsd: 2_000_000,
    athAt: 1_699_920_060,
    athPoolAddress: 'pool-a',
    secondsToAth: 60,
    athWickMarketCapUsd: 2_000_000,
    athWickAt: 1_699_920_000,
    athWickPoolAddress: 'pool-a',
    secondsAbove: [1_920, 1_800, 0, 0],
    maxDrawdownPct: 90,
    rugPattern: true,
    flags: [],
  },
};
