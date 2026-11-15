import type { MetricFixture } from '../../../src/metrics/types.js';
import { input, minute, minuteRun, pool } from './build.js';

export const healthySinglePool: MetricFixture = {
  name: 'healthy-single-pool',
  description:
    'A plain coin on one primary pool with full 3-minute windows. The ATH is the lower-median close of the best window, and sits below the best single close (the wick is the ATH, as no bar is a candidate above it).',
  reasoning: `
Ten 1-minute bars m0..m9, one primary pool "pool-a", every bar 500 USD volume and 6 traders. Closes (o=h=l=c):
m0 .00011, m1 .00012, m2 .00015, m3 .0002, m4 .00025, m5 .0003, m6 .00028, m7 .00026, m8 .00022, m9 .0002.
asOf = m10. launchedAt = T0.

Clean: nothing dropped, no flags.

Windows (bars at t-120, t-60, t; lower median of the closes present):
m0: 1 bar, not strict, price .00011.
m1: 2 bars, volume 1000, traders 6, strict. Closes .00011/.00012, lower median .00011.
m2: closes .00011,.00012,.00015 -> .00012 strict.
m3: .00012,.00015,.0002 -> .00015.
m4: .00015,.0002,.00025 -> .0002.
m5: .0002,.00025,.0003 -> .00025.
m6: .00025,.0003,.00028 -> sorted .00025,.00028,.0003 -> .00028.
m7: .0003,.00028,.00026 -> sorted .00026,.00028,.0003 -> .00028.
m8: .00028,.00026,.00022 -> .00026.
m9: .00026,.00022,.0002 -> .00022.
Every pool has one window per t so the coin points are these ten windows.

ATH: highest strict 1-minute price is .00028, first at m6. athAt = T0+360, ATH = .00028 * 1e9 = 280,000, secondsToAth = 360.
Wick: highest max(o,h,l,c) is .0003 at m5. athWickAt = T0+300, 300,000. ATH 280,000 is below the wick 300,000.

Level: m0 is not strict and the level is undefined, so nothing. m1..m9 are strict, so the level follows the price: .00011,.00012,.00015,.0002,.00025,.00028,.00028,.00026,.00022. Nine level points.
Holds: each is 60 s to the next point; the last (m9, T0+540) holds to asOf (T0+600) = 60 s. 9 * 60 = 540 s. Every level is at least $110,000 so above $100k = 540; none reaches $1M.
Drawdown: peak .00028; lowest later level .00022 -> (.00028-.00022)/.00028 = 21.4286%.
Rug: no level point at or below .2 * .00028 within 30 min of m6. False.

Rules v4 (this paragraph supersedes any wick figure above). athLiquidityUsd null (no bar of the ATH window reports liquidity); athHourVolumeUsd 3,500 (volume of the clean 1-minute bars of every pool in the hour ending at m6). Wick: only a clean 1-minute bar with at least $1,000 of volume and 5 traders of its own, funded or of unknown liquidity, is a candidate, valued at max(open, close); the ATH takes over when higher. Here the best candidate is not above the ATH (or there is none), so the wick is the ATH: 280,000 at m6.
`,
  input: input(
    [
      pool(
        'pool-a',
        minuteRun(
          0,
          [0.00011, 0.00012, 0.00015, 0.0002, 0.00025, 0.0003, 0.00028, 0.00026, 0.00022, 0.0002],
        ),
      ),
    ],
    minute(10),
  ),
  expected: {
    athMarketCapUsd: 280_000,
    athAt: 1_699_920_360,
    athPoolAddress: 'pool-a',
    secondsToAth: 360,
    athWickMarketCapUsd: 280_000,
    athWickAt: 1_699_920_360,
    athWickPoolAddress: 'pool-a',
    athLiquidityUsd: null,
    athHourVolumeUsd: 3_500,
    secondsAbove: [540, 0, 0, 0],
    maxDrawdownPct: 21.428571428571427,
    rugPattern: false,
    flags: [],
  },
};
