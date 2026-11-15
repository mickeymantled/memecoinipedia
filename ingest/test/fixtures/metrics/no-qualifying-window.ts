import type { MetricFixture } from '../../../src/metrics/types.js';
import { flatRun, input, minute, pool } from './build.js';

export const noQualifyingWindow: MetricFixture = {
  name: 'no-qualifying-window',
  description:
    'Every window is under the volume minimum, so nothing is strict: ATH fields null with no_qualifying_window, the wick null (no candidate and no ATH), no level series (zero time above, null drawdown).',
  reasoning: `
One primary pool, 1-minute bars m0..m3: close .0003, 100 USD, 6 traders. asOf = m4, launchedAt = T0.

Windows: m0 one bar; m1 volume 200; m2 volume 300; m3 volume 300 (bars m1..m3). All under 1,000, and m0 has one bar: nothing is strict.
ATH: no strict 1-minute point: athMarketCapUsd, athAt, athPoolAddress, secondsToAth all null, flag no_qualifying_window.
Wick: .0003 first at m0 (T0): 300,000, pool-a.
Level: no strict point ever, so the level stays undefined: no level points. secondsAbove [0,0,0,0], maxDrawdownPct null.
Rug: ATH is null, so false.
No hourly or daily bars, so no coverage flag.

Rules v4 (this paragraph supersedes any wick figure above). No ATH. Wick: only a clean 1-minute bar with at least $1,000 of volume and 5 traders of its own, funded or of unknown liquidity, is a candidate, valued at max(open, close); the ATH takes over when higher. There is no candidate and no ATH, so the wick is null.
`,
  input: input([pool('pool-a', flatRun(0, 4, 0.0003, { volumeUsd: 100 }))], minute(4)),
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
    secondsAbove: [0, 0, 0, 0],
    maxDrawdownPct: null,
    rugPattern: false,
    flags: ['no_qualifying_window'],
  },
};
