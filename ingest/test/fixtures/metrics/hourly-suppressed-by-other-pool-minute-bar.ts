import type { MetricFixture } from '../../../src/metrics/types.js';
import { bar, flatRun, hourAt, input, minute, pool } from './build.js';

export const hourlySuppressedByOtherPoolMinuteBar: MetricFixture = {
  name: 'hourly-suppressed-by-other-pool-minute-bar',
  description:
    'An hourly bar in one pool is not a window when any other pool has a clean 1-minute bar inside that hour. Its high no longer feeds the wick (hourly bars never do), and no coverage flag is raised.',
  reasoning: `
pool-a (primary): no 1-minute bars; one hourly bar at T0: o = h = l = c = .0005, 50,000 USD, 30 traders.
pool-b (secondary, liquidity 10,000): 1-minute bars m0..m3, close .0002, 500 USD, 6 traders. asOf = m4, launchedAt = T0.

Clean: nothing dropped (pool-b passes the liquidity floor).
Windows:
pool-b: m0 not strict; m1, m2, m3 strict .0002.
pool-a's hourly bar: pool-b holds clean 1-minute bars inside hour 0. "Any pool" counts, so the hourly bar is NOT a window.

ATH = .0002 * 1e9 = 200,000 at m1: athAt = T0+60, pool-b, secondsToAth 60.
Wick: the hourly bar .0005 (a clean bar, wick counts at every resolution): 500,000 at T0, pool-a.
Coverage: no strict hourly or daily point exists, so no flag.
Level points m1, m2, m3 (.0002): 60, 60, and m3 (T0+180) to asOf (T0+240) 60 = 180 above $100k.
Drawdown 0. Rug false. No flags.

Rules v4 (this paragraph supersedes any wick figure above). athLiquidityUsd 10,000 (the largest liquidity of the ATH window); athHourVolumeUsd 1,000 (volume of the clean 1-minute bars of every pool in the hour ending at m1). Wick: only a clean 1-minute bar with at least $1,000 of volume and 5 traders of its own, funded or of unknown liquidity, is a candidate, valued at max(open, close); the ATH takes over when higher. Here the best candidate is not above the ATH (or there is none), so the wick is the ATH: 200,000 at m1.
`,
  input: input(
    [
      pool('pool-a', [], {
        bars1h: [bar(hourAt(0), 0.0005, { volumeUsd: 50_000, traders: 30 })],
      }),
      pool('pool-b', flatRun(0, 4, 0.0002, { liquidityUsd: 10_000 }), { isPrimary: false }),
    ],
    minute(4),
  ),
  expected: {
    athMarketCapUsd: 200_000,
    athAt: 1_699_920_060,
    athPoolAddress: 'pool-b',
    secondsToAth: 60,
    athWickMarketCapUsd: 200_000,
    athWickAt: 1_699_920_060,
    athWickPoolAddress: 'pool-b',
    athLiquidityUsd: 10_000,
    athHourVolumeUsd: 1_000,
    secondsAbove: [180, 0, 0, 0],
    maxDrawdownPct: 0,
    rugPattern: false,
    flags: [],
  },
};
