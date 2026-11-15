import type { MetricFixture } from '../../../src/metrics/types.js';
import { bar, flatRun, hourAt, input, pool } from './build.js';

const busy = { volumeUsd: 5_000, traders: 20 };

export const hourAfterDrainDoesNotRaiseCoverageFlag: MetricFixture = {
  name: 'hour-after-drain-does-not-raise-coverage-flag',
  description:
    'Two hourly bars in a row report 100 USD of liquidity. The first still counts (its previous bar was funded); the second does not (neither it nor its previous bar is funded), so its high above the ATH raises no flag.',
  reasoning: `
One primary pool. 1-minute bars m0..m3: close .0002, 600 USD, 6 traders, liquidity null. Hourly bars (no 1-minute bar inside their hours):
H1 at T0+3,600: flat .0002, 5,000 USD, 20 traders, liquidity 20,000.
H2 at T0+7,200: flat .0002, 5,000 USD, 20 traders, liquidity 100 (drained).
H3 at T0+10,800: o .0002, h .0006, l .0002, c .0002, 5,000 USD, 20 traders, liquidity 100.
asOf = T0+14,400, launchedAt = T0.

1-minute side as in the neighbouring fixture: ATH 200,000 at m1, secondsToAth 60, athLiquidityUsd null, athHourVolumeUsd 1,200, wick = ATH (no 1-minute bar has 1,000 USD).
Hourly windows: H1 funded (20,000), strict, price .0002. H2: own 100, previous bar H1 20,000: funded, strict, price .0002, high .0002 (not above the ATH price). H3: own 100, previous bar H2 100: the larger is 100, below 5,000: not funded, not strict. Its high .0006 is above the ATH price, but only a strict point can raise peak_outside_minute_coverage: no flag.
Level: m1..m3 .0002; H1, H2 strict .0002; H3 not strict, price .0002 not below the level: unchanged, still a level point at .0002. Holds: m1 -> m2 60; m2 -> m3 60; m3 -> H1 3,420; H1 -> H2 3,600; H2 -> H3 3,600; H3 -> asOf 3,600. Total 14,340 s above $100k. Drawdown 0. Rug false.
`,
  input: input(
    [
      pool('pool-a', flatRun(0, 4, 0.0002, { volumeUsd: 600 }), {
        bars1h: [
          bar(hourAt(1), 0.0002, { ...busy, liquidityUsd: 20_000 }),
          bar(hourAt(2), 0.0002, { ...busy, liquidityUsd: 100 }),
          bar(hourAt(3), 0.0002, { ...busy, h: 0.0006, liquidityUsd: 100 }),
        ],
      }),
    ],
    hourAt(4),
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
    athHourVolumeUsd: 1_200,
    secondsAbove: [14_340, 0, 0, 0],
    maxDrawdownPct: 0,
    rugPattern: false,
    flags: [],
  },
};
