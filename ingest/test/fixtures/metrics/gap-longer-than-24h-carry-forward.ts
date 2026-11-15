import type { MetricFixture } from '../../../src/metrics/types.js';
import { bar, input, minute, pool } from './build.js';

export const gapLongerThan24hCarryForward: MetricFixture = {
  name: 'gap-longer-than-24h-carry-forward',
  description:
    'A two-day silence: a price is only assumed to hold for 86,400 seconds, both across the gap and after the last point before asOf (which ends 100,020 s after it).',
  reasoning: `
One primary pool. m0, m1: close .0002 (500 USD, 6 traders). Then G0 = T0+172,800 (minute 2880) and G1 = T0+172,860 (minute 2881): close .0003, same volume. asOf = T0+272,880 (minute 4548), launchedAt = T0.

Windows:
m0: one bar, not strict. m1: two bars, strict, .0002.
G0: only G0 in its 3 minutes: one bar, not strict, price .0003.
G1: bars G0,G1, volume 1000, traders 6, strict, .0003.

ATH = .0003 * 1e9 = 300,000 at G1: athAt = T0+172,860, secondsToAth 172,860.
Wick: .0003 first at G0: T0+172,800, 300,000.

Level: m1 sets .0002. G0 not strict above the level: level stays .0002, level point (G0, .0002). G1 strict: .0003.
Level points: m1 (T0+60, .0002), G0 (T0+172,800, .0002), G1 (T0+172,860, .0003).
Holds:
m1 -> G0: 172,740 s, capped at 86,400.
G0 -> G1: 60 s.
G1 -> asOf: 272,880 - 172,860 = 100,020 s, capped at 86,400.
Total above $100k (levels $200k, $200k, $300k): 86,400 + 60 + 86,400 = 172,860. None above $1M.
Drawdown 0 (levels .0002, .0002, .0003). Rug false.

Rules v4 (this paragraph supersedes any wick figure above). athLiquidityUsd null (no bar of the ATH window reports liquidity); athHourVolumeUsd 1,000 (volume of the clean 1-minute bars of every pool in the hour ending at m2881). Wick: only a clean 1-minute bar with at least $1,000 of volume and 5 traders of its own, funded or of unknown liquidity, is a candidate, valued at max(open, close); the ATH takes over when higher. Here the best candidate is not above the ATH (or there is none), so the wick is the ATH: 300,000 at m2881.
`,
  input: input(
    [
      pool('pool-a', [
        bar(minute(0), 0.0002),
        bar(minute(1), 0.0002),
        bar(minute(2880), 0.0003),
        bar(minute(2881), 0.0003),
      ]),
    ],
    minute(4548),
  ),
  expected: {
    athMarketCapUsd: 300_000,
    athAt: 1_700_092_860,
    athPoolAddress: 'pool-a',
    secondsToAth: 172_860,
    athWickMarketCapUsd: 300_000,
    athWickAt: 1_700_092_860,
    athWickPoolAddress: 'pool-a',
    athLiquidityUsd: null,
    athHourVolumeUsd: 1_000,
    secondsAbove: [172_860, 0, 0, 0],
    maxDrawdownPct: 0,
    rugPattern: false,
    flags: [],
  },
};
