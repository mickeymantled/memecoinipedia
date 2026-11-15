import type { MetricFixture } from '../../../src/metrics/types.js';
import { input, minute, minuteRun, pool } from './build.js';

export const paramsWindow5AndThresholds: MetricFixture = {
  name: 'params-window-5-and-thresholds',
  description:
    'Non-default parameters: a 5-minute window (even counts use the lower median), minimum volume 2,000 and minimum traders 3, a 600-second carry-forward limit and two custom thresholds, so secondsAbove has two entries.',
  reasoning: `
Parameters: windowMinutes 5, minWindowVolumeUsd 2,000, minWindowTraders 3, carryForwardMaxSec 600, thresholdsUsd [150,000, 300,000]. Others default.
One primary pool, bars m0..m6, 500 USD and 3 traders each. Closes: m0 .0002, m1 .0002, m2 .0002, m3 .0004, m4 .0004, m5 .0004, m6 .0004. asOf = m25 (T0+1,500), launchedAt = T0.

Window for a bar at t: that pool's bars in the 5 minutes ending at t (t-240 .. t).
m0: 1 bar. Not strict (needs two bars).
m1: 2 bars, volume 1,000 < 2,000. Not strict.
m2: 3 bars, volume 1,500 < 2,000. Not strict.
m3: 4 bars (m0..m3), volume 2,000 (exactly the minimum), traders 3 (exactly the minimum): strict. Closes .0002,.0002,.0002,.0004: with four values the lower median is the 2nd smallest = .0002.
m4: 5 bars, volume 2,500, strict. Closes .0002 x3, .0004 x2: median (3rd) .0002.
m5: bars m1..m5: .0002,.0002,.0004,.0004,.0004 -> median .0004, strict.
m6: bars m2..m6: .0002,.0004,.0004,.0004,.0004 -> .0004, strict.

ATH = .0004 * 1e9 = 400,000 first at m5: athAt = T0+300, secondsToAth 300.
Wick: .0004 first at m3 (T0+180): 400,000.
Level: m0..m2 are not strict with the level undefined: nothing. m3 .0002, m4 .0002, m5 .0004, m6 .0004.
Level points m3, m4, m5, m6. Holds: m3->m4 60; m4->m5 60; m5->m6 60; m6 (T0+360) -> asOf (T0+1,500): 1,140 s, capped at 600.
At .0002 ($200k): 60 + 60 = 120. At .0004 ($400k): 60 + 600 = 660.
Thresholds: at or above $150k: 120 + 660 = 780. At or above $300k: 660. secondsAbove [780, 660].
Drawdown 0. Rug false.
`,
  params: {
    windowMinutes: 5,
    minWindowVolumeUsd: 2_000,
    minWindowTraders: 3,
    carryForwardMaxSec: 600,
    thresholdsUsd: [150_000, 300_000],
  },
  input: input(
    [
      pool(
        'pool-a',
        minuteRun(0, [0.0002, 0.0002, 0.0002, 0.0004, 0.0004, 0.0004, 0.0004], { traders: 3 }),
      ),
    ],
    minute(25),
  ),
  expected: {
    athMarketCapUsd: 400_000,
    athAt: 1_699_920_300,
    athPoolAddress: 'pool-a',
    secondsToAth: 300,
    athWickMarketCapUsd: 400_000,
    athWickAt: 1_699_920_180,
    athWickPoolAddress: 'pool-a',
    secondsAbove: [780, 660],
    maxDrawdownPct: 0,
    rugPattern: false,
    flags: [],
  },
};
