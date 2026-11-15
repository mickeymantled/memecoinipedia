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

Rules v4 (this paragraph supersedes any wick figure above). athLiquidityUsd null (no bar of the ATH window reports liquidity); athHourVolumeUsd 1,000 (volume of the clean 1-minute bars of every pool in the hour ending at m1). Wick: only a clean 1-minute bar with at least $1,000 of volume and 5 traders of its own, funded or of unknown liquidity, is a candidate, valued at max(open, close); the ATH takes over when higher. Here the best candidate is not above the ATH (or there is none), so the wick is the ATH: 2,000,000 at m1.
`,
  input: input([pool('pool-a', [...flatRun(0, 5, 0.002), ...flatRun(5, 5, 0.0002)])], minute(10)),
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
    secondsAbove: [540, 300, 0, 0],
    maxDrawdownPct: 90,
    rugPattern: true,
    flags: [],
  },
};
