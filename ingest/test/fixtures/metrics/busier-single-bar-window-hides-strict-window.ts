import type { MetricFixture } from '../../../src/metrics/types.js';
import { bar, input, minute, pool } from './build.js';

export const busierSingleBarWindowHidesStrictWindow: MetricFixture = {
  name: 'busier-single-bar-window-hides-strict-window',
  description:
    'At one timestamp a non-strict window with more volume (one bar in a second pool) beats a strict window of another pool, so the strict window is discarded and no strict point is left. This is what the written rule gives, and it is surprising.',
  reasoning: `
pool-a (primary): bars m0, m1: close .0002, 600 USD, 6 traders.
pool-b (primary): one bar at m1: close .0003, 5,000 USD, 20 traders. asOf = m2, launchedAt = T0.

Windows:
pool-a: m0 one bar, 600 USD, not strict. m1 two bars, 1,200 USD, 6 traders: strict, price .0002.
pool-b: m1 one bar (m0 absent): 5,000 USD, 20 traders, but only one bar so NOT strict, price .0003.

One point per timestamp: at m0 only pool-a has a window (not strict, .0002). At m1 pool-b has the larger volume (5,000 v 1,200), so pool-b's non-strict window is kept and pool-a's strict window is discarded.
Coin points: m0 (pool-a, not strict, .0002), m1 (pool-b, not strict, .0003). No strict point.

ATH: all four null, flag no_qualifying_window.
Wick: .0003 at m1 (T0+60), pool-b: 300,000.
Level: no strict point, never defined: no level points. secondsAbove zeros, drawdown null. Rug false.

Rules v4 (this paragraph supersedes any wick figure above). No ATH. Wick: only a clean 1-minute bar with at least $1,000 of volume and 5 traders of its own, funded or of unknown liquidity, is a candidate, valued at max(open, close); the ATH takes over when higher. The wick is unchanged.
`,
  input: input(
    [
      pool('pool-a', [
        bar(minute(0), 0.0002, { volumeUsd: 600 }),
        bar(minute(1), 0.0002, { volumeUsd: 600 }),
      ]),
      pool('pool-b', [bar(minute(1), 0.0003, { volumeUsd: 5_000, traders: 20 })]),
    ],
    minute(2),
  ),
  expected: {
    athMarketCapUsd: null,
    athAt: null,
    athPoolAddress: null,
    secondsToAth: null,
    athWickMarketCapUsd: 300_000,
    athWickAt: 1_699_920_060,
    athWickPoolAddress: 'pool-b',
    athLiquidityUsd: null,
    athHourVolumeUsd: null,
    secondsAbove: [0, 0, 0, 0],
    maxDrawdownPct: null,
    rugPattern: false,
    flags: ['no_qualifying_window'],
  },
};
