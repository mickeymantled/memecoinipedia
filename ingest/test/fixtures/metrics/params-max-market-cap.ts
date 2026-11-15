import type { MetricFixture } from '../../../src/metrics/types.js';
import { bar, flatRun, input, minute, pool } from './build.js';

export const paramsMaxMarketCap: MetricFixture = {
  name: 'params-max-market-cap',
  description:
    'A custom maxMarketCapUsd of $1,000,000: a $2M bar is a data error under it (dropped and flagged), though it would be fine under the default $20B.',
  reasoning: `
Parameter: maxMarketCapUsd 1,000,000. Others default.
One primary pool. m0..m3: close .0002 ($200k), 500 USD, 6 traders. m4: close .002 ($2M), 500 USD, 6 traders. asOf = m5 (T0+300), launchedAt = T0.

Clean: m4's market cap $2,000,000 is above the $1,000,000 limit: dropped, flag implausible_market_cap.
Windows: m0 not strict; m1, m2, m3 strict .0002.
ATH = 200,000 at m1: athAt = T0+60, secondsToAth 60.
Wick: .0002 at m0 (T0): 200,000. (The dropped .002 does not count.)
Level points m1, m2, m3: holds 60, 60, and m3 (T0+180) -> asOf (T0+300) 120. Total 240 above $100k.
Drawdown 0. Rug false. Flags: implausible_market_cap.

Rules v4 (this paragraph supersedes any wick figure above). athLiquidityUsd null (no bar of the ATH window reports liquidity); athHourVolumeUsd 1,000 (volume of the clean 1-minute bars of every pool in the hour ending at m1). Wick: only a clean 1-minute bar with at least $1,000 of volume and 5 traders of its own, funded or of unknown liquidity, is a candidate, valued at max(open, close); the ATH takes over when higher. Here the best candidate is not above the ATH (or there is none), so the wick is the ATH: 200,000 at m1.
`,
  params: { maxMarketCapUsd: 1_000_000 },
  input: input([pool('pool-a', [...flatRun(0, 4, 0.0002), bar(minute(4), 0.002)])], minute(5)),
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
    secondsAbove: [240, 0, 0, 0],
    maxDrawdownPct: 0,
    rugPattern: false,
    flags: ['implausible_market_cap'],
  },
};
