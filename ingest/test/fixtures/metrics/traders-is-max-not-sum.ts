import type { MetricFixture } from '../../../src/metrics/types.js';
import { bar, input, minute, pool } from './build.js';

export const tradersIsMaxNotSum: MetricFixture = {
  name: 'traders-is-max-not-sum',
  description:
    'A window takes the highest single-minute traders count, not the sum: the window with one busy minute is strict, the earlier ones are not.',
  reasoning: `
One primary pool, three 1-minute bars: m0 close .0002, 400 USD, traders 5; m1 close .0002, 400 USD, traders 1; m2 close .0002, 400 USD, traders 1. asOf = m3, launchedAt = T0.

Windows:
m0: one bar, not strict.
m1: bars m0,m1: volume 800 < 1000, not strict (traders max 5).
m2: bars m0,m1,m2: volume 1200 >= 1000, traders = max(5,1,1) = 5 >= 5, 3 bars: strict, price .0002.
(A sum would give 7 and an average 2.33; only the max, 5, is defined.)

ATH = .0002 * 1e9 = 200,000 at m2: athAt = T0+120, secondsToAth 120.
Wick: .0002, earliest bar m0 (T0): 200,000.

Level: m0, m1 not strict with the level undefined: no level points. m2 strict: level .0002, one level point at T0+120 holding to asOf T0+180 = 60 s. secondsAbove [60,0,0,0].
Drawdown 0 (one level point). Rug: no level point after athAt, false.

Rules v4 (this paragraph supersedes any wick figure above). athLiquidityUsd null (no bar of the ATH window reports liquidity); athHourVolumeUsd 1,200 (volume of the clean 1-minute bars of every pool in the hour ending at m2). Wick: only a clean 1-minute bar with at least $1,000 of volume and 5 traders of its own, funded or of unknown liquidity, is a candidate, valued at max(open, close); the ATH takes over when higher. Here the best candidate is not above the ATH (or there is none), so the wick is the ATH: 200,000 at m2.
`,
  input: input(
    [
      pool('pool-a', [
        bar(minute(0), 0.0002, { volumeUsd: 400, traders: 5 }),
        bar(minute(1), 0.0002, { volumeUsd: 400, traders: 1 }),
        bar(minute(2), 0.0002, { volumeUsd: 400, traders: 1 }),
      ]),
    ],
    minute(3),
  ),
  expected: {
    athMarketCapUsd: 200_000,
    athAt: 1_699_920_120,
    athPoolAddress: 'pool-a',
    secondsToAth: 120,
    athWickMarketCapUsd: 200_000,
    athWickAt: 1_699_920_120,
    athWickPoolAddress: 'pool-a',
    athLiquidityUsd: null,
    athHourVolumeUsd: 1_200,
    secondsAbove: [60, 0, 0, 0],
    maxDrawdownPct: 0,
    rugPattern: false,
    flags: [],
  },
};
