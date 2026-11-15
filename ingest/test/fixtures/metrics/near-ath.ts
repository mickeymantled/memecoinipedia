/**
 * Hand-worked fixtures for metric rules version 6 (docs/metrics.md section 6:
 * `athNearVolumeUsd` and the flag `ath_thinly_traded`). Every expected value is
 * a literal worked out from the document. They also pin every version 5 output,
 * because nothing reads the new output.
 */
import type { Bar, MetricFixture } from '../../../src/metrics/types.js';
import { bar, dayAt, hourAt, input, minute, pool, T0 } from './build.js';

/** Hour `k` of the walk: 35 bars (minutes 0 to 34), 1,000 USD each, 6 traders. */
function walkHour(k: number, price: number, bars: number): Bar[] {
  return Array.from({ length: bars }, (_, i) =>
    bar(hourAt(k) + i * 60, price, { volumeUsd: 1_000 }),
  );
}

// Market caps 1M, 2M, 5M, 10M, 20M, 50M, 100M, 200M, 500M and 1B, as prices.
const WALK_PRICES = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1];

const walkBars: Bar[] = [
  ...WALK_PRICES.slice(0, 9).flatMap((p, k) => walkHour(k, p, 35)),
  ...walkHour(9, 1, 30),
  // The sale: minute 30 of hour 9, 2,000,000 USD at a market cap of 1,000; then one more low minute.
  bar(hourAt(9) + 30 * 60, 0.000001, { volumeUsd: 2_000_000 }),
  bar(hourAt(9) + 31 * 60, 0.000001, { volumeUsd: 1_000 }),
];

const thinWalkThenSale: MetricFixture = {
  name: 'near-ath-thin-walk-then-large-sale',
  description:
    'The pattern of issue 77: price walked from $1 million to $1 billion over ten hours on $35,000 an hour, then one large sale. The flag is raised and every other output is what version 5 gives.',
  reasoning: `
One primary pool, launchedAt = T0, asOf = T0 + 36,000 (end of hour 9). Hour k (0 to 8) has 35 bars (minutes 0 to 34), 1,000 USD, 6 traders, all four prices flat at p_k = .001, .002, .005, .01, .02, .05, .1, .2, .5 (market caps 1M, 2M, 5M, 10M, 20M, 50M, 100M, 200M, 500M). Hour 9 has 30 bars (minutes 0 to 29) at p9 = 1 (1B), then minute 30: close .000001 (cap 1,000), 2,000,000 USD; minute 31: close .000001, 1,000 USD.

Windows: minute 0 of an hour has no bar two minutes before (minutes 58 and 59 are empty): one bar, not strict. Minute 1 has two bars, 2,000 USD, strict, price p_k. Every later minute is strict. So the level is p_k from minute 1 of hour k to minute 1 of hour k+1 (minute 0 of hour k+1 is not strict and higher: the level is unchanged). Hour 0 minute 0: level undefined, nothing.
ATH: the highest strict 1-minute price is p9 = 1: 1,000,000,000 at hour 9 minute 1, the earliest: athAt = T0 + 32,460, secondsToAth 32,460. athLiquidityUsd null.
athHourVolumeUsd: bars with t in (T0 + 28,860, T0 + 32,460]: hour 8 minutes 2 to 34 (33 bars, 33,000) and hour 9 minutes 0 and 1 (2,000) = 35,000.
Wick: candidates are all bars (1,000 USD, 6 traders, liquidity unknown). The highest max(open, close) is 1, first at hour 9 minute 0. The ATH price is not higher, so the wick is that bar: 1,000,000,000 at T0 + 32,400.
Level at hour 9 minute 30: window (m28, m29, m30) closes 1, 1, .000001: lower median 1, strict (volume 2,002,000): level 1. At minute 31: window (m29, m30, m31) lower median .000001, strict: level 1,000 as a market cap.
Time above: each p_k (k 0 to 8) holds 3,600 s; p9 holds from minute 1 to minute 31 of hour 9: 1,800 s; the last level (cap 1,000) holds 1,740 s to asOf and is under every threshold. At or above 100k and 1M: 9 x 3,600 + 1,800 = 34,200. At or above 10M (p3 on): 6 x 3,600 + 1,800 = 23,400. At or above 100M (p6 on): 3 x 3,600 + 1,800 = 12,600.
Drawdown: peak 1, lowest level .000001: (1 - .000001) x 100 = 99.9999.
Rug: the level point at minute 31 is athAt + 1,800, within the 1,800 s window, at .000001, below 20% of the ATH; no strict point after it reaches half the ATH: true.
athNearVolumeUsd: closes at or above .5 x 1 = .5: hour 8 (close .5, exactly half, 35 bars, 35,000) and hour 9 minutes 0 to 29 (30,000) = 65,000. The sale bars close at .000001 and add nothing. The line is .2 x 1,000,000,000 = 200,000,000; 65,000 is below it: ath_thinly_traded.
athBackedMarketCapUsd (share .2, fraction .5): groups by market cap, highest first, V_i and candidate = smaller of cap_i / .5 and V_i / .2. 1B: V 30,000, 150,000. 500M: V 65,000, 325,000. 200M: V 100,000, 500,000. 100M: 135,000, 675,000. 50M: 170,000, 850,000. 20M: 205,000, 1,025,000. 10M: 240,000, 1,200,000. 5M: 275,000, 1,375,000. 2M: 310,000, 1,550,000. 1M: 345,000, 1,725,000 (cap / .5 = 2M is larger). 1,000: V 2,346,000, candidate 2,000 (cap / .5). The largest is 1,725,000: at that market cap the bars at or above 862,500 are the 1M group and higher, 345,000 = .2 x 1,725,000.
`,
  input: input([pool('pool-a', walkBars)], hourAt(10)),
  expected: {
    athMarketCapUsd: 1_000_000_000,
    athAt: 1_699_952_460,
    athPoolAddress: 'pool-a',
    secondsToAth: 32_460,
    athWickMarketCapUsd: 1_000_000_000,
    athWickAt: 1_699_952_400,
    athWickPoolAddress: 'pool-a',
    athLiquidityUsd: null,
    athHourVolumeUsd: 35_000,
    athNearVolumeUsd: 65_000,
    athBackedMarketCapUsd: 1_725_000,
    secondsAbove: [34_200, 34_200, 23_400, 12_600],
    maxDrawdownPct: 99.9999,
    rugPattern: true,
    flags: ['ath_thinly_traded'],
  },
};

const heavyTrading: MetricFixture = {
  name: 'near-ath-fifty-million-traded-no-flag',
  description:
    '$50 million traded in the minutes around a $100 million high: the near volume is half the ATH market cap, far above the 5% line, and the flag is not raised.',
  reasoning: `
One primary pool, bars at m0 to m9, close .1 (market cap 100,000,000), 5,000,000 USD and 6 traders each. launchedAt = T0, asOf = m10.

Windows: m0 one bar, not strict, level undefined: nothing. m1 (m0, m1): 10,000,000 USD, strict, .1. Every later window is strict at .1.
ATH: .1 x 1e9 = 100,000,000 at m1 (earliest): athAt = T0 + 60, secondsToAth 60.
Wick: the candidates are all bars; the highest value .1 first at m0: 100,000,000 at T0. athHourVolumeUsd: bars in (m1 - 3,600, m1] are m0 and m1: 10,000,000.
Level points m1 to m9, all at .1, each held 60 s; m9 is held until asOf = m10, also 60 s: 9 x 60 = 540 s at or above every threshold (100,000,000 is at or above 100M).
Drawdown 0. Rug false.
athNearVolumeUsd: every bar closes at .1, at or above .5 x .1: 10 x 5,000,000 = 50,000,000. The line is .2 x 100,000,000 = 20,000,000. 50,000,000 is not below it: no flag, and the backed high is the ATH itself, 100,000,000.
`,
  input: input(
    [
      pool(
        'pool-a',
        Array.from({ length: 10 }, (_, i) => bar(minute(i), 0.1, { volumeUsd: 5_000_000 })),
      ),
    ],
    minute(10),
  ),
  expected: {
    athMarketCapUsd: 100_000_000,
    athAt: 1_699_920_060,
    athPoolAddress: 'pool-a',
    secondsToAth: 60,
    athWickMarketCapUsd: 100_000_000,
    athWickAt: 1_699_920_000,
    athWickPoolAddress: 'pool-a',
    athLiquidityUsd: null,
    athHourVolumeUsd: 10_000_000,
    athNearVolumeUsd: 50_000_000,
    athBackedMarketCapUsd: 100_000_000,
    secondsAbove: [540, 540, 540, 540],
    maxDrawdownPct: 0,
    rugPattern: false,
    flags: [],
  },
};

const halfBoundary: MetricFixture = {
  name: 'near-ath-close-exactly-half-counts-just-under-does-not',
  description:
    'A bar closing at exactly half the ATH price is counted; a bar closing just under half adds nothing.',
  reasoning: `
One primary pool, 6 traders a bar, launchedAt = T0, asOf = m5. Closes and volumes: m0 .2 / 1,000; m1 .2 / 1,000; m2 .2 / 1,000; m3 .1 / 111; m4 .0999999 / 222.

Windows: m0 one bar, not strict, level undefined. m1 (m0, m1) 2,000 USD strict .2. m2 3,000 strict .2. m3 (m1, m2, m3): lower median of .2, .2, .1 is .2, volume 2,111, strict: level .2. m4 (m2, m3, m4): closes .2, .1, .0999999: lower median .1, volume 1,333, strict: the level becomes .1.
ATH: .2 x 1e9 = 200,000,000 at m1 (earliest of m1, m2, m3), athAt = T0 + 60, secondsToAth 60.
Wick: candidates are the bars with 1,000 USD: m0, m1, m2, all .2; earliest m0: 200,000,000 at T0.
athHourVolumeUsd: m0 and m1: 2,000.
Level points m1 .2, m2 .2, m3 .2, m4 .1, each held 60 s (m4 until asOf = m5). All are at or above $100M (.1 x 1e9 = 100M): 240 s in every column.
Drawdown: (.2 - .1) / .2 = 50. Rug false (.1 is not at or below 20% of the ATH).
athNearVolumeUsd: the limit is .5 x .2 = .1. m0, m1, m2 close at .2: 3,000. m3 closes at exactly .1: counted, 111. m4 closes at .0999999: not counted. Total 3,111. The line is .2 x 200,000,000 = 40,000,000: 3,111 is below it, ath_thinly_traded.
athBackedMarketCapUsd: groups by market cap: 200,000,000 (m0, m1, m2): V 3,000, candidate = smaller of 400,000,000 and 15,000 = 15,000. 100,000,000: V 3,111, 15,555. 99,999,900: V 3,333, smaller of 199,999,800 and 16,665 = 16,665. The largest is 16,665.
`,
  input: input(
    [
      pool('pool-a', [
        bar(minute(0), 0.2, { volumeUsd: 1_000 }),
        bar(minute(1), 0.2, { volumeUsd: 1_000 }),
        bar(minute(2), 0.2, { volumeUsd: 1_000 }),
        bar(minute(3), 0.1, { volumeUsd: 111 }),
        bar(minute(4), 0.0999999, { volumeUsd: 222 }),
      ]),
    ],
    minute(5),
  ),
  expected: {
    athMarketCapUsd: 200_000_000,
    athAt: 1_699_920_060,
    athPoolAddress: 'pool-a',
    secondsToAth: 60,
    athWickMarketCapUsd: 200_000_000,
    athWickAt: 1_699_920_000,
    athWickPoolAddress: 'pool-a',
    athLiquidityUsd: null,
    athHourVolumeUsd: 2_000,
    athNearVolumeUsd: 3_111,
    athBackedMarketCapUsd: 16_665,
    secondsAbove: [240, 240, 240, 240],
    maxDrawdownPct: 50,
    rugPattern: false,
    flags: ['ath_thinly_traded'],
  },
};

const countedOnce: MetricFixture = {
  name: 'near-ath-each-stretch-counted-once-at-finest-resolution',
  description:
    'An hour covered by 1-minute bars is counted from those bars only, an hour without them from its hourly bar, and a day with neither from its daily bar. Never twice.',
  reasoning: `
One primary pool, launchedAt = T0, asOf = T0 + 90,000. 1-minute bars: m0 and m1, close .2, 1,000 USD, 6 traders. Hourly bars (all close .2, 1 trader, so never strict): hour 0 (T0) 7,000 USD; hour 5 (T0 + 18,000) 300 USD. Daily bars (close .2, 1 trader): day 0 (T0) 9,000 USD; day 1 (T0 + 86,400) 40 USD.

Finer data wins: hour 0 has 1-minute bars inside it, so the hourly bar of hour 0 is not a window and is not counted. Hour 5 has none: it is used. Day 0 has 1-minute and hourly bars inside it: not used, not counted. Day 1 has neither: used.
Windows: m0 not strict. m1 (m0, m1) 2,000 USD strict .2. The used hourly and daily bars are not strict (1 trader), close .2: they cannot raise the level, and .2 is not below it, so the level stays .2.
ATH: .2 x 1e9 = 200,000,000 at m1; athAt = T0 + 60, secondsToAth 60. Hourly and daily bars never set it. No used coarse bar has a high above .2 and none is strict: no coverage flag.
Wick: m0 and m1 are candidates at .2, earliest m0: 200,000,000 at T0. athHourVolumeUsd: m0 and m1, 2,000.
Level points: m1 (T0 + 60), hour 5 (T0 + 18,000), day 1 (T0 + 86,400), all .2. Holds: 17,940 + 68,400 + (asOf - day 1 = 3,600) = 89,940 s at or above every threshold. Drawdown 0. Rug false.
athNearVolumeUsd: 1-minute bars 2,000 + hour 5 (300) + day 1 (40) = 2,340. Not counted: hour 0 (7,000) and day 0 (9,000), which would make 18,340 if counted twice. The line is .2 x 200,000,000 = 40,000,000: ath_thinly_traded.
athBackedMarketCapUsd: the counted bars are the four at market cap 200,000,000 (m0, m1, hour 5, day 1), one group with V 2,340: candidate = smaller of 400,000,000 and 2,340 / .2 = 11,700. The backed high is 11,700.
`,
  input: input(
    [
      pool(
        'pool-a',
        [bar(minute(0), 0.2, { volumeUsd: 1_000 }), bar(minute(1), 0.2, { volumeUsd: 1_000 })],
        {
          bars1h: [
            bar(hourAt(0), 0.2, { volumeUsd: 7_000, traders: 1 }),
            bar(hourAt(5), 0.2, { volumeUsd: 300, traders: 1 }),
          ],
          bars1d: [
            bar(dayAt(0), 0.2, { volumeUsd: 9_000, traders: 1 }),
            bar(dayAt(1), 0.2, { volumeUsd: 40, traders: 1 }),
          ],
        },
      ),
    ],
    T0 + 90_000,
  ),
  expected: {
    athMarketCapUsd: 200_000_000,
    athAt: 1_699_920_060,
    athPoolAddress: 'pool-a',
    secondsToAth: 60,
    athWickMarketCapUsd: 200_000_000,
    athWickAt: 1_699_920_000,
    athWickPoolAddress: 'pool-a',
    athLiquidityUsd: null,
    athHourVolumeUsd: 2_000,
    athNearVolumeUsd: 2_340,
    athBackedMarketCapUsd: 11_700,
    secondsAbove: [89_940, 89_940, 89_940, 89_940],
    maxDrawdownPct: 0,
    rugPattern: false,
    flags: ['ath_thinly_traded'],
  },
};

const poolsSummedAndDroppedAdd: MetricFixture = {
  name: 'near-ath-sums-pools-that-count-and-ignores-dropped',
  description:
    'Every pool that counts is summed, not only the busiest; a side pool dropped by the liquidity rule and a bar dropped as bad add nothing.',
  reasoning: `
launchedAt = T0, asOf = m4, 6 traders a bar. pool-a (primary): m0, m1, m2 close .2, 1,000 USD; m3 a bad bar (close 0, 900,000 USD). pool-c (not primary, liquidity 10,000 on every bar): m1 .2 / 400, m2 .12 / 250, m3 .04 / 600. pool-b (not primary, liquidity 100 on every bar): m1 .2 / 5,000,000.

Cleaning: pool-a m3 is dropped (close 0): flag bad_bar. All of pool-b is dropped (liquidity 100 is under 5,000).
Windows: m0 pool-a one bar, not strict. m1: pool-a (m0, m1) 2,000 strict .2 beats pool-c (400, not strict). m2: pool-a 3,000 strict .2 beats pool-c (650). m3: only pool-c has a window: (m1, m2, m3) closes .2, .12, .04, lower median .12, volume 1,250, 6 traders, liquidity 10,000, strict, .12.
ATH: .2 x 1e9 = 200,000,000 at m1 (pool-a), athAt = T0 + 60, secondsToAth 60. athHourVolumeUsd: clean 1-minute bars of every pool in (m1 - 3,600, m1]: pool-a m0, m1 2,000 + pool-c m1 400 = 2,400.
Wick: candidates with 1,000 USD: pool-a m0, m1, m2 (.2). Earliest m0, pool-a: 200,000,000 at T0.
Level points: m1 .2, m2 .2, m3 .12 (strict, so it sets the level), each held 60 s (m3 until asOf = m4). All at or above $100M: 180 s in every column. Drawdown (.2 - .12) / .2 = 40. Rug false.
athNearVolumeUsd, limit .1: pool-a m0, m1, m2 = 3,000; pool-c m1 (.2) 400 and m2 (.12) 250; pool-c m3 (.04) not counted. pool-b's 5,000,000 and pool-a's bad bar add nothing. Total 3,650. The line is .2 x 200,000,000 = 40,000,000: ath_thinly_traded.
athBackedMarketCapUsd: counted bars in groups by market cap: 200,000,000 (pool-a m0, m1, m2 and pool-c m1): V 3,400, candidate 17,000. 120,000,000 (pool-c m2): V 3,650, candidate 18,250. 40,000,000 (pool-c m3): V 4,250, smaller of 80,000,000 and 21,250 = 21,250. The largest is 21,250; pool-b and the bad bar add nothing. Flags sorted: ath_thinly_traded, bad_bar.
`,
  input: input(
    [
      pool('pool-a', [
        bar(minute(0), 0.2, { volumeUsd: 1_000 }),
        bar(minute(1), 0.2, { volumeUsd: 1_000 }),
        bar(minute(2), 0.2, { volumeUsd: 1_000 }),
        bar(minute(3), 0, { volumeUsd: 900_000 }),
      ]),
      pool(
        'pool-c',
        [
          bar(minute(1), 0.2, { volumeUsd: 400, liquidityUsd: 10_000 }),
          bar(minute(2), 0.12, { volumeUsd: 250, liquidityUsd: 10_000 }),
          bar(minute(3), 0.04, { volumeUsd: 600, liquidityUsd: 10_000 }),
        ],
        { isPrimary: false },
      ),
      pool('pool-b', [bar(minute(1), 0.2, { volumeUsd: 5_000_000, liquidityUsd: 100 })], {
        isPrimary: false,
      }),
    ],
    minute(4),
  ),
  expected: {
    athMarketCapUsd: 200_000_000,
    athAt: 1_699_920_060,
    athPoolAddress: 'pool-a',
    secondsToAth: 60,
    athWickMarketCapUsd: 200_000_000,
    athWickAt: 1_699_920_000,
    athWickPoolAddress: 'pool-a',
    athLiquidityUsd: null,
    athHourVolumeUsd: 2_400,
    athNearVolumeUsd: 3_650,
    athBackedMarketCapUsd: 21_250,
    secondsAbove: [180, 180, 180, 180],
    maxDrawdownPct: 40,
    rugPattern: false,
    flags: ['ath_thinly_traded', 'bad_bar'],
  },
};

const noAth: MetricFixture = {
  name: 'near-ath-no-ath-null-and-no-flag',
  description: 'With no ATH the output is null and the flag is not raised.',
  reasoning: `
One primary pool, bars m0 and m1 at close .0002, 100 USD, 6 traders. launchedAt = T0, asOf = m2.

Windows: m0 one bar; m1 (m0, m1) 200 USD, under the 1,000 USD a window needs: not strict. No strict window: no level (a point that is not strict does nothing while the level is undefined).
ATH: null in all four fields, flag no_qualifying_window. Wick: no bar has 1,000 USD of its own: no candidate, and no ATH to fall back on: null. athLiquidityUsd, athHourVolumeUsd null. secondsAbove 0 in every column, drawdown null (no level points), rug false.
athNearVolumeUsd and athBackedMarketCapUsd: null, because the ATH is null. The flag ath_thinly_traded needs an ATH: not raised. Flags: no_qualifying_window only.
`,
  input: input(
    [
      pool('pool-a', [
        bar(minute(0), 0.0002, { volumeUsd: 100 }),
        bar(minute(1), 0.0002, { volumeUsd: 100 }),
      ]),
    ],
    minute(2),
  ),
  expected: {
    athMarketCapUsd: null,
    athAt: null,
    athPoolAddress: null,
    secondsToAth: null,
    athWickMarketCapUsd: null,
    athWickAt: null,
    athWickPoolAddress: null,
    athLiquidityUsd: null,
    athHourVolumeUsd: null,
    athNearVolumeUsd: null,
    athBackedMarketCapUsd: null,
    secondsAbove: [0, 0, 0, 0],
    maxDrawdownPct: null,
    rugPattern: false,
    flags: ['no_qualifying_window'],
  },
};

/** Two bars at .2: one of `first` USD and one of 5,000,000 USD, so the near volume is first + 5,000,000. */
function limitCase(name: string, first: number, flagged: boolean): MetricFixture {
  const near = first + 5_000_000;
  return {
    name,
    description: flagged
      ? 'Near volume just under 20% of the ATH market cap: the flag is raised and the backed high is the volume divided by the share.'
      : 'Near volume exactly 20% of the ATH market cap is not below the line: the flag is not raised and the backed high is the ATH.',
    reasoning: `
One primary pool, bars m0 and m1 at close .2, 6 traders: m0 ${first.toLocaleString('en-US')} USD, m1 5,000,000 USD. launchedAt = T0, asOf = m2.

Windows: m0 one bar, not strict. m1 (m0, m1) ${near.toLocaleString('en-US')} USD, strict, .2. ATH .2 x 1e9 = 200,000,000 at m1: athAt = T0 + 60, secondsToAth 60. Wick: both bars are candidates (1,000 USD or more, 6 traders); the first at .2 is m0: 200,000,000 at T0. athHourVolumeUsd: m0 and m1: ${near.toLocaleString('en-US')}.
Level: the single level point m1 (.2) is held until asOf: 60 s at or above every threshold. Drawdown 0. Rug false.
athNearVolumeUsd: both bars close at .2, at or above .1: ${near.toLocaleString('en-US')}. The line is .2 x 200,000,000 = 40,000,000. ${flagged ? `${near.toLocaleString('en-US')} is below it: ath_thinly_traded. One group (both bars close at .2, market cap 200,000,000) with V = ${near.toLocaleString('en-US')}: the candidate is the smaller of 200,000,000 / .5 = 400,000,000 and ${near.toLocaleString('en-US')} / .2 = ${(near * 5).toLocaleString('en-US')}, so the backed high is ${(near * 5).toLocaleString('en-US')}.` : 'The volume equals it: not below, no flag, and the backed high is the ATH, 200,000,000.'}
`,
    input: input(
      [
        pool('pool-a', [
          bar(minute(0), 0.2, { volumeUsd: first }),
          bar(minute(1), 0.2, { volumeUsd: 5_000_000 }),
        ]),
      ],
      minute(2),
    ),
    expected: {
      athMarketCapUsd: 200_000_000,
      athAt: 1_699_920_060,
      athPoolAddress: 'pool-a',
      secondsToAth: 60,
      athWickMarketCapUsd: 200_000_000,
      athWickAt: 1_699_920_000,
      athWickPoolAddress: 'pool-a',
      athLiquidityUsd: null,
      athHourVolumeUsd: near,
      athNearVolumeUsd: near,
      athBackedMarketCapUsd: flagged ? near * 5 : 200_000_000,
      secondsAbove: [60, 60, 60, 60],
      maxDrawdownPct: 0,
      rugPattern: false,
      flags: flagged ? ['ath_thinly_traded'] : [],
    },
  };
}

const spikeOnThinVolume: MetricFixture = {
  name: 'near-ath-backed-high-is-the-level-not-the-spike',
  description:
    '$80 million traded between $40 million and $60 million, then the price walked to $400 million on $1 million of volume: the backed high is the hand-worked level of $120 million, not the spike.',
  reasoning: `
One primary pool, 6 traders a bar, launchedAt = T0, asOf = m13. m0 to m3: close .04 (market cap 40,000,000), 10,000,000 USD each. m4 to m7: close .06 (60,000,000), 10,000,000 USD each: 80,000,000 in all. Then the walk, 200,000 USD a bar: m8 .1, m9 .2, m10 .3, m11 .4, m12 .4 (1,000,000 in all).

Windows (lower median of the closes present; every window from m1 on is strict): m0 not strict, level undefined. m1 .04, m2 .04, m3 .04, m4 (.04, .04, .06) .04, m5 (.04, .06, .06) .06, m6 .06, m7 .06, m8 (.06, .06, .1) .06, m9 (.06, .1, .2) .1, m10 (.1, .2, .3) .2, m11 (.2, .3, .4) .3, m12 (.3, .4, .4) .4.
ATH: .4 x 1e9 = 400,000,000, first strict at m12: athAt = T0 + 720, secondsToAth 720.
Wick: every bar is a candidate (200,000 USD or more, 6 traders); the highest max(open, close) is .4, first at m11: 400,000,000 at T0 + 660 (the ATH price is not higher).
athHourVolumeUsd: every bar is in (m12 - 3,600, m12]: 80,000,000 + 1,000,000 = 81,000,000.
Level points m1 to m12, each held 60 s (m12 until asOf): levels .04 (m1 to m4), .06 (m5 to m8), .1, .2, .3, .4. All 12 are at or above $10M: 720 s for the first three thresholds; at or above $100M: .1, .2, .3, .4: 240 s. The level never falls: drawdown 0, rug false.
athNearVolumeUsd: closes at or above .2: m9 to m12, 4 x 200,000 = 800,000. The line is .2 x 400,000,000 = 80,000,000: ath_thinly_traded.
athBackedMarketCapUsd (fraction .5, share .2), groups by market cap, highest first: 400,000,000 (m11, m12): V 400,000, candidate = smaller of 800,000,000 and 2,000,000 = 2,000,000. 300,000,000: V 600,000, 3,000,000. 200,000,000: V 800,000, 4,000,000. 100,000,000: V 1,000,000, 5,000,000. 60,000,000 (4 bars): V 41,000,000, smaller of 120,000,000 and 205,000,000 = 120,000,000. 40,000,000: V 81,000,000, smaller of 80,000,000 and 405,000,000 = 80,000,000. The largest is 120,000,000: the bars at or above 60,000,000 hold 41,000,000, at least .2 x 120,000,000 = 24,000,000; above it the 60,000,000 group drops out and only 1,000,000 is left.
`,
  input: input(
    [
      pool('pool-a', [
        ...[0, 1, 2, 3].map((i) => bar(minute(i), 0.04, { volumeUsd: 10_000_000 })),
        ...[4, 5, 6, 7].map((i) => bar(minute(i), 0.06, { volumeUsd: 10_000_000 })),
        bar(minute(8), 0.1, { volumeUsd: 200_000 }),
        bar(minute(9), 0.2, { volumeUsd: 200_000 }),
        bar(minute(10), 0.3, { volumeUsd: 200_000 }),
        bar(minute(11), 0.4, { volumeUsd: 200_000 }),
        bar(minute(12), 0.4, { volumeUsd: 200_000 }),
      ]),
    ],
    minute(13),
  ),
  expected: {
    athMarketCapUsd: 400_000_000,
    athAt: 1_699_920_720,
    athPoolAddress: 'pool-a',
    secondsToAth: 720,
    athWickMarketCapUsd: 400_000_000,
    athWickAt: 1_699_920_660,
    athWickPoolAddress: 'pool-a',
    athLiquidityUsd: null,
    athHourVolumeUsd: 81_000_000,
    athNearVolumeUsd: 800_000,
    athBackedMarketCapUsd: 120_000_000,
    secondsAbove: [720, 720, 720, 240],
    maxDrawdownPct: 0,
    rugPattern: false,
    flags: ['ath_thinly_traded'],
  },
};

const equalCloses: MetricFixture = {
  name: 'near-ath-backed-high-takes-equal-closes-together',
  description:
    'Four bars with the same close, from two pools, are one group: the backed high is their whole volume over the share. Counting only one of them, or dropping the rest, gives another answer.',
  reasoning: `
launchedAt = T0, asOf = m6, 6 traders a bar. pool-a (primary): m0 .1 / 3,000 USD; m1 .1 / 3,000; m5 close .00001 / 500. pool-c (not primary, liquidity 10,000 on every bar): m1 .1 / 2,000; m2 .1 / 1,000.

Windows: pool-a m0 one bar, not strict. pool-a m1 (m0, m1) 6,000 USD strict .1; pool-c m1 one bar (2,000), not strict: pool-a is busier and wins the timestamp. pool-c m2 (m1, m2) 3,000 USD, 6 traders, funded: strict .1 (the only window at m2). pool-a m5 one bar (the minutes before are empty), not strict, price .00001.
Level: m0 nothing (undefined); m1 .1; m2 .1; m5 .00001 (a point that is not strict can lower the level).
ATH: .1 x 1e9 = 100,000,000 at m1 (pool-a): athAt = T0 + 60, secondsToAth 60.
Wick: candidates with 1,000 USD and 6 traders: pool-a m0, m1, pool-c m1, m2, all .1; earliest m0, pool-a: 100,000,000 at T0.
athHourVolumeUsd: 1-minute bars of every pool in (m1 - 3,600, m1]: pool-a m0, m1 6,000 + pool-c m1 2,000 = 8,000.
Level holds: m1 to m2 60 s, m2 to m5 180 s at .1, m5 to asOf 60 s at .00001 (market cap 10,000, under every threshold): 240 s in every column. Drawdown (.1 - .00001) / .1 = 99.99. Rug: the level point at m5 is athAt + 240, at .00001, below 20% of the ATH, and nothing strict follows: true.
athNearVolumeUsd: closes at or above .05: the four bars at .1: 3,000 + 3,000 + 2,000 + 1,000 = 9,000. The line is .2 x 100,000,000 = 20,000,000: ath_thinly_traded.
athBackedMarketCapUsd, groups by market cap: 100,000,000 (all four bars together): V 9,000, candidate = smaller of 200,000,000 and 9,000 / .2 = 45,000. 10,000 (pool-a m5): V 9,500, smaller of 10,000 / .5 = 20,000 and 47,500 = 20,000. The largest is 45,000. Taking one of the four equal bars alone would give 3,000 / .2 = 15,000 or less, and the lower group's 20,000 would win: the answer would be wrong.
`,
  input: input(
    [
      pool('pool-a', [
        bar(minute(0), 0.1, { volumeUsd: 3_000 }),
        bar(minute(1), 0.1, { volumeUsd: 3_000 }),
        bar(minute(5), 0.00001, { volumeUsd: 500 }),
      ]),
      pool(
        'pool-c',
        [
          bar(minute(1), 0.1, { volumeUsd: 2_000, liquidityUsd: 10_000 }),
          bar(minute(2), 0.1, { volumeUsd: 1_000, liquidityUsd: 10_000 }),
        ],
        { isPrimary: false },
      ),
    ],
    minute(6),
  ),
  expected: {
    athMarketCapUsd: 100_000_000,
    athAt: 1_699_920_060,
    athPoolAddress: 'pool-a',
    secondsToAth: 60,
    athWickMarketCapUsd: 100_000_000,
    athWickAt: 1_699_920_000,
    athWickPoolAddress: 'pool-a',
    athLiquidityUsd: null,
    athHourVolumeUsd: 8_000,
    athNearVolumeUsd: 9_000,
    athBackedMarketCapUsd: 45_000,
    secondsAbove: [240, 240, 240, 240],
    maxDrawdownPct: 99.99,
    rugPattern: true,
    flags: ['ath_thinly_traded'],
  },
};

const shareZero: MetricFixture = {
  ...halfBoundary,
  name: 'near-ath-share-zero-backed-high-is-the-ath',
  description:
    'With a share of 0 nothing is thinly traded: the flag is not raised and the backed high is the ATH, with no division by zero.',
  reasoning: `
The input of near-ath-close-exactly-half-counts-just-under-does-not (one pool, closes .2, .2, .2, .1, .0999999; volumes 1,000, 1,000, 1,000, 111, 222; launchedAt = T0, asOf = m5) with minAthNearVolumeShare set to 0.

Every output except the flag and the backed high is as in that fixture: ATH 200,000,000 at m1, wick at m0, athHourVolumeUsd 2,000, athNearVolumeUsd 3,111 (fraction .5 unchanged), secondsAbove 240 in every column, drawdown 50, rug false.
Flag: the near volume 3,111 is at least 0 x 200,000,000 = 0 (the usual tolerance included): ath_thinly_traded is not raised. Flags are empty.
athBackedMarketCapUsd: not flagged, so it is the ATH itself, 200,000,000. With a share of 0 every market cap is backed, and no candidate V_i / 0 is ever formed.
`,
  params: { minAthNearVolumeShare: 0 },
  expected: { ...halfBoundary.expected, athBackedMarketCapUsd: 200_000_000, flags: [] },
};

export const metricFixturesV6: MetricFixture[] = [
  thinWalkThenSale,
  heavyTrading,
  halfBoundary,
  countedOnce,
  poolsSummedAndDroppedAdd,
  noAth,
  limitCase('near-ath-volume-exactly-at-the-line-no-flag', 35_000_000, false),
  limitCase('near-ath-volume-just-under-the-line-flag', 34_999_999, true),
  spikeOnThinVolume,
  equalCloses,
  shareZero,
];
