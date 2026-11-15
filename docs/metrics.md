# Price metric rules

This is the specification for every price metric the site shows: ATH market cap, time to ATH, time above each threshold, max drawdown and the rug pattern. The implementation (`/ingest/src/metrics`) and the test fixtures (`/ingest/test/fixtures/metrics`) are both written from this file, by different agents, so that the tests are an independent check. If the code and a fixture disagree, this file decides. If this file is unclear, the lead fixes this file first.

The thresholds are starting values. Task A6 tunes them against the 500-coin sample.

## 1. Inputs

- `totalSupply`: 1,000,000,000 for every pump.fun coin. Market cap is always price times `totalSupply`.
- `launchedAt`: when the coin was created, unix seconds.
- `asOf`: the end of the observation period, unix seconds. Bars that start after `asOf` are ignored. A bar that starts at or before `asOf` is kept whole, even when its bucket ends later.
- `pools`: every pool we hold bars for. Each pool has:
  - `address`, `dex`
  - `isPrimary`: true for the pump.fun bonding curve and for the pool the coin graduated into. False for every other pool.
- **Which pools are in the input.** The loader that builds the input from stored pools (not the metric library) applies this rule, in addition to the liquidity rule in section 3, rule 5. The bonding curve and the graduation pool (`isPrimary` true) always go in, whatever their quote token. Any other pool (`isPrimary` false) goes in only when its quote token is SOL, USDC or USDT: the stored `quote_token` equals one of the three mint addresses (wrapped SOL `So11111111111111111111111111111111111111112`, USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, USDT `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB`) or one of the symbols `SOL`, `USDC`, `USDT` (exact, case-sensitive, after trimming white space). A side pool with no quote token recorded is left out. The reason: a pool quoted in another memecoin prices the coin as the product of two thin prices, and a few thousand dollars of trading can set a nine-figure ATH. A left-out pool is only left out of the input: the pool and its bars stay stored, and play no part in the ATH, the wick, the level series, the coverage flag or the status. Every path that builds an input from stored pools (the metrics stage, and the fetcher's peak refinement) goes through the same loader, so they always see the same pools. The loader reports how many side pools it left out; the metrics stage records it as `sidePoolsLeftOut` in its detail when above zero.
  - `bars1m`, `bars1h`, `bars1d`: bars at 1-minute, 1-hour and 1-day resolution. Any of them may be empty.
- A bar has:
  - `t`: start of its bucket, unix seconds, UTC. A multiple of 60, 3,600 or 86,400.
  - `o`, `h`, `l`, `c`: price in USD per token.
  - `volumeUsd`: USD traded in the bucket.
  - `trades`: number of swaps in the bucket.
  - `traders`: distinct wallets that traded in the bucket.
  - `liquidityUsd`: pool liquidity in USD, or null when unknown.
- Only buckets with at least one trade have a bar. A missing minute means nobody traded.

Bars may arrive unsorted. Sort each list by `t` before use. The result must not depend on the order of bars or of pools in the input, with one exception: when a list holds two bars with the same `t`, the later one in the input wins (section 3, rule 4). Pool addresses are unique within an input.

## 2. Parameters

| Name | Default | Meaning |
|---|---|---|
| `windowMinutes` | 3 | Length of the smoothing window |
| `minWindowVolumeUsd` | 1,000 | USD that must trade in a window for it to count |
| `minWindowTraders` | 5 | Distinct traders a window needs |
| `minSecondaryPoolLiquidityUsd` | 5,000 | Liquidity a non-primary pool needs for its bar to count |
| `minWindowLiquidityUsd` | 5,000 | Liquidity a window needs to be funded (section 4) |
| `carryForwardMaxSec` | 86,400 | Longest time a price is assumed to hold with no trades |
| `maxMarketCapUsd` | 20,000,000,000 | Anything above this is a data error |
| `thresholdsUsd` | 100k, 1M, 10M, 100M | Market caps that time-above is measured for |
| `rugDropPct` | 80 | Fall from ATH that counts as a rug |
| `rugWithinSec` | 1,800 | How soon after ATH the fall must happen |
| `rugRecoveryFraction` | 0.5 | A later recovery to this share of ATH cancels the rug |
| `nearAthFraction` | 0.5 | A bar counts as near the ATH when its close is at least this share of the ATH price (section 6) |
| `minAthNearVolumeShare` | 0.2 | The share of a market cap that the volume near it must reach for that market cap to count as backed. Below it at the ATH, the flag `ath_thinly_traded` is raised; it is also the share the backed high is found with (section 6) |

All comparisons against a parameter are inclusive: a window with exactly $1,000 of volume counts, and a market cap of exactly $100,000 is above the $100k threshold. They allow a relative tolerance of 1e-12, so a value that sits exactly on a limit in decimal terms is not lost to binary rounding.

`windowMinutes` must be 2 or more. `nearAthFraction` must be a finite number above 0 and at most 1. `minAthNearVolumeShare` must be a finite number of 0 or more. One parameter serves the flag and the backed high; there is no second share.

## 3. Step 1: clean the bars

Apply in this order, to every resolution. A bar dropped by one rule takes no part in the rules after it.

1. Ignore bars with `t` greater than `asOf`.
2. Drop a bar if any of `o`, `h`, `l`, `c` is not a finite number above zero, or `volumeUsd` is not a finite number of zero or more. Raise the flag `bad_bar`.
3. Drop a bar if the largest of `o`, `h`, `l`, `c` times `totalSupply` is above `maxMarketCapUsd`. Raise the flag `implausible_market_cap`. The whole bar goes, not only the bad field.
4. If a pool has two bars with the same `t` at the same resolution, keep the one that comes last in the input and raise the flag `duplicate_bar`.
5. Drop every bar of a non-primary pool whose `liquidityUsd` is null, not a finite number, or below `minSecondaryPoolLiquidityUsd`. No flag. Bars of primary pools are never dropped for liquidity.

In a bar that is kept, a `traders` or `trades` value that is not a finite number of zero or more counts as zero.

What is left are the clean bars.

## 4. Step 2: windows

**1-minute bars.** For each clean 1-minute bar at time `t` in a pool, its window is that pool's clean 1-minute bars in the `windowMinutes` minutes ending at `t`: the bars at `t - 60k` for `k` from 0 to `windowMinutes - 1`. With the default of 3 those are the bars at `t - 120`, `t - 60` and `t`, and between one and three of them are present.

- `price`: the lower median of the closes present. With three bars that is the middle close. With two bars it is the lower close. With one bar it is that bar's close. (For an even count, the lower median is the lower of the two middle values.)
- `volume`: the sum of `volumeUsd` over the bars present.
- `traders`: the highest `traders` value among the bars present. Per-minute counts of distinct wallets cannot be de-duplicated across minutes, so the highest single-minute count is the only number we can prove.
- `liquidity`: the largest `liquidityUsd` among the bars present that report one (a finite number of zero or more), or null when none does.
- `funded`: true when `liquidity` is null or at least `minWindowLiquidityUsd`. Only the window's own bars count, not the bar before it. Unknown liquidity counts as funded. The highest value is used, not the last bar's, because a pool dumped in the ATH minute reports its liquidity after the dump, and the price before the dump was real.
- `strict`: true when at least two bars are present, `volume` is at least `minWindowVolumeUsd`, `traders` is at least `minWindowTraders`, and the window is funded.

The effect with the default window: a price counts as reached only if at least two 1-minute closes in a 3-minute span were at or above it, with real volume and at least five wallets in one of those minutes. One candle cannot do it. Neither can two wallets trading back and forth.

**Hourly and daily bars.** Each clean bar is its own window: `price` is its close, `high` is `max(o, h, l, c)` of the bar (used only by the coverage flag in step 4), `volume` its `volumeUsd`, `traders` its `traders`. `liquidity` is the larger of the `liquidityUsd` of the bar and of the pool's previous clean bar at the same resolution (the previous one in that pool's cleaned list, whether or not "finer data wins" removes it as a window), counting only values that are reported (finite, zero or more), or null when neither reports one. The window is funded when `liquidity` is null or at least `minWindowLiquidityUsd`. The previous bar is there so that the hour in which a pool is drained still raises the coverage flag. `strict` is true when `volume` is at least `minWindowVolumeUsd`, `traders` is at least `minWindowTraders`, and the window is funded.

A window that is not funded is not strict. Everything downstream follows from `strict`: such a window cannot set the ATH or raise the level, can lower the level, does not count as a recovery, and does not raise the coverage flag.

**Finer data wins.** An hourly bar is not used as a window when any pool has a clean 1-minute bar inside that hour. A daily bar is not used as a window when any pool has a clean 1-minute or hourly bar inside that day, whether or not that hourly bar is itself used as a window. "Inside" means the finer bar's `t` is at or after the coarse bar's `t` and before the end of its bucket. Only clean bars count: a bar that was dropped suppresses nothing. 

## 5. Step 3: one point per timestamp

Group the windows from all pools by `t`. Where more than one pool has a window at the same `t`, keep the window with the largest `volume`. On a tie, a primary pool wins; on a further tie, the pool with the smallest address. Addresses are compared as plain strings by character code, which is case-sensitive, never by locale.

Each kept window is a **coin point**: `t`, `price`, `strict`, `liquidity`, pool, resolution.

Using the busiest pool, not the highest price, means a small side pool that drifts away from the real price cannot set any metric.

## 6. Step 4: ATH and wick

- **ATH price** is the highest `price` among strict coin points that come from 1-minute bars. Hourly and daily bars never set the ATH.
- `athAt` is the `t` of the earliest such point, which is the last minute of its window. `athPoolAddress` is that point's pool.
- `athMarketCapUsd` is ATH price times `totalSupply`.
- `secondsToAth` is `athAt` minus `launchedAt`. If it is negative, keep the number and raise the flag `ath_before_launch`.
- If there is no strict 1-minute coin point, all four are null and the flag `no_qualifying_window` is raised.

- **Wick.** A clean 1-minute bar of any pool is a wick candidate when all three hold: (a) taking the `liquidityUsd` the bar and the pool's previous clean 1-minute bar report (as in section 4), there is none, or the larger is at least `minWindowLiquidityUsd`; (b) its own `volumeUsd` is at least `minWindowVolumeUsd`; (c) its own `traders` is at least `minWindowTraders`. A candidate's value is `max(o, c)`. The wick is the largest value; the earliest bar if several share it, then the smallest pool address. If the ATH exists and its price is higher than that value, or there is no candidate, the wick is the ATH: same price, `athAt` and `athPoolAddress`. `athWickMarketCapUsd` is the wick price times `totalSupply`; `athWickAt` and `athWickPoolAddress` come with it. All three are null only when there is no candidate and no ATH. Hourly and daily bars and bar highs never feed the wick.

`athMarketCapUsd` can never exceed `athWickMarketCapUsd`.

- **`athLiquidityUsd`** is the `liquidity` of the coin point that set the ATH. Null when the ATH is null or that value is null.
- **`athHourVolumeUsd`** is the sum of `volumeUsd` over the clean 1-minute bars of every pool with `athAt - 3600 < t <= athAt`. Null when the ATH is null.

- **`athNearVolumeUsd`** is the sum of `volumeUsd` over the clean bars (section 3) of every pool that counts (section 1) whose close `c` is at or above `nearAthFraction` times the ATH price. Each stretch of time is counted once, at the finest resolution held, by the rule "finer data wins" in section 4: every clean 1-minute bar counts; a clean hourly or daily bar counts only when it is used as a window, that is, when "finer data wins" does not remove it. A bar is judged on its own close, never on the median price of its window. Bars before and after the ATH both count. The sum is taken over clean bars, before section 5 picks one window per timestamp, so the volume of every pool that counts is added, not the busiest pool's alone. Null when the ATH is null.
- **Flag `ath_thinly_traded`** is raised when the ATH is not null and `athNearVolumeUsd` is strictly below `minAthNearVolumeShare` times `athMarketCapUsd`. A volume equal to that product, within the tolerance of section 2, is not below it and does not raise the flag. The flag is not raised when the ATH is null.

**The backed high.** For a market cap `L`, let `V(L)` be the sum that `athNearVolumeUsd` is defined by, with the price `L / totalSupply` in place of the ATH price: the sum of `volumeUsd` over the same bars (the clean 1-minute bars of every pool that counts, and the hourly and daily bars that are used as windows, each stretch counted once), taken over the bars whose close is at least `nearAthFraction` times `L / totalSupply`. In particular `athNearVolumeUsd` is `V(athMarketCapUsd)`; the library computes both from one list of bars. `V` never rises as `L` rises.

- **`athBackedMarketCapUsd`** is the largest market cap `L`, no larger than `athMarketCapUsd`, with `V(L)` at or above `minAthNearVolumeShare` times `L`. Null when the ATH is null.

It is the highest market cap that enough trading stood behind: at `L`, the trading within a factor `nearAthFraction` of `L` amounts to at least `minAthNearVolumeShare` of `L`. It is found by a calculation, not a search, and a reader can work it by hand:

1. Take the bars `V` is made of. Give each bar its market cap (its close times `totalSupply`) and its `volumeUsd`.
2. Sort them by market cap, highest first. Bars with exactly the same close form one **group** and are always taken together, never split.
3. After each group `i`, let `cap_i` be the group's market cap and `V_i` the volume of every bar in groups `1` to `i` (the bars at or above `cap_i`).
4. The group's **candidate** is the smaller of `cap_i / nearAthFraction` and `V_i / minAthNearVolumeShare`.
5. If the ATH is not thinly traded (the flag is not raised), the backed high is the ATH, the very same number as `athMarketCapUsd`. Otherwise it is the largest candidate over all groups, and never more than `athMarketCapUsd`. With a share of 0 the flag is never raised, so the backed high is the ATH and nothing is divided by zero.

Why the largest candidate is the largest `L`. Between two neighbouring groups, for `L` with `cap_{i+1} / nearAthFraction < L <= cap_i / nearAthFraction`, the bars counted are exactly groups `1` to `i`, so `V(L) = V_i`, and the condition `V_i >= share * L` holds up to `L = V_i / share`. The largest `L` in that stretch is therefore the smaller of the two ends, which is the candidate. Each candidate satisfies the condition itself, because every bar of groups `1` to `i` is counted at it. And because `V` never rises and `share * L` rises, if `L` satisfies the condition so does every smaller market cap, so the largest candidate is the largest `L` that does, and capping it at the ATH keeps the largest `L` no larger than the ATH. A group made only of some of its equal bars would give a smaller `V_i` than the true one, so groups are never split.

The tolerance of section 2 is applied once, to the question whether the ATH itself is backed (the flag). Below the ATH the candidates are exact arithmetic on the stored numbers.

Worked example. `nearAthFraction` 0.5, share 0.2, ATH 100,000,000. Counted bars: $5,000,000 at a market cap of 100,000,000; $10,000,000 at 80,000,000; $20,000,000 at 30,000,000. Group 1: `V_1` = 5,000,000, candidate = smaller of 200,000,000 and 25,000,000 = 25,000,000. Group 2: `V_2` = 15,000,000, candidate = smaller of 160,000,000 and 75,000,000 = 75,000,000. Group 3: `V_3` = 35,000,000, candidate = smaller of 60,000,000 and 175,000,000 = 60,000,000. At the ATH the near volume is the bars at or above 50,000,000: 15,000,000, below 20,000,000, so the flag is raised, and the backed high is the largest candidate, 75,000,000. Check: at 75,000,000 the bars at or above 37,500,000 hold 15,000,000, which is exactly 0.2 times 75,000,000; just above that the volume is the same and the line is higher.

**The flag and the backed high are one test.** `ath_thinly_traded` is raised exactly when `athBackedMarketCapUsd` is below `athMarketCapUsd`. The library decides the flag once, with the comparison above and the tolerance of section 2, and the backed high follows it: when the flag is not raised the backed high is the ATH itself; when it is raised the backed high is strictly below the ATH, because every group counted at the ATH has a `V_i` no larger than the near volume, which is below the line, so its candidate is below the ATH, and every group not counted at the ATH has a `cap_i / nearAthFraction` below the ATH.

These four say how much stood behind a peak. No rule reads them: the ATH, the wick, time above, drawdown, the rug pattern and which coins are listed are the same with or without them. What the site does with a flagged coin, or shows as the backed high, is not decided here.

**Coverage flag.** If a strict coin point from an hourly or daily bar has a high (`max(o, h, l, c)` of its bar) above the ATH price, or the ATH is null while such a point exists, raise `peak_outside_minute_coverage`. A period can hold a higher ATH only if it traded above the current one, and its close says nothing about that: a coin can spike and collapse inside one hour. The flag means the real peak may sit in a period we hold no 1-minute bars for, and the fetcher must fetch them and recompute.

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
| `athLiquidityUsd`, `athHourVolumeUsd`, `athNearVolumeUsd`, `athBackedMarketCapUsd` | number or null |
| `secondsAbove` | one number of seconds for each threshold |
| `maxDrawdownPct` | number from 0 to 100, or null |
| `rugPattern` | boolean |
| `flags` | list of flag names, each at most once, sorted alphabetically |

Flags: `ath_before_launch`, `ath_thinly_traded`, `bad_bar`, `duplicate_bar`, `implausible_market_cap`, `no_candles` (set by the metrics stage for a coin with no bar in any pool that counts, section 1: a coin whose only bars sit on left-out side pools gets it too; every metric is then null), `no_qualifying_window`, `peak_outside_minute_coverage`, `screened_out` (set by the fetcher, not by the metric library).

The exact TypeScript shapes are in `/ingest/src/metrics/types.ts`.

## 12. What the fetcher must provide

These are requirements on ingestion (task A5), listed here because the rules above depend on them. They were tightened on 2026-11-15, after the first live run cost 60 compute units a coin.

- **Screen.** Daily bars of the graduation pool for its whole life come first. If the highest daily high is under $90,000 as a market cap, the coin cannot have an ATH of $100,000, because an ATH never exceeds a candle high. Nothing else is fetched. The coin is stored with no ATH, no wick and the flag `screened_out`; the daily bars stay stored. A coin whose Dune hourly peak is more than 1.5 times that high is not screened on one pool: its other pools are fetched first.
- **1-minute bars** for the first 1,500 minutes of the graduation pool, starting five minutes before it began trading.
- **Hourly bars** for every day whose daily high is $80,000 or more as a market cap and that 1-minute bars do not already cover. A day below that line cannot add time above any threshold, so daily bars are enough for it.
- **1-minute bars for any later period that could hold the peak.** When `peak_outside_minute_coverage` is raised, fetch 1,500 minutes around the highest such bar and recompute, until the flag clears or only bars under $90,000 are left. Those cannot make a coin listed, so they are not fetched and the flag stays. A coin whose candles were fetched under an older candle rules version and whose metrics run raises the flag for a period of $90,000 or more (an earlier version could report an ATH that a later one lowers) has its candles and metrics stages put back to pending once, unless its hourly cap was hit. The candle rules version (`CANDLE_RULES_VERSION`, currently 5) is the last rules version that changed which bars count or how a peak is found, so a coin whose candles were fetched under an older one may need bars that fetch did not ask for. A version that only adds an output, such as rules version 6, does not raise it, and so reopens nothing. The refetch records the current metrics version in the candles detail, which is at or above the candle rules version, so it never repeats for the same candle rules version.
- **Other pools** only for a coin whose highest daily high is $1,000,000 or more, or whose Dune peak is far above what its graduation pool shows. They are chosen by the liquidity rule in section 2.
- **The bonding curve** only when the graduation pool opened at $90,000 or more. The pool opens at the curve's final price, so only then can the curve itself have passed $100,000. Then its last 1,500 minutes are fetched at 1-minute resolution.

What these rules cost in accuracy: time above a threshold is measured to the minute for the first day and to the hour on later days at or above $80,000. A coin under $1,000,000 is measured on its graduation pool alone. Minutes a coin spent above $100,000 on the bonding curve are counted only in the case above. A6 measures the difference against an exhaustive fetch.

## 13. Known limits

- A coin that spikes for exactly one minute on real volume gets an ATH below that minute's close. That is the price of rejecting single-candle wicks. The traded minute is kept as the wick, and A6 reviews the coins where the two differ most. About 2% of sampled coins have a peak that lasted one minute and so is not their ATH.
- A coin traded by fewer than five wallets a minute gets no ATH (about 1% of sampled coins).
- A sustained data error that stays under $20 billion and lasts two minutes with volume would pass. A6 reviews every coin whose wick is far above its ATH and every coin whose ATH is far from the cross-check source.
- Requiring five wallets in a single minute is stricter than five across the window. Very slow, genuine markets can fail it. A6 measures how often.
- A single point that is not strict can lower the level. On the busiest pool that is normally a true state of the pool. But a lone print from a side pool in a minute when the main pool is silent, or one bad low bar, lowers the level too. That can cut time-above short, inflate the drawdown and set the rug pattern, and the level only comes back at the next strict point. A6 counts how often one point that is not strict moves the level by more than half. The candidate fix is to let the level drop to a price only after two consecutive points at or below it.
- Hourly and daily closes are stamped at the start of their bucket, so a level taken from one starts up to a bucket early.
- A busier window that is not strict hides a strict one in the same minute. One large trade on a side pool can outweigh the main pool's three-minute volume, and that minute then yields a point that cannot raise the level or set the ATH. The error is on the cautious side: it can understate, never overstate. Preferring strict windows was considered and rejected, because it would let a marginal side pool set the price whenever the main pool traded heavily among a few wallets. A6 counts how often this happens at the peak.
- The first two or three windows of a coin are noisy, because one early bad bar sits in every one of them.
- A coin under the listing line can keep `peak_outside_minute_coverage` for good: the fetcher does not fetch periods whose high is under $90,000, so the flag stays on it.
- `athNearVolumeUsd`, and so the backed high, count the trades of the wallet that moved the price like anyone else's. For a manufactured coin the backed high is still an upper bound, of the order of the money that wallet put through the pool.
- Where only hourly or daily bars are held, a bar's whole volume is counted or not on its close alone, however the price moved inside it; for the backed high such a bar is placed at its close alone.
- A coin with large trading on an exchange we do not read is understated by `athNearVolumeUsd`, and can raise `ath_thinly_traded` without being thinly traded.
- A side pool counts on its quote token as stored. `pools.quote_token` holds the symbol when Codex.io gave one, else the address. Rows stored before the fetcher matched by address can therefore pass on the symbol alone: a token that merely calls itself `USDC` would be counted on such a row. New fetches match by mint address and never store such a pool, so the gap closes as coins are refetched. It is not worth a second source of truth now.

## 14. Status and `last_alive_at`

The coin's `status` is not part of the metric library's output. It is decided by one function (`statusFromEvidence`, next to `decideStatus` in `/db`) from three stored facts and the time it is asked at, and the two writers of a coin's status, the metrics computation and the daily refresh, both call it.

Inputs: the stored rug pattern, `coins.last_alive_at`, and whether the coin has 7 days of history.

- **rugged** when the rug pattern is stored as true. Nothing a later refresh reads changes this.
- **alive** when `last_alive_at` is set and is less than 7 days before the time asked at.
- **dead** when not alive and the coin has 7 days of history.
- **unknown** otherwise: no evidence at all, or under 7 days of history and never alive.

`status_changed_at` moves only when the status changes.

**Where `last_alive_at` comes from.** It is the time the alive line was last met. The alive line is the one the status has always used: at least $1,000 of volume in the 24 hours before and at least $5,000 of liquidity.

1. *The metrics computation, from the stored bars.* The line is evaluated at the end of each of the last 7 days before `asOf` (`asOf`, `asOf` minus one day, up to `asOf` minus six days), with the same volume and liquidity rules as before (primary pools count fully; another pool counts only on bars that pass the $5,000 liquidity rule; volume per pool from one resolution at a time). `last_alive_at` is the latest of those day-ends at which the line was met, or null when it was met at none. The metrics computation stores the later of this and the value already stored, then decides the status with the stored rug pattern, that value and the coin's history: for a coin whose `last_alive_at` came from bars alone, this is exactly the status the rule gave before this column existed.
2. *The daily refresh, from Jupiter.* When Jupiter's liquidity is at least $5,000 and its 24-hour volume at least $1,000 at the time of the refresh, `last_alive_at` is set to the refresh time. A mint Jupiter does not know, or answers without those figures, does not meet the line.

`last_alive_at` never moves backwards: the refresh sets it only forwards, and a metrics recompute keeps the later of the stored value and the one from the bars.

**History.** "7 days of history" is at least 7 days between the coin's first stored bar and `asOf` in the metrics computation. In the refresh, which holds no bars in memory, it is at least 7 days between the coin's graduation (its launch time when there is none, its ATH time when there is neither) and the refresh time.
