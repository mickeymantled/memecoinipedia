import type { MetricFixture } from '../../../src/metrics/types.js';
import { bar, dayAt, hourAt, input, pool } from './build.js';

export const dailySuppressedByHourly: MetricFixture = {
  name: 'daily-suppressed-by-hourly',
  description:
    'A daily bar is not a window when an hourly bar lies inside its day (daily bars no longer feed the wick); a later daily bar with nothing finer is a window and, being strict, sets the level to a lower price.',
  reasoning: `
One primary pool, no 1-minute bars.
Hourly bar HR at T0+18,000 (hour 5 of day 0): o = h = l = c = .0003, 2,000 USD, 8 traders.
Daily bar D0 at T0: o .0003, h .002, l .0001, c .001, 100,000 USD, 50 traders.
Daily bar D1 at T0+86,400: o = h = l = c = .0002, 3,000 USD, 6 traders.
asOf = T0+172,800, launchedAt = T0.

Windows:
HR: no 1-minute bar in hour 5, so a window: price .0003, 2,000 USD, 8 traders: strict.
D0: the pool holds a clean hourly bar (HR) inside day 0, so D0 is NOT a window. It still counts for the wick.
D1: no 1-minute or hourly bar inside day 1: a window, price .0002, 3,000 USD, 6 traders: strict.

ATH: no 1-minute point: all four null, flag no_qualifying_window.
Coverage: strict hourly (HR) and daily (D1) points exist while the ATH is null: peak_outside_minute_coverage.
Wick: the highest bar value is D0's high .002: 2,000,000 at T0 (day bucket start), pool-a.

Level: HR strict .0003 (point at T0+18,000). D1 strict: level .0002 (point at T0+86,400).
Holds: HR -> D1: 86,400 - 18,000 = 68,400 s; D1 -> asOf: 172,800 - 86,400 = 86,400 s (exactly the limit).
Above $100k ($300k, $200k): 68,400 + 86,400 = 154,800. None above $1M. (Had D0 been wrongly used, its .001 close would have put $1M time in.)
Drawdown: (.0003-.0002)/.0003 = 33.3333%.
Rug false (ATH null).
Flags sorted: no_qualifying_window, peak_outside_minute_coverage.

Rules v4 (this paragraph supersedes any wick figure above). No ATH. Wick: only a clean 1-minute bar with at least $1,000 of volume and 5 traders of its own, funded or of unknown liquidity, is a candidate, valued at max(open, close); the ATH takes over when higher. There is no candidate and no ATH, so the wick is null.
`,
  input: input(
    [
      pool('pool-a', [], {
        bars1h: [bar(hourAt(5), 0.0003, { volumeUsd: 2_000, traders: 8 })],
        bars1d: [
          bar(dayAt(0), 0.001, {
            o: 0.0003,
            h: 0.002,
            l: 0.0001,
            volumeUsd: 100_000,
            traders: 50,
          }),
          bar(dayAt(1), 0.0002, { volumeUsd: 3_000, traders: 6 }),
        ],
      }),
    ],
    dayAt(2),
  ),
  expected: {
    athMarketCapUsd: null,
    athAt: null,
    athPoolAddress: null,
    secondsToAth: null,
    athWickMarketCapUsd: null,
    athWickAt: null,
    athWickPoolAddress: null,
    athLiquidityUsd: null,
    athHourVolumeUsd: null,
    secondsAbove: [154_800, 0, 0, 0],
    maxDrawdownPct: 33.333333333333336,
    rugPattern: false,
    flags: ['no_qualifying_window', 'peak_outside_minute_coverage'],
  },
};
