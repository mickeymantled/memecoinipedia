import type { MetricFixture } from '../../../src/metrics/types.js';
import { bar, flatRun, input, minute, pool } from './build.js';

export const badBarsDroppedFlagOrder: MetricFixture = {
  name: 'bad-bars-dropped-flag-order',
  description:
    'Zero, negative and non-finite prices and a negative or NaN volume are dropped with bad_bar. A non-finite high is a bad bar, not an implausible one (the validity check runs first). A zero volume is valid.',
  reasoning: `
One primary pool. m0..m5: close .0002 (500 USD, 6 traders). Then:
m6: o = h = c = .0009, l = 0 -> price not above zero: bad.
m7: o = h = c = .0009, l = -.0001 -> negative price: bad.
m8: o = h = l = .0009, c = NaN -> not finite: bad.
m9: o = l = c = .0009, h = Infinity -> not finite: bad. (Infinity is also above the market cap limit, but step 2 drops it first, so only bad_bar is raised, not implausible_market_cap.)
m10: o = h = l = c = .0009, volumeUsd = -5 -> negative volume: bad.
m11: o = h = l = c = .0003, volumeUsd 0, trades 0, traders 0 -> volume of zero is allowed: VALID, kept.
m12: o = h = l = c = .0009, volumeUsd = NaN -> bad.
asOf = m13, launchedAt = T0.

Clean: m6, m7, m8, m9, m10, m12 dropped; flag bad_bar (once). Clean bars: m0..m5 and m11.

Windows: m0 one bar, not strict. m1..m5 strict .0002.
m11: bars m9, m10 were dropped, so only m11: one bar, not strict, price .0003.

ATH = .0002 * 1e9 = 200,000 at m1: athAt = T0+60, secondsToAth 60.
Wick: the dropped bars' .0009 does not count; the highest clean value is .0003 at m11 (T0+660): 300,000.
Level: m1..m5 strict .0002. m11 not strict and above the level: level stays .0002, level point (m11, .0002).
Level points: m1, m2, m3, m4, m5, m11.
Holds: m1->m2, m2->m3, m3->m4, m4->m5: 4 * 60 = 240; m5 (T0+300) -> m11 (T0+660) 360; m11 -> asOf (T0+780) 120. Total 720 above $100k.
Drawdown 0. Rug false. Flags: bad_bar only.

Rules v4 (this paragraph supersedes any wick figure above). athLiquidityUsd null (no bar of the ATH window reports liquidity); athHourVolumeUsd 1,000 (volume of the clean 1-minute bars of every pool in the hour ending at m1). Wick: only a clean 1-minute bar with at least $1,000 of volume and 5 traders of its own, funded or of unknown liquidity, is a candidate, valued at max(open, close); the ATH takes over when higher. Here the best candidate is not above the ATH (or there is none), so the wick is the ATH: 200,000 at m1.
`,
  input: input(
    [
      pool('pool-a', [
        ...flatRun(0, 6, 0.0002),
        bar(minute(6), 0.0009, { l: 0 }),
        bar(minute(7), 0.0009, { l: -0.0001 }),
        bar(minute(8), 0.0009, { c: Number.NaN }),
        bar(minute(9), 0.0009, { h: Number.POSITIVE_INFINITY }),
        bar(minute(10), 0.0009, { volumeUsd: -5 }),
        bar(minute(11), 0.0003, { volumeUsd: 0, trades: 0, traders: 0 }),
        bar(minute(12), 0.0009, { volumeUsd: Number.NaN }),
      ]),
    ],
    minute(13),
  ),
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
    secondsAbove: [720, 0, 0, 0],
    maxDrawdownPct: 0,
    rugPattern: false,
    flags: ['bad_bar'],
  },
};
