<!-- Generated from the throwaway database after the run (candles and metrics stages, as on claude/37-candle-stages). Issue #40. -->
# A6b: graduates under the $30k floor and graduates with no hourly price

Sample: `ingest/sql/dune/results/below-floor-2026-11-15.csv`, drawn by `ingest/sql/dune/below-floor-sample.sql`: 150 coins, 120 with a Dune hourly peak (99.9th percentile) under $30,000 and 30 with no hourly price. Per-coin results: `ingest/reports/a6-below-floor-2026-11-15.csv` (columns: mint, cell, half-year, path, units, ATH, wick, minutes from launch to ATH, flags, Dune hours, Dune peak, stage status, listed). "Listed" means an ATH market cap of $100,000 or more from the metric library (`ath_market_cap_usd`). "Wick" is the highest bar high before the library's rules and is not an ATH.

## 1. Result in one paragraph

2 of the 150 sampled coins reach a $100k ATH: one of 36 in the $20k to $30k cell and one of 30 with no hourly price. None of the 84 coins under $20k does. Weighted by cell size, that is 0.81% of the 131,087 below-floor graduates, about 1,060 coins, with a 90% interval of 0.08% to 7.8% (about 100 to 10,300 coins). The interval is wide because there are two events and the weights are very unequal: the whole $20k to $30k estimate (996 coins) comes from a single coin in a stratum of 5,975. A measured 10.3 compute units per coin puts the cost of fetching everything under the floor at about 1.35 million units, which is 1,273 units per extra listed coin (range 131 to 13,197), against about 29 above the floor. The cheapest option, a $20k floor, costs 485 units per extra listed coin (range 94 to 2,749): 17 times the above-floor price at the point estimate and 3 times at the best end of the range.

## 2. Run

| item | value |
| --- | --- |
| coins in the file | 150 (150 valid, 0 rejected, 0 repeated) |
| `discovered` | 150 done |
| `candles` | 150 of 150 done (100.0%) |
| `metrics` | 147 of 150 done (98.0%), 3 failed with `no_candles` |
| Codex.io compute units | 1,605 (401 requests), against a ceiling of 3,000 |
| paths | 125 screened out (mean 9.0 units, 8.0 to 12.0), 24 light (mean 19.0, 16.0 to 28.0), 1 full (24.0) |
| Dune credits | 4.6 for the query that wrote the file; 9.6 in all with the discarded first run (section 6) |
| second run | 0 provider requests, nothing seeded; it re-tried the 3 failed metrics (no cost, left failed) |

The dry run printed "about 12,000 compute units for 150 coins": the estimate has no figure for these cells and counts every coin at the unknown-cell rate of 80 units. The measured total is 13.4% of that.

The 3 coins whose metrics failed are no-price coins of 2026-H2 (launched 2026-10-09, 2026-10-13 and 2026-11-11). Each was screened out at stage 0 with a window figure (`w`) of 0 and 8.0 units, so no bars were stored and the metrics stage had nothing to read. Candles are done for all 150.

## 3. By cell and half-year

Coins in cell is `cell_size` from the query. Units per coin is the mean over the sampled coins of the cell and half-year.

| cell | half-year | coins in cell | sampled | ATH >= $100k | units per coin (mean) | path (screened out / light / full) |
| --- | --- | --- | --- | --- | --- | --- |
| 0-10k | 2024-H1 | 18 | 7 | 0 | 12.6 | 6 / 1 / 0 |
| 0-10k | 2024-H2 | 18 | 7 | 0 | 10.9 | 6 / 1 / 0 |
| 0-10k | 2025-H1 | 81 | 7 | 0 | 8.0 | 7 / 0 / 0 |
| 0-10k | 2025-H2 | 126 | 7 | 0 | 10.3 | 6 / 1 / 0 |
| 0-10k | 2026-H1 | 8,683 | 7 | 0 | 10.3 | 7 / 0 / 0 |
| 0-10k | 2026-H2 | 47,230 | 7 | 0 | 9.2 | 7 / 0 / 0 |
| 10k-20k | 2024-H1 | 1,509 | 7 | 0 | 11.4 | 7 / 0 / 0 |
| 10k-20k | 2024-H2 | 1,773 | 7 | 0 | 16.0 | 4 / 2 / 1 |
| 10k-20k | 2025-H1 | 4,343 | 7 | 0 | 9.2 | 7 / 0 / 0 |
| 10k-20k | 2025-H2 | 845 | 7 | 0 | 12.6 | 4 / 3 / 0 |
| 10k-20k | 2026-H1 | 11,144 | 7 | 0 | 9.1 | 6 / 1 / 0 |
| 10k-20k | 2026-H2 | 13,778 | 7 | 0 | 9.1 | 6 / 1 / 0 |
| 20k-30k | 2024-H1 | 2,130 | 6 | 0 | 12.7 | 5 / 1 / 0 |
| 20k-30k | 2024-H2 | 5,975 | 6 | 1 | 20.0 | 2 / 4 / 0 |
| 20k-30k | 2025-H1 | 10,440 | 6 | 0 | 14.0 | 2 / 4 / 0 |
| 20k-30k | 2025-H2 | 2,432 | 6 | 0 | 10.7 | 4 / 2 / 0 |
| 20k-30k | 2026-H1 | 7,337 | 6 | 0 | 8.0 | 6 / 0 / 0 |
| 20k-30k | 2026-H2 | 11,349 | 6 | 0 | 9.3 | 5 / 1 / 0 |
| no-price | 2026-H2 | 1,876 | 30 | 1 | 8.5 | 28 / 2 / 0 |

Per cell, weighted by `cell_size` (each coin stands for the cell size divided by the number sampled in its cell and half-year):

| cell | coins in cell | sampled | listed | weighted share | 90% interval (weighted Wilson) | listed coins expected | units per coin | share, bootstrap 90% |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0-10k | 56,156 | 42 | 0 | 0.00% | 0.00% to 22.0% | 0 (0 to 12,375) | 9.3 | 0.00% to 0.00% |
| 10k-20k | 33,392 | 42 | 0 | 0.00% | 0.00% to 10.5% | 0 (0 to 3,512) | 9.7 | 0.00% to 0.00% |
| 20k-30k | 39,663 | 36 | 1 | 2.51% | 0.44% to 13.0% | 996 (176 to 5,141) | 12.2 | 0.00% to 7.53% |
| no-price (2026-H2 only) | 1,876 | 30 | 1 | 3.33% | 0.75% to 13.6% | 63 (14 to 256) | 8.5 | 0.00% to 10.00% |
| all priced (0-30k) | 129,211 | 120 | 1 | 0.77% | 0.07% to 7.9% | 996 (90 to 10,264) | 10.3 | 0.00% to 2.31% |
| all below the floor | 131,087 | 150 | 2 | 0.81% | 0.08% to 7.8% | 1,058 (102 to 10,269) | 10.3 | 0.00% to 2.28% |

Method for the interval. The point estimate is the stratified one: each cell and half-year contributes its `cell_size` times its sampled listed share. The interval is a Wilson interval at 90% on the weighted share, with the effective sample size (the sum of the weights squared over the sum of squared weights: 39.6 coins for the whole sample, 28 for the $20k to $30k cell) in place of the raw count. A stratified bootstrap (20,000 resamples of the coins within each cell and half-year) is in the last column. It cannot see strata where nothing was found, so its lower end is 0 and its upper end is too low; use the Wilson interval. A per-stratum Jeffreys prior was tried and dropped: with 6 or 7 coins in each of 19 strata it adds about half a coin to every stratum and puts the estimate at 3% to 14%, which the data do not support.

Unweighted, the raw count is 2 of 150 (Wilson 90%: 0.4% to 3.9%). The unweighted rate (1.3%) is higher than the weighted one (0.81%) because the no-price cell is 1.4% of the population and 20% of the sample.

## 4. The three floor options

The backfill today takes graduates with a Dune hourly peak of $30k or more. Each row adds to it the coins between the new floor and $30k (and, for no floor, the 1,876 with no hourly price). Units are the measured mean per coin of each cell and half-year times its size: 12.2 per coin for $20k to $30k, 9.7 for $10k to $20k, 9.3 for $0 to $10k, 8.5 for no price. The "range" column divides the added units by the upper and lower end of the 90% interval on listed coins.

| floor | coins added to the backfill | compute units added | listed coins expected | 90% interval on listed coins | units per extra listed coin | range of that figure |
| --- | --- | --- | --- | --- | --- | --- |
| $20k (adds $20k to $30k) | 39,663 | 483,455 | 996 | 176 to 5,141 | 485 | 94 to 2,749 |
| $10k (adds $10k to $30k) | 73,055 | 807,444 | 996 | 174 to 5,400 | 811 | 150 to 4,630 |
| none (adds everything, with the no-price coins) | 131,087 | 1,347,385 | 1,058 | 102 to 10,269 | 1,273 | 131 to 13,197 |

For comparison, the backfill above the floor costs about 29 units per listed coin (4.2 million units for about 144,000 listed). Below the floor the cheapest option, a $20k floor, is 485 units per extra listed coin at the point estimate. Two things cut the other way. First, the measured units per coin here (10.3) are well under the 16 to 20 the plan used for the lowest cells above the floor, because 83% of these coins are screened out at 8 to 12 units. Second, the point estimate rests on one coin; if the true share in the $20k to $30k cell is the lower end of its interval (0.44%), the price is about 2,700 units per extra listed coin.

## 5. The listed coins

| | `7nioHAw6z3rUTpGWt276Pov5Tepn6brrK5JdwH6Kpump` | `DifgEZC24HbYZwDq2og89hUJTjFixsyYZtV7Hrzepump` |
| --- | --- | --- |
| cell, half-year | 20k-30k, 2024-H2 | no-price, 2026-H2 |
| ATH | $121,250 (wick $151,586) | $110,471 (wick $112,086) |
| ATH time after launch | 3.3 minutes (180 s after graduation) | 1,935 minutes, 32.3 hours (3.0 hours after graduation) |
| ATH minute: trades, traders, volume | 92, 83, $13,962 | 6, 6, $175 |
| trades in the three minutes round the ATH minute | 301 | 29 (five minutes) |
| ATH hour: trades, traders, volume | 388, 232, $53,156 | 157, 79, $9,701 |
| hours of Dune price, Dune peak | 41 hours, $23,435 | 0 hours, none |
| path, units | light, 20.0 | light, 16.0 |
| status after | rugged | dead |

**7nio... (20k-30k, 2024-H2): a real spike, too short for an hourly figure.** The coin graduated 16 seconds after launch. Its one-minute bar highs were $78k, $130k, $152k and $135k in four consecutive minutes, with 30 to 112 trades and 30 to 99 traders a minute and $4k to $18k of volume a minute. Two minutes later the bar high was $5,019, and it stayed under $6k. The Dune hourly peak is $23,435 against our $151,586 high in the same hour: the spike lasts about four minutes inside one hour, which is the case the README (section 4) says an hourly price understates. Reason: short spike. The peak is not a single print (many traders and trades in each of the minutes), but pool liquidity in that hour was $3.3k, so $121k is a headline figure rather than a value a holder could have realised.

**Difg... (no-price, 2026-H2): a high held for hours on thin trading, with no hourly price at all.** The coin was created on 2026-09-19 and graduated 29 hours later, on 2026-09-21. Its pool has no quote token or exchange recorded in our data (`quote_token` null, exchange `unknown`) and a peak liquidity of $19,211. The hourly bars show a high of $109k, $103k, $62k, $112k and $103k in the first five hours of the pool, with about 100 to 500 trades an hour, 59 to 256 traders an hour and $4k to $28k of volume an hour, then a decline to about $7k within 35 hours. The one-minute bars around the ATH are quiet (1 to 11 trades a minute, $6 to $815 of volume), so the peak is a level the price held, not a one-print wick. Reason: other. Dune has no hourly price for this coin and we did not establish why; a pool not paired with SOL is the likely cause (the Dune README notes that after 2026-05-21 coins are paired with USDC and with other coins). We did not check the quote token, and because our pool record has none, the dollar conversion behind the $110k is the part of this figure we cannot vouch for. It does not look like a bad print that our rules let through (the high recurs across several hours of real trading), but it is the weaker of the two.

Neither listed coin is a single-trade print of the kind the metric rules reject. The rules also did their job on other coins: 12 coins have a wick of $100k or more and were not listed (one of them is the near miss below), among them `GxEtaiM7h4NxrwjEr26xBvUj54QWCmrQSqpv4yApump` (wick $3.8 million, ATH $30,914) and `HTy3SSo6cnz1ZrHKR1PX7rpVCp1EqGGK2J6qEifvpump` (wick $824,069, ATH $47,684).

One near miss: `7daesFB2skTZAEM9GmjeP9Nc3omsc7aWZdNWPrdupump` (20k-30k, 2025-H1) has an ATH of $99,030 and a wick of $143,283, with 163 to 189 trades and 71 to 86 traders a minute around it, so it is $970 short of the line. Ten more coins have an ATH between $50k and $100k (nine priced, one with no price). The listing line catches only the top of a larger set of coins that spike to tens of thousands of dollars for minutes and do not hold it.

## 6. Spend, and what did not go to plan

- Dune: 4.6 credits for the query that wrote the file. The first run used a quota of 5 no-price coins per half-year, as the brief says. It returned 125 rows, because graduates without an hourly price exist only for coins launched in 2026-H2 (1,876 of them; none in the earlier half-years). It cost 5.1 credits and was discarded; the quota was raised to 30 for that cell and the query was run again. In all 9.6 credits, under the cap of 25. No result download was requested without being saved.
- The sample therefore holds 30 no-price coins from 2026-H2 only, not 5 in each half-year. The no-price estimate applies to coins launched from July to November 2026 and says nothing about older coins (there are none).
- The `0-10k` cells of 2024-H1 and 2024-H2 hold 18 coins each, and at least two of the coins sampled there launched in 2024 and graduated in July 2026 (their graduation is years after their creation). The estimate counts them, as the query's definition does.
- Codex.io: 1,605 compute units of 3,000, 401 requests, no retries.
- The below-floor population is 129,211 priced graduates plus 1,876 with no price: 131,087 (the issue gave about 131,000 and 1,846; the second has grown since).
- Not done: the metadata stage (not asked for), and any check of why Dune has no price for the listed no-price coin.
