import type { MetricFixture } from '../../../src/metrics/types.js';
import { bar, hourAt, input, pool } from './build.js';

export const hourlyOnlyNoAthCoverageFlag: MetricFixture = {
  name: 'hourly-only-no-ath-coverage-flag',
  description:
    'Only an hourly bar exists, and it is strict. The ATH stays null (hourly bars never set it) with no_qualifying_window, and because a strict hourly point exists peak_outside_minute_coverage is raised too. The level still uses the hourly bar; the wick is null, because hourly bars no longer feed it.',
  reasoning: `
One primary pool, no 1-minute bars. One hourly bar H0 at T0: o = h = l = c = .0003, 5,000 USD, 10 traders. asOf = T0+3,600, launchedAt = T0.

Windows: H0 has no 1-minute bar in its hour, so it is a window: price .0003, volume 5,000 >= 1,000, traders 10 >= 5: strict. It is an hourly point, so it can never set the ATH.

ATH: there is no strict 1-minute coin point, so athMarketCapUsd, athAt, athPoolAddress and secondsToAth are null and no_qualifying_window is raised.
Coverage: the ATH is null while a strict hourly point exists: peak_outside_minute_coverage is raised.
Flags sorted: no_qualifying_window, peak_outside_minute_coverage.
Wick: .0003 from the hourly bar at T0: 300,000, pool-a.
Level: H0 strict sets .0003: one level point at T0, holding to asOf (T0+3,600) = 3,600 s. Above $100k = 3,600; none above $1M.
Drawdown 0 (one level point). Rug false (ATH null).

Rules v4 (this paragraph supersedes any wick figure above). No ATH. Wick: only a clean 1-minute bar with at least $1,000 of volume and 5 traders of its own, funded or of unknown liquidity, is a candidate, valued at max(open, close); the ATH takes over when higher. There is no candidate and no ATH, so the wick is null.
`,
  input: input(
    [pool('pool-a', [], { bars1h: [bar(hourAt(0), 0.0003, { volumeUsd: 5_000, traders: 10 })] })],
    hourAt(1),
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
    secondsAbove: [3_600, 0, 0, 0],
    maxDrawdownPct: 0,
    rugPattern: false,
    flags: ['no_qualifying_window', 'peak_outside_minute_coverage'],
  },
};
