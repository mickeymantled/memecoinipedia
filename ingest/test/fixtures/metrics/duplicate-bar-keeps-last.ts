import type { MetricFixture } from '../../../src/metrics/types.js';
import { bar, input, minute, pool } from './build.js';

export const duplicateBarKeepsLast: MetricFixture = {
  name: 'duplicate-bar-keeps-last',
  description:
    'Two bars with the same t in one pool: the one that comes last in the input is kept (not the last by time or the higher price), and duplicate_bar is flagged.',
  reasoning: `
One primary pool. Input order: m0 (.0002), m1 (.0002), m2 (.0005), m3 (.0002), m2 again (.0002). So there are two bars at m2; the second is last in the input. All bars 500 USD, 6 traders. asOf = m4, launchedAt = T0.

Clean: the two m2 bars share t. Keep the one that comes last in the input, the .0002 bar. The .0005 bar is discarded. Flag duplicate_bar.
Clean bars: m0, m1, m2 (.0002), m3.

Windows: m0 one bar, not strict. m1, m2, m3 strict .0002.
ATH = 200,000 at m1: athAt = T0+60, secondsToAth 60.
Wick: .0002 at m0 (T0): 200,000. (The discarded .0005 does not count.)
Level points m1, m2, m3, holding 60, 60 and m3 (T0+180) to asOf (T0+240) 60 = 180 above $100k.
Drawdown 0. Rug false. Flags: duplicate_bar.

Rules v4 (this paragraph supersedes any wick figure above). athLiquidityUsd null (no bar of the ATH window reports liquidity); athHourVolumeUsd 1,000 (volume of the clean 1-minute bars of every pool in the hour ending at m1). Wick: only a clean 1-minute bar with at least $1,000 of volume and 5 traders of its own, funded or of unknown liquidity, is a candidate, valued at max(open, close); the ATH takes over when higher. Here the best candidate is not above the ATH (or there is none), so the wick is the ATH: 200,000 at m1.
`,
  input: input(
    [
      pool('pool-a', [
        bar(minute(0), 0.0002),
        bar(minute(1), 0.0002),
        bar(minute(2), 0.0005),
        bar(minute(3), 0.0002),
        bar(minute(2), 0.0002),
      ]),
    ],
    minute(4),
  ),
  expected: {
    athMarketCapUsd: 200_000,
    athAt: 1_699_920_060,
    athPoolAddress: 'pool-a',
    secondsToAth: 60,
    athWickMarketCapUsd: 200_000,
    athWickAt: 1_699_920_060,
    athWickPoolAddress: 'pool-a',
    athLiquidityUsd: null,
    athHourVolumeUsd: 1_000,
    secondsAbove: [180, 0, 0, 0],
    maxDrawdownPct: 0,
    rugPattern: false,
    flags: ['duplicate_bar'],
  },
};
