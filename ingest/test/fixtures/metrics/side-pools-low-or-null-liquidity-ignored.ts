import type { MetricFixture } from '../../../src/metrics/types.js';
import { bar, dayAt, flatRun, hourAt, input, minute, pool } from './build.js';

export const sidePoolsLowOrNullLiquidityIgnored: MetricFixture = {
  name: 'side-pools-low-or-null-liquidity-ignored',
  description:
    'Two side pools, one with liquidity 1,000 and one with null, print prices ten times too high with lots of volume. They are dropped entirely: no ATH, no wick, no flag. Their hourly and daily bars are dropped too.',
  reasoning: `
pool-a (primary): bars m0..m5, close .0002, 500 USD, 6 traders.
pool-s1 (secondary): 1-minute bars m0..m5 close .002, 5,000 USD, 20 traders, liquidity 1,000 (below 5,000); and a daily bar at T0: close .002, 100,000 USD, 50 traders, liquidity 1,000.
pool-s2 (secondary): 1-minute bars m0..m5 close .002, 5,000 USD, 20 traders, liquidity null; and an hourly bar at T0: close .002, 100,000 USD, 50 traders, liquidity null.
asOf = m6, launchedAt = T0.

Clean: every bar of pool-s1 and pool-s2 is dropped at every resolution (liquidity null or below 5,000, no flag). Only pool-a remains.

Windows: m0 not strict; m1..m5 strict, .0002 (volume 1000 or more, 6 traders).
ATH = .0002 * 1e9 = 200,000 at m1: athAt = T0+60, pool-a, secondsToAth 60.
Wick: over the clean bars only, .0002 first at m0 (T0), pool-a: 200,000. The dropped pools' $2M prints do not count.
Level points m1..m5 (m0 ignored), all .0002. Holds 60 s each, m5 (T0+300) to asOf (T0+360) 60: 5 * 60 = 300 above $100k.
Drawdown 0. Rug false. No flags.
`,
  input: input(
    [
      pool('pool-a', flatRun(0, 6, 0.0002)),
      pool(
        'pool-s1',
        flatRun(0, 6, 0.002, { volumeUsd: 5_000, traders: 20, liquidityUsd: 1_000 }),
        {
          isPrimary: false,
          bars1d: [bar(dayAt(0), 0.002, { volumeUsd: 100_000, traders: 50, liquidityUsd: 1_000 })],
        },
      ),
      pool('pool-s2', flatRun(0, 6, 0.002, { volumeUsd: 5_000, traders: 20, liquidityUsd: null }), {
        isPrimary: false,
        bars1h: [bar(hourAt(0), 0.002, { volumeUsd: 100_000, traders: 50, liquidityUsd: null })],
      }),
    ],
    minute(6),
  ),
  expected: {
    athMarketCapUsd: 200_000,
    athAt: 1_699_920_060,
    athPoolAddress: 'pool-a',
    secondsToAth: 60,
    athWickMarketCapUsd: 200_000,
    athWickAt: 1_699_920_000,
    athWickPoolAddress: 'pool-a',
    secondsAbove: [300, 0, 0, 0],
    maxDrawdownPct: 0,
    rugPattern: false,
    flags: [],
  },
};
