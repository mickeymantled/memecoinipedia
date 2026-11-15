import type { MetricFixture } from '../../../src/metrics/types.js';
import { bar, input, minute, pool } from './build.js';

export const exactWindowVolume1000: MetricFixture = {
  name: 'exact-window-volume-1000',
  description:
    'A two-bar window with exactly 1,000 USD of volume is strict: the volume comparison is inclusive.',
  reasoning: `
One primary pool, two bars: m0 close .0002, 500 USD, 6 traders; m1 close .0002, 500 USD, 6 traders. asOf = m2, launchedAt = T0.

Windows:
m0: one bar, not strict.
m1: two bars, volume 500+500 = 1000 = minWindowVolumeUsd exactly, traders 6 >= 5. Inclusive, so strict. Price: lower median of .0002,.0002 = .0002.

ATH = 200,000 at m1: athAt = T0+60, secondsToAth 60. Wick: .0002 at m0, T0: 200,000.
Level: m1 only (m0 undefined). One level point at T0+60 holding to asOf T0+120: 60 s. secondsAbove [60,0,0,0]. Drawdown 0. Rug false.

Rules v4 (this paragraph supersedes any wick figure above). athLiquidityUsd null (no bar of the ATH window reports liquidity); athHourVolumeUsd 1,000 (volume of the clean 1-minute bars of every pool in the hour ending at m1). Wick: only a clean 1-minute bar with at least $1,000 of volume and 5 traders of its own, funded or of unknown liquidity, is a candidate, valued at max(open, close); the ATH takes over when higher. Here the best candidate is not above the ATH (or there is none), so the wick is the ATH: 200,000 at m1.
`,
  input: input([pool('pool-a', [bar(minute(0), 0.0002), bar(minute(1), 0.0002)])], minute(2)),
  expected: {
    athMarketCapUsd: 200_000,
    athAt: 1_699_920_060,
    athPoolAddress: 'pool-a',
    secondsToAth: 60,
    athWickMarketCapUsd: 200_000,
    athWickAt: 1_699_920_060,
    athWickPoolAddress: 'pool-a',
    athLiquidityUsd: null,
    athHourVolumeUsd: 1_000,
    secondsAbove: [60, 0, 0, 0],
    maxDrawdownPct: 0,
    rugPattern: false,
    flags: [],
  },
};
