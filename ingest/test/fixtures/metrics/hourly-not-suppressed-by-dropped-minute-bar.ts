import type { MetricFixture } from '../../../src/metrics/types.js';
import { bar, flatRun, hourAt, input, pool } from './build.js';

export const hourlyNotSuppressedByDroppedMinuteBar: MetricFixture = {
  name: 'hourly-not-suppressed-by-dropped-minute-bar',
  description:
    'Only clean 1-minute bars suppress an hourly bar. 1-minute bars of a low-liquidity secondary pool are dropped, so they do not suppress the hourly bar of the primary pool, which then raises the coverage flag.',
  reasoning: `
pool-a (primary): no 1-minute bars; one hourly bar at T0: o = h = l = c = .0005, 50,000 USD, 30 traders.
pool-b (secondary, liquidity 1,000 on every bar): 1-minute bars m0..m3, close .0002, 500 USD, 6 traders. asOf = T0+3,600, launchedAt = T0.

Clean: pool-b's bars are dropped (1,000 < 5,000), so no 1-minute bar remains anywhere.
Windows: pool-a's hourly bar has no clean 1-minute bar inside its hour, so it is a window: .0005, 50,000 USD, 30 traders: strict.

ATH: no strict 1-minute point: all four null, flag no_qualifying_window.
Coverage: a strict hourly point exists while the ATH is null: peak_outside_minute_coverage.
Wick: .0005 (the hourly bar; pool-b's bars are gone): 500,000 at T0, pool-a.
Level: the hourly point sets .0005: one level point at T0 holding to asOf (T0+3,600): 3,600 s above $100k. None above $1M.
Drawdown 0. Rug false.
Flags sorted: no_qualifying_window, peak_outside_minute_coverage.
`,
  input: input(
    [
      pool('pool-a', [], {
        bars1h: [bar(hourAt(0), 0.0005, { volumeUsd: 50_000, traders: 30 })],
      }),
      pool('pool-b', flatRun(0, 4, 0.0002, { liquidityUsd: 1_000 }), { isPrimary: false }),
    ],
    hourAt(1),
  ),
  expected: {
    athMarketCapUsd: null,
    athAt: null,
    athPoolAddress: null,
    secondsToAth: null,
    athWickMarketCapUsd: 500_000,
    athWickAt: 1_699_920_000,
    athWickPoolAddress: 'pool-a',
    secondsAbove: [3_600, 0, 0, 0],
    maxDrawdownPct: 0,
    rugPattern: false,
    flags: ['no_qualifying_window', 'peak_outside_minute_coverage'],
  },
};
