import type { MetricFixture } from '../../../src/metrics/types.js';
import { flatRun, input, minute, pool } from './build.js';

export const noQualifyingWindow: MetricFixture = {
  name: 'no-qualifying-window',
  description:
    'Every window is under the volume minimum, so nothing is strict: ATH fields null with no_qualifying_window, the wick present, no level series (zero time above, null drawdown).',
  reasoning: `
One primary pool, 1-minute bars m0..m3: close .0003, 100 USD, 6 traders. asOf = m4, launchedAt = T0.

Windows: m0 one bar; m1 volume 200; m2 volume 300; m3 volume 300 (bars m1..m3). All under 1,000, and m0 has one bar: nothing is strict.
ATH: no strict 1-minute point: athMarketCapUsd, athAt, athPoolAddress, secondsToAth all null, flag no_qualifying_window.
Wick: .0003 first at m0 (T0): 300,000, pool-a.
Level: no strict point ever, so the level stays undefined: no level points. secondsAbove [0,0,0,0], maxDrawdownPct null.
Rug: ATH is null, so false.
No hourly or daily bars, so no coverage flag.
`,
  input: input([pool('pool-a', flatRun(0, 4, 0.0003, { volumeUsd: 100 }))], minute(4)),
  expected: {
    athMarketCapUsd: null,
    athAt: null,
    athPoolAddress: null,
    secondsToAth: null,
    athWickMarketCapUsd: 300_000,
    athWickAt: 1_699_920_000,
    athWickPoolAddress: 'pool-a',
    secondsAbove: [0, 0, 0, 0],
    maxDrawdownPct: null,
    rugPattern: false,
    flags: ['no_qualifying_window'],
  },
};
