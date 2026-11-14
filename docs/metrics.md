# Price metric rules

This is the specification for every price metric the site shows: ATH market cap, time to ATH, time above each threshold, max drawdown and the rug pattern. The implementation (`/ingest/src/metrics`) and the test fixtures (`/ingest/test/fixtures/metrics`) are both written from this file, by different agents, so that the tests are an independent check. If the code and a fixture disagree, this file decides. If this file is unclear, the lead fixes this file first.

The thresholds are starting values. Task A6 tunes them against the 500-coin sample.

## 1. Inputs

- `totalSupply`: 1,000,000,000 for every pump.fun coin. Market cap is always price times `totalSupply`.
- `launchedAt`: when the coin was created, unix seconds.
- `asOf`: the end of the observation period, unix seconds. Bars that start after `asOf` are ignored.
- `pools`: every pool we hold bars for. Each pool has:
  - `address`, `dex`
  - `isPrimary`: true for the pump.fun bonding curve and for the pool the coin graduated into. False for every other pool.
  - `bars1m`, `bars1h`, `bars1d`: bars at 1-minute, 1-hour and 1-day resolution. Any of them may be empty.
- A bar has:
  - `t`: start of its bucket, unix seconds, UTC. A multiple of 60, 3,600 or 86,400.
  - `o`, `h`, `l`, `c`: price in USD per token.
  - `volumeUsd`: USD traded in the bucket.
  - `trades`: number of swaps in the bucket.
  - `traders`: distinct wallets that traded in the bucket.
  - `liquidityUsd`: pool liquidity in USD, or null when unknown.
- Only buckets with at least one trade have a bar. A missing minute means nobody traded.

Bars may arrive unsorted. Sort each list by `t` before use. The result must not depend on the order of bars or of pools in the input.

## 2. Parameters

| Name | Default | Meaning |
|---|---|---|
| `windowMinutes` | 3 | Length of the smoothing window |
| `minWindowVolumeUsd` | 1,000 | USD that must trade in a window for it to count |
| `minWindowTraders` | 5 | Distinct traders a window needs |
| `minSecondaryPoolLiquidityUsd` | 5,000 | Liquidity a non-primary pool needs for its bar to count |
| `carryForwardMaxSec` | 86,400 | Longest time a price is assumed to hold with no trades |
| `maxMarketCapUsd` | 20,000,000,000 | Anything above this is a data error |
| `thresholdsUsd` | 100k, 1M, 10M, 100M | Market caps that time-above is measured for |
| `rugDropPct` | 80 | Fall from ATH that counts as a rug |
| `rugWithinSec` | 1,800 | How soon after ATH the fall must happen |
| `rugRecoveryFraction` | 0.5 | A later recovery to this share of ATH cancels the rug |

All comparisons against a parameter are inclusive: a window with exactly $1,000 of volume counts, and a market cap of exactly $100,000 is above the $100k threshold.

## 3. Step 1: clean the bars

Apply in this order, to every resolution:

1. Ignore bars with `t` greater than `asOf`.
2. Drop a bar if any of `o`, `h`, `l`, `c` is not a finite number above zero, or `volumeUsd` is not a finite number of zero or more. Raise the flag `bad_bar`.
3. Drop a bar if the largest of `o`, `h`, `l`, `c` times `totalSupply` is above `maxMarketCapUsd`. Raise the flag `implausible_market_cap`. The whole bar goes, not only the bad field.
4. If a pool has two bars with the same `t` at the same resolution, keep the one that comes last in the input and raise the flag `duplicate_bar`.
5. Drop every bar of a non-primary pool whose `liquidityUsd` is null or below `minSecondaryPoolLiquidityUsd`. No flag. Bars of primary pools are never dropped for liquidity.

What is left are the clean bars.

## 4. Step 2: windows

**1-minute bars.** For each clean 1-minute bar at time `t` in a pool, its window is that pool's clean 1-minute bars in the `windowMinutes` minutes ending at `t`. With the default of 3 those are the bars at `t - 120`, `t - 60` and `t`, and between one and three of them are present.

- `price`: the lower median of the closes present. With three bars that is the middle close. With two bars it is the lower close. With one bar it is that bar's close. (For an even count, the lower median is the lower of the two middle values.)
- `volume`: the sum of `volumeUsd` over the bars present.
- `traders`: the highest `traders` value among the bars present. Per-minute counts of distinct wallets cannot be de-duplicated across minutes, so the highest single-minute count is the only number we can prove.
- `strict`: true when at least two bars are present, `volume` is at least `minWindowVolumeUsd`, and `traders` is at least `minWindowTraders`.

The effect with the default window: a price counts as reached only if at least two 1-minute closes in a 3-minute span were at or above it, with real volume and at least five wallets in one of those minutes. One candle cannot do it. Neither can two wallets trading back and forth.

**Hourly and daily bars.** Each clean bar is its own window: `price` is its close, `volume` its `volumeUsd`, `traders` its `traders`. `strict` is true when `volume` is at least `minWindowVolumeUsd` and `traders` is at least `minWindowTraders`.

**Finer data wins.** An hourly bar is not used as a window when any pool has a clean 1-minute bar inside that hour. A daily bar is not used as a window when any pool has a clean 1-minute or hourly bar inside that day. Those bars still count for the wick in step 4.

## 5. Step 3: one point per timestamp

Group the windows from all pools by `t`. Where more than one pool has a window at the same `t`, keep the window with the largest `volume`. On a tie, a primary pool wins; on a further tie, the pool with the smallest address by string comparison.

Each kept window is a **coin point**: `t`, `price`, `strict`, pool, resolution.

Using the busiest pool, not the highest price, means a small side pool that drifts away from the real price cannot set any metric.

## 6. Step 4: ATH and wick

- **ATH price** is the highest `price` among strict coin points that come from 1-minute bars. Hourly and daily bars never set the ATH.
- `athAt` is the `t` of the earliest such point, which is the last minute of its window. `athPoolAddress` is that point's pool.
- `athMarketCapUsd` is ATH price times `totalSupply`.
- `secondsToAth` is `athAt` minus `launchedAt`. If it is negative, keep the number and raise the flag `ath_before_launch`.
- If there is no strict 1-minute coin point, all four are null and the flag `no_qualifying_window` is raised.

- **Wick** is the highest value of `max(o, h, l, c)` over every clean bar, at every resolution, in every pool, including bars not used as windows. `athWickMarketCapUsd` is that times `totalSupply`; `athWickAt` and `athWickPoolAddress` come from the earliest bar that reaches it (on a tie in `t`, the smallest pool address). All three are null when there are no clean bars.

`athMarketCapUsd` can never exceed `athWickMarketCapUsd`.

**Coverage flag.** If a strict coin point from an hourly or daily bar has a `price` above the ATH price, or the ATH is null while such a point exists, raise `peak_outside_minute_coverage`. It means the real peak may sit in a period we hold no 1-minute bars for, and the fetcher must fetch them and recompute.

## 7. Step 5: the level series

The level is our running belief about the price. It drives time-above, drawdown and the rug pattern.

Walk the coin points in order of `t`. The level starts undefined.

- A strict point sets the level to its `price`.
- A point that is not strict can only lower the level: if the level is defined and the point's `price` is below it, the level becomes that `price`. Otherwise the level is unchanged.
- While the level is undefined, points that are not strict do nothing.

Every coin point at which the level is defined, whether or not it changed the level, produces a **level point** `(t, level)`.

The reason for the asymmetry: a thin trade at a high price is not proof anyone could have sold there, but a thin trade at a low price on the busiest pool is a real state of that pool.

## 8. Step 6: time above each threshold

Each level point holds until the next level point, for at most `carryForwardMaxSec`. The last level point holds until `asOf`, again for at most `carryForwardMaxSec`, and never for less than zero.

For each threshold, `secondsAbove` is the sum of the holds of the level points whose level times `totalSupply` is at or above the threshold.

For hourly and daily points `t` is the start of the bucket, so time-above is exact to the minute where we hold 1-minute bars and approximate to the bucket elsewhere.

`secondsAbove` for a higher threshold can never exceed that for a lower one.

## 9. Step 7: max drawdown

Over the level points in order, track the highest level so far. `maxDrawdownPct` is the largest value of `(peak so far - level) / peak so far`, times 100. It is 0 when the level never falls, and null when there are no level points.

## 10. Step 8: rug pattern

`rugPattern` is true when all of these hold, and false otherwise:

1. The ATH is not null.
2. There is a level point with `t` after `athAt` and no later than `athAt + rugWithinSec` whose level is at or below `(1 - rugDropPct / 100)` times the ATH price. Call the earliest one the crash point.
3. No strict coin point after the crash point, at any resolution, has a `price` at or above `rugRecoveryFraction` times the ATH price.

This is a price pattern, not proof of intent. Graduated pump.fun pools cannot have their liquidity withdrawn, so a rug here means a fast dump. The coin's `status` field combines this with current volume and liquidity; that logic is not part of this library.

## 11. Output

| Field | Type |
|---|---|
| `athMarketCapUsd`, `athAt`, `athPoolAddress`, `secondsToAth` | number or string, or null |
| `athWickMarketCapUsd`, `athWickAt`, `athWickPoolAddress` | number or string, or null |
| `secondsAbove` | one number of seconds for each threshold |
| `maxDrawdownPct` | number from 0 to 100, or null |
| `rugPattern` | boolean |
| `flags` | list of flag names, each at most once, sorted alphabetically |

Flags: `ath_before_launch`, `bad_bar`, `duplicate_bar`, `implausible_market_cap`, `no_qualifying_window`, `peak_outside_minute_coverage`.

The exact TypeScript shapes are in `/ingest/src/metrics/types.ts`.

## 12. What the fetcher must provide

These are requirements on ingestion (task A5), listed here because the rules above depend on them:

- 1-minute bars for the bonding curve's last hours and for the first 48 hours after graduation.
- Coarser bars for the rest of the coin's life, on every pool that passes the liquidity rule.
- 1-minute bars for any later day that could hold the peak. When `peak_outside_minute_coverage` is raised, fetch that period at 1-minute resolution and recompute until the flag clears.

## 13. Known limits

- A coin that spikes for exactly one minute on real volume gets an ATH below that minute's close. That is the price of rejecting single-candle wicks. The raw figure is kept as the wick, and A6 reviews the coins where the two differ most.
- A sustained data error that stays under $20 billion and lasts two minutes with volume would pass. A6 reviews every coin whose wick is far above its ATH and every coin whose ATH is far from the cross-check source.
- Requiring five wallets in a single minute is stricter than five across the window. Very slow, genuine markets can fail it. A6 measures how often.
