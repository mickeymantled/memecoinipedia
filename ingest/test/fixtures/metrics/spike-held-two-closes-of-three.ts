import type { MetricFixture } from '../../../src/metrics/types.js';
import { input, minute, minuteRun, pool } from './build.js';

export const spikeHeldTwoClosesOfThree: MetricFixture = {
  name: 'spike-held-two-closes-of-three',
  description:
    'A jump that holds for two consecutive closes does count: two of three closes in a window make the median. The wick is the earlier of the two bars. Also ends as a rug pattern (90% fall straight after).',
  reasoning: `
Eight 1-minute bars m0..m7, one primary pool, 500 USD / 6 traders each. Closes: m0 .0002, m1 .0002, m2 .0002, m3 .002, m4 .002, m5 .0002, m6 .0002, m7 .0002. asOf = m8, launchedAt = T0.

Windows (lower median of closes present):
m0: one bar, not strict.
m1: .0002,.0002 -> .0002 strict. m2: .0002.
m3: bars m1,m2,m3 = .0002,.0002,.002 -> .0002.
m4: bars m2,m3,m4 = .0002,.002,.002 -> middle .002. Volume 1500, traders 6, strict.
m5: bars m3,m4,m5 = .002,.002,.0002 -> .002 strict.
m6: bars m4,m5,m6 = .002,.0002,.0002 -> .0002.
m7: .0002.

ATH = highest strict price .002, earliest at m4: athAt = T0+240, 2,000,000, secondsToAth 240.
Wick: .002 is reached first by the m3 bar: athWickAt = T0+180, 2,000,000.

Level points (m0 is ignored, level undefined): m1 .0002, m2 .0002, m3 .0002, m4 .002, m5 .002, m6 .0002, m7 .0002. Seven points, 60 s each (m7 at T0+420 to asOf T0+480 = 60).
Above $100k: 7 * 60 = 420. Above $1M (level .002 = $2M): m4 and m5 = 120. Above $10M: 0.
Drawdown: peak .002, later level .0002 -> 90%.
Rug: athAt = T0+240. Level points after it within 1800 s: m6 level .0002 <= .2 * .002 = .0004, so m6 is the crash point. Strict points after m6: m7 price .0002, below .5 * .002 = .001. So rugPattern = true.
`,
  input: input(
    [pool('pool-a', minuteRun(0, [0.0002, 0.0002, 0.0002, 0.002, 0.002, 0.0002, 0.0002, 0.0002]))],
    minute(8),
  ),
  expected: {
    athMarketCapUsd: 2_000_000,
    athAt: 1_699_920_240,
    athPoolAddress: 'pool-a',
    secondsToAth: 240,
    athWickMarketCapUsd: 2_000_000,
    athWickAt: 1_699_920_180,
    athWickPoolAddress: 'pool-a',
    secondsAbove: [420, 120, 0, 0],
    maxDrawdownPct: 90,
    rugPattern: true,
    flags: [],
  },
};
