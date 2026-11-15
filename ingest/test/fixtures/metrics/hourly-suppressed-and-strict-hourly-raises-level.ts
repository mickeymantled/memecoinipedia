import type { MetricFixture } from '../../../src/metrics/types.js';
import { bar, flatRun, hourAt, input, pool } from './build.js';

export const hourlySuppressedAndStrictHourlyRaisesLevel: MetricFixture = {
  name: 'hourly-suppressed-and-strict-hourly-raises-level',
  description:
    'An hourly bar covering minutes we hold 1-minute bars for is not a window (finer data wins), though its wick counts. A later strict hourly bar above the ATH raises the level and the peak_outside_minute_coverage flag, but never sets the ATH.',
  reasoning: `
One primary pool. 1-minute bars m0..m3: close .0002, 500 USD, 6 traders.
Hourly bar H0 at T0: o .0002, h .0006, l .0002, c .0005, 50,000 USD, 30 traders.
Hourly bar H1 at T0+3,600: o = h = l = c = .0003, 5,000 USD, 10 traders.
asOf = T0+7,200, launchedAt = T0.

Windows:
1-minute: m0 not strict; m1, m2, m3 strict .0002.
H0: the pool holds clean 1-minute bars inside this hour (m0..m3), so H0 is NOT used as a window. It still counts for the wick.
H1: no 1-minute bar inside hour 1, so it is a window: price .0003, volume 5,000, traders 10: strict.

ATH: highest strict 1-minute price is .0002, first at m1: 200,000, athAt = T0+60, secondsToAth 60. The hourly H1 never sets the ATH.
Wick: the hourly H0 high .0006 is the highest of any bar: 600,000 at T0 (the bucket start), pool-a.
Coverage: strict hourly point H1 has price .0003, above the ATH price .0002: flag peak_outside_minute_coverage. (H0 is not a window, so it does not count here.)

Level: m0 ignored. m1, m2, m3 strict .0002. H1 is strict, so the level becomes .0003.
Level points: m1, m2, m3 (.0002), H1 at T0+3,600 (.0003).
Holds: m1->m2 60; m2->m3 60; m3 (T0+180) -> H1 (T0+3,600) 3,420; H1 -> asOf (T0+7,200) 3,600.
Above $100k: 60 + 60 + 3,420 + 3,600 = 7,140. None above $1M.
Drawdown 0 (levels .0002 then .0003). Rug false.
Flags: peak_outside_minute_coverage.
`,
  input: input(
    [
      pool('pool-a', flatRun(0, 4, 0.0002), {
        bars1h: [
          bar(hourAt(0), 0.0005, {
            o: 0.0002,
            h: 0.0006,
            l: 0.0002,
            volumeUsd: 50_000,
            traders: 30,
          }),
          bar(hourAt(1), 0.0003, { volumeUsd: 5_000, traders: 10 }),
        ],
      }),
    ],
    hourAt(2),
  ),
  expected: {
    athMarketCapUsd: 200_000,
    athAt: 1_699_920_060,
    athPoolAddress: 'pool-a',
    secondsToAth: 60,
    athWickMarketCapUsd: 600_000,
    athWickAt: 1_699_920_000,
    athWickPoolAddress: 'pool-a',
    secondsAbove: [7_140, 0, 0, 0],
    maxDrawdownPct: 0,
    rugPattern: false,
    flags: ['peak_outside_minute_coverage'],
  },
};
