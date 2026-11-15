import type { MetricFixture } from '../../../src/metrics/types.js';
import { input, minute, minuteRun, pool } from './build.js';

export const migrationToSecondPool: MetricFixture = {
  name: 'migration-to-second-pool',
  description:
    'Trading moves from the primary pool to a secondary pool with enough liquidity. Each pool has its own windows, and the ATH is set on the second pool.',
  reasoning: `
pool-a (primary): bars m0..m5, close .0002, 500 USD, 6 traders. Nothing after m5.
pool-b (secondary, liquidity 50,000 on every bar): bars m6..m10, closes .0003, .0004, .0005, .0004, .0003, each 800 USD and 7 traders. asOf = m11, launchedAt = T0.

Clean: pool-b passes the liquidity floor (50,000 >= 5,000). Nothing dropped.

Windows are built per pool from that pool's own bars:
pool-a: m0 not strict (1 bar). m1..m5 strict, .0002.
pool-b: m6: bars m4,m5 absent, so one bar, not strict, .0003.
m7: bars m6,m7, volume 1600, traders 7, strict; lower median of .0003,.0004 = .0003.
m8: .0003,.0004,.0005 -> .0004, strict.
m9: .0004,.0005,.0004 -> sorted .0004,.0004,.0005 -> .0004, strict.
m10: .0005,.0004,.0003 -> .0004, strict.
No timestamp has windows from two pools, so every window is a coin point.

ATH: highest strict 1-minute price .0004, first at m8: athAt = T0+480, pool-b, 400,000, secondsToAth 480.
Wick: highest bar value .0005 (pool-b m8): 500,000 at T0+480, pool-b.

Level: m0 ignored. pool-a m1..m5 strict .0002. m6 (pool-b, not strict) price .0003 above the level: level stays .0002, level point (m6, .0002). m7 strict .0003. m8, m9, m10 strict .0004.
Level points m1..m10: ten points, each holding 60 s (m10 at T0+600 to asOf T0+660 = 60). All levels at least $200k: 600 above $100k. None above $1M.
Drawdown 0. Rug false.

Rules v4 (this paragraph supersedes any wick figure above). athLiquidityUsd 50,000 (the largest liquidity of the ATH window); athHourVolumeUsd 5,400 (volume of the clean 1-minute bars of every pool in the hour ending at m8). Wick: only a clean 1-minute bar with at least $1,000 of volume and 5 traders of its own, funded or of unknown liquidity, is a candidate, valued at max(open, close); the ATH takes over when higher. Here the best candidate is not above the ATH (or there is none), so the wick is the ATH: 400,000 at m8.
`,
  input: input(
    [
      pool('pool-a', minuteRun(0, [0.0002, 0.0002, 0.0002, 0.0002, 0.0002, 0.0002])),
      pool(
        'pool-b',
        minuteRun(6, [0.0003, 0.0004, 0.0005, 0.0004, 0.0003], {
          volumeUsd: 800,
          traders: 7,
          liquidityUsd: 50_000,
        }),
        {
          isPrimary: false,
        },
      ),
    ],
    minute(11),
  ),
  expected: {
    athMarketCapUsd: 400_000,
    athAt: 1_699_920_480,
    athPoolAddress: 'pool-b',
    secondsToAth: 480,
    athWickMarketCapUsd: 400_000,
    athWickAt: 1_699_920_480,
    athWickPoolAddress: 'pool-b',
    athLiquidityUsd: 50_000,
    athHourVolumeUsd: 5_400,
    secondsAbove: [600, 0, 0, 0],
    maxDrawdownPct: 0,
    rugPattern: false,
    flags: [],
  },
};
