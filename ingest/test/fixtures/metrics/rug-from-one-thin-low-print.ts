import type { MetricFixture } from '../../../src/metrics/types.js';
import { bar, input, minute, minuteRun, pool } from './build.js';

export const rugFromOneThinLowPrint: MetricFixture = {
  name: 'rug-from-one-thin-low-print',
  description:
    'A single non-strict print at 2.5% of the ATH ten minutes later lowers the level and makes the rug pattern true. The rules give this answer; it is a surprising consequence of letting thin low prints lower the level.',
  reasoning: `
One primary pool. m0, m1: close .002 (500 USD, 6 traders). m10: close .00005, 10 USD, 1 trade, 1 trader. asOf = m11 (T0+660), launchedAt = T0.

Windows: m0 not strict; m1 strict .002; m10 one bar, not strict, price .00005.
ATH = 2,000,000 at m1: athAt = T0+60, secondsToAth 60. Wick .002 at m0 (T0): 2,000,000.
Level: m1 .002. m10: not strict, but its price is below the level, so the level becomes .00005 ($50,000).
Level points: m1, m10. Holds: m1 -> m10 540 s; m10 (T0+600) -> asOf (T0+660) 60 s.
Above $100k: only the first level: 540 ($50k is below). Above $1M: 540.
Drawdown: (.002-.00005)/.002 = 97.5%.

Rug: m10 is at T0+600, within 1,800 s of athAt. Its level .00005 <= .0004: crash point. No strict coin point after it. rugPattern = true.

Rules v4 (this paragraph supersedes any wick figure above). athLiquidityUsd null (no bar of the ATH window reports liquidity); athHourVolumeUsd 1,000 (volume of the clean 1-minute bars of every pool in the hour ending at m1). Wick: only a clean 1-minute bar with at least $1,000 of volume and 5 traders of its own, funded or of unknown liquidity, is a candidate, valued at max(open, close); the ATH takes over when higher. Here the best candidate is not above the ATH (or there is none), so the wick is the ATH: 2,000,000 at m1.
`,
  input: input(
    [
      pool('pool-a', [
        ...minuteRun(0, [0.002, 0.002]),
        bar(minute(10), 0.00005, { volumeUsd: 10, trades: 1, traders: 1 }),
      ]),
    ],
    minute(11),
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
    secondsAbove: [540, 540, 0, 0],
    maxDrawdownPct: 97.5,
    rugPattern: true,
    flags: [],
  },
};
