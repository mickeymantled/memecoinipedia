import type { MetricFixture } from '../../../src/metrics/types.js';
import { bar, input, minute, pool } from './build.js';

export const exactly20BillionKept: MetricFixture = {
  name: 'exactly-20-billion-kept',
  description:
    'A bar whose market cap is exactly $20 billion is not above the limit, so it is kept and no flag is raised. It passes every threshold.',
  reasoning: `
One primary pool, bars m0 and m1: o = h = l = c = 20, 500 USD, 6 traders. 20 * 1e9 = $20,000,000,000, exactly maxMarketCapUsd. asOf = m2, launchedAt = T0.

Clean: dropping needs the market cap to be above the limit. It equals it, so nothing is dropped, no flag.
Windows: m0 one bar, not strict. m1 two bars, volume 1000, traders 6: strict, price 20.
ATH = 20 * 1e9 = 20,000,000,000 at m1: athAt = T0+60, secondsToAth 60.
Wick: 20 at m0 (T0): 20,000,000,000.
Level: one level point (m1, 20), holding to asOf (T0+120): 60 s. At or above all four thresholds ($100k, $1M, $10M, $100M): [60,60,60,60].
Drawdown 0. Rug false.

Rules v4 (this paragraph supersedes any wick figure above). athLiquidityUsd null (no bar of the ATH window reports liquidity); athHourVolumeUsd 1,000 (volume of the clean 1-minute bars of every pool in the hour ending at m1). Wick: only a clean 1-minute bar with at least $1,000 of volume and 5 traders of its own, funded or of unknown liquidity, is a candidate, valued at max(open, close); the ATH takes over when higher. Here the best candidate is not above the ATH (or there is none), so the wick is the ATH: 20,000,000,000 at m1.
`,
  input: input([pool('pool-a', [bar(minute(0), 20), bar(minute(1), 20)])], minute(2)),
  expected: {
    athMarketCapUsd: 20_000_000_000,
    athAt: 1_699_920_060,
    athPoolAddress: 'pool-a',
    secondsToAth: 60,
    athWickMarketCapUsd: 20_000_000_000,
    athWickAt: 1_699_920_060,
    athWickPoolAddress: 'pool-a',
    athLiquidityUsd: null,
    athHourVolumeUsd: 1_000,
    secondsAbove: [60, 60, 60, 60],
    maxDrawdownPct: 0,
    rugPattern: false,
    flags: [],
  },
};
