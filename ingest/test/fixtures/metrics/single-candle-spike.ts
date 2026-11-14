import type { MetricFixture } from '../../../src/metrics/types.js';
import { bar, input, minute, flatRun, pool } from './build.js';

const bars = flatRun(0, 9, 0.0002).map((b, i) =>
  i === 4 ? bar(b.t, 0.002, { o: 0.0002, l: 0.0002, volumeUsd: 5_000, traders: 8 }) : b,
);

export const singleCandleSpike: MetricFixture = {
  name: 'single-candle-spike',
  description:
    'One 1-minute bar ten times above its neighbours on real volume. It cannot move the 3-minute median, so it does not set the ATH, but it does set the wick.',
  reasoning: `
Nine 1-minute bars m0..m8 on one primary pool, all 500 USD / 6 traders and close .0002, except m4: o .0002, h .002, l .0002, c .002, volume 5,000, traders 8. asOf = m9, launchedAt = T0.

Clean: nothing dropped ($2,000,000 is far below $20B).

Windows:
m0: one bar, not strict, price .0002.
m1, m2, m3: all closes .0002, 2 or 3 bars, volume >= 1000, traders 6: strict, price .0002.
m4: bars m2,m3,m4 closes .0002,.0002,.002 -> median .0002. Volume 6,000, traders 8, strict.
m5: bars m3,m4,m5 closes .0002,.002,.0002 -> median .0002, strict.
m6: bars m4,m5,m6 closes .002,.0002,.0002 -> median .0002, strict.
m7, m8: .0002, strict.
So no window prices above .0002: one candle cannot do it.

ATH = .0002 * 1e9 = 200,000, first strict point m1: athAt = T0+60, secondsToAth = 60.
Wick: highest max(o,h,l,c) over all bars is .002 at m4: 2,000,000 at T0+240.

Level: m0 does nothing (undefined, not strict). m1..m8 strict, level .0002 each: 8 level points. Holds: 60 s each, last (m8 at T0+480) to asOf T0+540 = 60 s. Total 480 s above $100k. None above $1M.
Drawdown 0 (level never falls). Rug false (ATH .0002, level never at or below .00004).
`,
  input: input([pool('pool-a', bars)], minute(9)),
  expected: {
    athMarketCapUsd: 200_000,
    athAt: 1_699_920_060,
    athPoolAddress: 'pool-a',
    secondsToAth: 60,
    athWickMarketCapUsd: 2_000_000,
    athWickAt: 1_699_920_240,
    athWickPoolAddress: 'pool-a',
    secondsAbove: [480, 0, 0, 0],
    maxDrawdownPct: 0,
    rugPattern: false,
    flags: [],
  },
};
