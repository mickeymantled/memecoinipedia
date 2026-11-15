import type { MetricFixture } from '../../../src/metrics/types.js';
import { bar, dayAt, flatRun, input, pool } from './build.js';

export const deadTailMinuteThenDaily: MetricFixture = {
  name: 'dead-tail-minute-then-daily',
  description:
    'One hour of 1-minute bars (half at $500k, half at $200k), then three days of thin daily bars at $80k. Tests carry-forward across a 23-hour gap, daily bars lowering the level, time above, and a slow bleed that is not a rug.',
  reasoning: `
One primary pool. 1-minute bars m0..m59 (500 USD, 6 traders): m0..m29 close .0005, m30..m59 close .0002. Daily bars at days 1, 2, 3 after T0 (T0 is a day start): close .00008, 50 USD, 2 traders (thin). No day-0 daily bar. asOf = start of day 4 = T0 + 345,600. launchedAt = T0.

Windows:
m0: one bar, not strict.
m1..m29: all closes .0005 in range: strict, .0005.
m30: closes m28,m29,m30 = .0005,.0005,.0002 -> .0005, strict.
m31: closes m29,m30,m31 = .0005,.0002,.0002 -> .0002, strict. m32..m59: .0002, strict.
Daily bars: days 1..3 contain no 1-minute and no hourly bar, so each is a window. Volume 50, traders 2: not strict. Prices .00008.

ATH = .0005 * 1e9 = 500,000, first at m1: athAt = T0+60, secondsToAth 60.
Wick: .0005 at m0 (T0): 500,000.
No strict hourly or daily point: no coverage flag.

Level: m1..m30 .0005 (30 points). m31..m59 .0002 (29 points). Day 1: not strict, .00008 below the level (.0002): level .00008. Day 2: price .00008 not below the level: unchanged, but a level point. Day 3: same.
Holds:
m1..m30: 30 points * 60 s = 1,800 s at $500k (m30 holds to m31, T0+1800 to T0+1860).
m31..m58: 28 * 60 = 1,680 s at $200k.
m59 (T0+3,540) -> day 1 (T0+86,400): 82,860 s (under 86,400) at $200k.
Day 1 -> day 2: 86,400 (exactly the limit), day 2 -> day 3: 86,400, day 3 -> asOf: 345,600 - 259,200 = 86,400, all at $80k (below $100k).
Above $100k: 1,800 + 1,680 + 82,860 = 86,340. Above $1M: 0.
Drawdown: peak .0005, lowest level .00008 -> (.0005-.00008)/.0005 = 84%.
Rug: level points within 1,800 s after athAt (up to T0+1,860): the lowest is m31 at .0002, above .2 * .0005 = .0001. The level only falls to .00008 a day later. False.

Rules v4 (this paragraph supersedes any wick figure above). athLiquidityUsd null (no bar of the ATH window reports liquidity); athHourVolumeUsd 1,000 (volume of the clean 1-minute bars of every pool in the hour ending at m1). Wick: only a clean 1-minute bar with at least $1,000 of volume and 5 traders of its own, funded or of unknown liquidity, is a candidate, valued at max(open, close); the ATH takes over when higher. Here the best candidate is not above the ATH (or there is none), so the wick is the ATH: 500,000 at m1.
`,
  input: input(
    [
      pool('pool-a', [...flatRun(0, 30, 0.0005), ...flatRun(30, 30, 0.0002)], {
        bars1d: [1, 2, 3].map((d) =>
          bar(dayAt(d), 0.00008, { volumeUsd: 50, trades: 3, traders: 2 }),
        ),
      }),
    ],
    dayAt(4),
  ),
  expected: {
    athMarketCapUsd: 500_000,
    athAt: 1_699_920_060,
    athPoolAddress: 'pool-a',
    secondsToAth: 60,
    athWickMarketCapUsd: 500_000,
    athWickAt: 1_699_920_060,
    athWickPoolAddress: 'pool-a',
    athLiquidityUsd: null,
    athHourVolumeUsd: 1_000,
    secondsAbove: [86_340, 0, 0, 0],
    maxDrawdownPct: 84,
    rugPattern: false,
    flags: [],
  },
};
