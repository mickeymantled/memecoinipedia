import type { MetricFixture } from '../../../src/metrics/types.js';
import { bar, flatRun, hourAt, input, pool } from './build.js';

const busy = { volumeUsd: 5_000, traders: 20 };

export const drainedHourRaisesCoverageFlag: MetricFixture = {
  name: 'drained-hour-raises-coverage-flag',
  description:
    'An hourly bar reports 100 USD of liquidity because its pool was drained in that hour. The previous hourly bar was funded, so the window is funded, strict, and its high above the ATH raises peak_outside_minute_coverage.',
  reasoning: `
One primary pool. 1-minute bars m0..m3: close .0002, 600 USD, 6 traders, liquidity null. Hourly bars (no 1-minute bar lies inside their hours, so both are windows):
H1 at T0+3,600: o = h = l = c = .0002, 5,000 USD, 20 traders, liquidity 20,000.
H2 at T0+7,200: o .0002, h .0006, l .0002, c .0002, 5,000 USD, 20 traders, liquidity 100 (the drained hour).
asOf = T0+10,800, launchedAt = T0.

1-minute windows: m0 not strict; m1..m3 strict (volume 1,200 or more, traders 6, liquidity unknown so funded), price .0002.
ATH: 200,000 at m1, secondsToAth 60, athLiquidityUsd null, athHourVolumeUsd m0 + m1 = 1,200.
Hourly windows: H1: its own liquidity 20,000, no previous bar: funded; volume and traders pass: strict, price .0002, high .0002. H2: own liquidity 100, but the previous clean hourly bar (H1) reports 20,000: the larger, 20,000, is at least 5,000: funded, strict, price .0002, high .0006.
Coverage: H2 is strict and its high .0006 is above the ATH price .0002: peak_outside_minute_coverage is raised. (H1's high equals the ATH price and does not count.) Had H2 been judged on its own liquidity of 100 it would not be strict and the flag would be lost.
Wick: no 1-minute bar has 1,000 USD: no candidate. The wick is the ATH, 200,000 at m1. The hourly high does not feed it.
Level: m1..m3 .0002, H1 .0002 (strict), H2 .0002 (strict). Holds: m1 -> m2 60; m2 -> m3 60; m3 -> H1 3,420; H1 -> H2 3,600; H2 -> asOf 3,600. Total 10,740 s above $100k. Drawdown 0. Rug false.
`,
  input: input(
    [
      pool('pool-a', flatRun(0, 4, 0.0002, { volumeUsd: 600 }), {
        bars1h: [
          bar(hourAt(1), 0.0002, { ...busy, liquidityUsd: 20_000 }),
          bar(hourAt(2), 0.0002, { ...busy, h: 0.0006, liquidityUsd: 100 }),
        ],
      }),
    ],
    hourAt(3),
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
    secondsAbove: [10_740, 0, 0, 0],
    maxDrawdownPct: 0,
    rugPattern: false,
    flags: ['peak_outside_minute_coverage'],
  },
};
