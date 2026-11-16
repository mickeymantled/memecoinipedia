import type { MetricFixture } from '../../../src/metrics/types.js';
import { flatRun, input, minute, pool } from './build.js';

export const rugPatternTrue: MetricFixture = {
  name: 'rug-pattern-true',
  description:
    'A 90% fall within a few minutes of the ATH with no recovery: the rug pattern is true.',
  reasoning: `
One primary pool, 500 USD / 6 traders per bar. m0..m4: close .002. m5..m9: close .0002. asOf = m10, launchedAt = T0.

Windows:
m0 not strict.
m1..m4: strict .002.
m5: closes m3,m4,m5 = .002,.002,.0002 -> .002, strict.
m6: closes m4,m5,m6 = .002,.0002,.0002 -> .0002, strict.
m7, m8, m9: .0002, strict.

ATH = .002 * 1e9 = 2,000,000, first at m1: athAt = T0+60, secondsToAth 60.
Wick: .002 at m0 (T0): 2,000,000.
Level points: m1..m5 (.002) and m6..m9 (.0002): nine points, 60 s each (m9 at T0+540 to asOf T0+600 = 60): total 540.
Above $100k: all nine (.0002 is $200k): 540. Above $1M: the five .002 points: 300. Above $10M: 0.
Drawdown: (.002-.0002)/.002 = 90%.

Rug:
1. ATH is not null.
2. Window after athAt: t in (T0+60, T0+1,860]. Crash level is at or below (1 - .8) * .002 = .0004. Level points: m6 (T0+360) has level .0002, so m6 is the earliest crash point.
3. Strict coin points after m6 with price at or above .5 * .002 = .001: m7..m9 are .0002. None.
rugPattern = true.
`,
  input: input([pool('pool-a', [...flatRun(0, 5, 0.002), ...flatRun(5, 5, 0.0002)])], minute(10)),
  expected: {
    athMarketCapUsd: 2_000_000,
    athAt: 1_699_920_060,
    athPoolAddress: 'pool-a',
    secondsToAth: 60,
    athWickMarketCapUsd: 2_000_000,
    athWickAt: 1_699_920_000,
    athWickPoolAddress: 'pool-a',
    secondsAbove: [540, 300, 0, 0],
    maxDrawdownPct: 90,
    rugPattern: true,
    flags: [],
  },
};
