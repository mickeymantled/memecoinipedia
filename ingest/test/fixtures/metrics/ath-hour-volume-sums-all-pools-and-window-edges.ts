import type { MetricFixture } from '../../../src/metrics/types.js';
import { bar, input, minute, pool } from './build.js';

const poolA = pool('pool-a', [
  bar(minute(0), 0.0002, { volumeUsd: 700 }),
  bar(minute(1), 0.0002, { volumeUsd: 800 }),
  bar(minute(60), 0.0003, { volumeUsd: 600 }),
  bar(minute(61), 0.0003, { volumeUsd: 600 }),
]);
const poolB = pool('pool-b', [
  bar(minute(1), 0.0002, { volumeUsd: 25 }),
  bar(minute(2), 0.0002, { volumeUsd: 100 }),
  bar(minute(61), 0.0002, { volumeUsd: 50 }),
  bar(minute(62), 0.0002, { volumeUsd: 999 }),
]);

export const athHourVolumeSumsAllPoolsAndWindowEdges: MetricFixture = {
  name: 'ath-hour-volume-sums-all-pools-and-window-edges',
  description:
    'athHourVolumeUsd adds the 1-minute volume of every pool over (athAt - 3,600, athAt]: the bar exactly an hour before is out, the bar at athAt is in, a later bar is out.',
  reasoning: `
Two primary pools, every bar 6 traders, liquidity null. asOf = m63, launchedAt = T0.
pool-a: m0 .0002 700 USD; m1 .0002 800 USD; m60 .0003 600 USD; m61 .0003 600 USD.
pool-b: m1 .0002 25 USD; m2 .0002 100 USD; m61 .0002 50 USD; m62 .0002 999 USD.

Windows (strict needs two bars in the 3 minutes, 1,000 USD, 5 traders):
m0: pool-a one bar, not strict, .0002 (level undefined: nothing).
m1: pool-a (m0, m1) 1,500 USD strict .0002; pool-b one bar 25 USD. The larger volume wins: pool-a, strict. Level .0002.
m2: pool-b (m1, m2) 125 USD, not strict, .0002; no other pool has a bar: not below the level, unchanged.
m60: pool-a one bar (m58, m59 absent), 600 USD, not strict, .0003: does not raise the level.
m61: pool-a (m60, m61) 1,200 USD strict .0003 beats pool-b (one bar, 50 USD). Level .0003.
m62: pool-b (m61, m62) 1,049 USD strict .0002 (the only bar at m62). Level .0002.

ATH: the highest strict 1-minute price is .0003 at m61: 300,000, athAt = T0+3,660, pool-a, secondsToAth 3,660. athLiquidityUsd null.
athHourVolumeUsd: bars with t in (m1, m61]. pool-a: m60 600 + m61 600 = 1,200 (m0 and m1 are at or before m1: out). pool-b: m2 100 + m61 50 = 150 (m1 is exactly an hour before: out; m62 is after athAt: out). Total 1,350.
Wick: no bar has 1,000 USD of its own volume (the largest is 999): no candidate. The wick is the ATH, 300,000 at m61, pool-a.
Level points: m1 .0002, m2 .0002, m60 .0002, m61 .0003, m62 .0002. Holds: 60, 3,480, 60, 60 and m62 -> asOf 60 = 3,720 s, all at or above $100k. secondsAbove [3,720, 0, 0, 0].
Drawdown: peak .0003, lowest level .0002: 100/3 = 33.333...%. Rug false (the level never falls to .00006).
`,
  input: input([poolA, poolB], minute(63)),
  expected: {
    athMarketCapUsd: 300_000,
    athAt: 1_699_923_660,
    athPoolAddress: 'pool-a',
    secondsToAth: 3_660,
    athWickMarketCapUsd: 300_000,
    athWickAt: 1_699_923_660,
    athWickPoolAddress: 'pool-a',
    athLiquidityUsd: null,
    athHourVolumeUsd: 1_350,
    secondsAbove: [3_720, 0, 0, 0],
    maxDrawdownPct: 100 / 3,
    rugPattern: false,
    flags: [],
  },
};
