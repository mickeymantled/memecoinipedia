import type { MetricFixture } from '../../../src/metrics/types.js';
import { bar, flatRun, input, minute, pool } from './build.js';

const withWick = (address: string) =>
  pool(
    address,
    flatRun(0, 5, 0.0002, { volumeUsd: 600 }).map((b, i) =>
      i === 2 ? bar(b.t, 0.0002, { h: 0.0004, volumeUsd: 600 }) : b,
    ),
  );

export const wickTieSmallestAddress: MetricFixture = {
  name: 'wick-tie-smallest-address',
  description:
    'Two pools reach the same wick value in the same bar time: the wick pool is the smallest address (the pool listed second). The ATH, on a window volume tie between two primary pools, also goes to the smallest address.',
  reasoning: `
Two primary pools, pool-b listed first. Each has bars m0..m4: close .0002, 600 USD, 6 traders, except the m2 bar, which has h = .0004 (o = l = c = .0002). asOf = m5, launchedAt = T0.

Windows: identical in both pools: m0 not strict, m1..m4 strict, price .0002 (the m2 high is not a close). Window volumes tie, both primary, so pool-a wins by smallest address.
ATH = .0002 * 1e9 = 200,000 at m1: athAt = T0+60, pool-a, secondsToAth 60.

Wick: highest max(o,h,l,c) is .0004, reached by the m2 bar of both pools at the same t = T0+120. Tie in t: the smallest pool address, pool-a. 400,000 at T0+120, pool-a.
Level points m1..m4 .0002: 60+60+60+60 = 240 above $100k. Drawdown 0. Rug false.
`,
  input: input([withWick('pool-b'), withWick('pool-a')], minute(5)),
  expected: {
    athMarketCapUsd: 200_000,
    athAt: 1_699_920_060,
    athPoolAddress: 'pool-a',
    secondsToAth: 60,
    athWickMarketCapUsd: 400_000,
    athWickAt: 1_699_920_120,
    athWickPoolAddress: 'pool-a',
    secondsAbove: [240, 0, 0, 0],
    maxDrawdownPct: 0,
    rugPattern: false,
    flags: [],
  },
};
