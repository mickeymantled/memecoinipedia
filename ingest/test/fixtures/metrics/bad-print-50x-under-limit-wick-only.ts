import type { MetricFixture } from '../../../src/metrics/types.js';
import { bar, flatRun, input, minute, pool } from './build.js';

export const badPrint50xUnderLimitWickOnly: MetricFixture = {
  name: 'bad-print-50x-under-limit-wick-only',
  description:
    'The very first bar prints fifty times the real price on real volume, under the $20B limit. It is a clean bar, so it sets the wick, but it is one bar in any window and never the median past the first two windows; no flag is raised.',
  reasoning: `
One primary pool. m0: o = h = l = c = .01 (fifty times .0002), 3,000 USD, 10 traders. m1..m5: close .0002, 500 USD, 6 traders. asOf = m6, launchedAt = T0.

Clean: .01 * 1e9 = $10M, under $20B: the bar is kept, no flag.
Windows:
m0: one bar, not strict, price .01.
m1: bars m0, m1: closes .01, .0002, lower median .0002. Volume 3500, traders max(10,6) = 10: strict, .0002.
m2: bars m0, m1, m2: .01, .0002, .0002 -> .0002, strict.
m3: bars m1, m2, m3 -> .0002. m4, m5 -> .0002. All strict.

ATH = .0002 * 1e9 = 200,000 at m1: athAt = T0+60, secondsToAth 60.
Wick: .01 at m0 (T0): 10,000,000.
Level: m0 not strict and the level is undefined, so it does nothing (the $10M print never becomes the level). m1..m5 strict .0002: five level points. Holds 60 each (m5 at T0+300 to asOf T0+360 = 60): 300 above $100k. None above $1M.
Drawdown 0. Rug false. No flags.
`,
  input: input(
    [
      pool('pool-a', [
        bar(minute(0), 0.01, { volumeUsd: 3_000, traders: 10 }),
        ...flatRun(1, 5, 0.0002),
      ]),
    ],
    minute(6),
  ),
  expected: {
    athMarketCapUsd: 200_000,
    athAt: 1_699_920_060,
    athPoolAddress: 'pool-a',
    secondsToAth: 60,
    athWickMarketCapUsd: 10_000_000,
    athWickAt: 1_699_920_000,
    athWickPoolAddress: 'pool-a',
    secondsAbove: [300, 0, 0, 0],
    maxDrawdownPct: 0,
    rugPattern: false,
    flags: [],
  },
};
