# Dune queries: discovering pump.fun graduates

These queries were run on Dune on 2026-11-15, and the figures below are what that run measured. Every table and column named here was confirmed live on that date. The results of the sizing query, of the sample queries and, for issue #44 (section 8, run on 2026-11-16), of the three never-graduated queries are in `results/`. They hold public chain data only.

The design changed after the first draft of this pull request. The first draft scanned `dex_solana.trades` for 1-minute buckets. That did not finish in a useful time (section 6). The queries now take the peak from Dune's hourly price table, `dex_solana.price_hour`, and use pump.fun's decoded event tables for creation and graduation.

## 1. The queries

Plan: Dune Analyst, medium tier (the small tier is refused on this plan). None of the queries has parameters.

| File | Returns | Result | Execution credits | Run time |
|---|---|---|---|---|
| `discovery.sql` | One row per pump.fun coin that graduated: `mint`, `created_at`, `creator`, `graduated_at`, `hours` (hours with a price), `peak_max_usd`, `peak_p999_usd`, `peak_at`, `last_hour`. Times are epoch seconds (UTC). The peak is a market cap in USD: hourly price times 1,000,000,000. An optional filter goes on a last line: `WHERE peak_max_usd >= <floor>`. | 347,564 rows, 49.9 MB | 3.2 | 65 s |
| `sizing.sql` | One row per launch month (35 rows): graduates, graduates with no hourly price, graduates reaching $30k, $50k, $80k, $100k, $125k, $250k, $1M, $10M and $100M by the 99.9th percentile of the hourly price (`p30k` to `p100m`), the same at $30k and $100k by the plain maximum (`max30k`, `max100k`), and for coins at $100k or more the median, p90, p99 and maximum of hours with a price (`hours_p50` to `hours_max`), plus the sum of hours for coins at $30k or more (`hours_sum_30k`). | 35 rows | 7.2 | 38 s |
| `sample.sql` | The Phase A sample: the 20 probe coins from `probes/coins.json`, plus a draw by quota from each launch half-year and peak cell, ordered by the SHA-256 of the mint (no random function). Quotas per half-year: 5 for $30k to $50k, 10 for $50k to $100k, 30 for $100k to $1M, 20 for $1M to $10M, 15 for $10M and above. Cells are cut on the 99.9th percentile peak. Columns: `mint`, `half_year`, `cell`, `probe`, `cell_size`, `created_at`, `creator`, `graduated_at`, `hours`, `peak_max_usd`, `peak_p999_usd`, `peak_at`. | 500 rows | 7.4 | 101 s |
| `below-floor-sample.sql` | The below-floor sample (issue #40): graduates with an hourly peak (99.9th percentile) under $30,000 in cells `0-10k`, `10k-20k` and `20k-30k` by six launch half-years (7, 7 and 6 coins per half-year, 120 in all), plus coins with no hourly price (cell `no-price`, 30 in all, all of them launched in 2026-H2: see the note after this table). Same source tables, peak and fixed order as `sample.sql`; the columns are the sample's. `cell_size` is the number of coins in that cell and half-year. Result: `results/below-floor-2026-11-15.csv`, 150 rows (times converted to ISO text outside the query, as for the sample). | 150 rows, 36 KB | 4.6 (the run that wrote the file, download included). A first run with a quota of 5 `no-price` coins per half-year cost 5.1 and was discarded, see below | under 100 s each (not timed closely) |
| `curve-only-sizing.sql` | Issue #44, run on 2026-11-16. One row per launch month (35 rows) for coins with a creation record and no graduation by the same rule: `never_graduated`, `with_price`, `max100k` and `p100k` (plain maximum and 99.9th percentile of the hourly price at $100,000 or more; `p100k` is computed by the nearest-rank identity from hour counts, not with `approx_percentile`), `max_100k_to_125k`, `max_above_125k`, `max_1m_plus`, `max100k_one_hour`, `max100k_two_plus_hours`, and, leaving out a plain maximum of $1,000,000 or more, `max_30k_to_1m`, `max_50k_to_1m`, `max_80k_to_1m`, `max_100k_to_1m`, `two_hours_50k_to_1m`, `two_hours_100k_to_1m`. Result: `results/curve-only-sizing-2026-11-16.csv`. | 35 rows | 5.76 (the first version, without the last six columns, cost 5.54) | about 1 minute |
| `curve-only-sample.sql` | Issue #44. A sample by quota (5 coins a cell, the method of `sample.sql`) of never-graduated coins with a plain maximum of $100,000 or more, by launch half-year, size (`band` under $125,000, `mid` under $1,000,000, `high`) and hours at or above $100,000 (`one`, `two_plus`), with the hourly low, the number of coins sharing the peak hour, the creation event's `quote_mint`, `is_mayhem_mode` and `token_program`, and whether the mint has an AMM pool or a migration record. Result: `results/curve-only-sample-2026-11-16.csv`. | 168 rows | 5.27 | about 1 minute |
| `missed-graduations.sql` | Issue #44. One row per launch month (35 rows): never-graduated coins and how many have an AMM pool, a migration record, or either; graduates by our rule and how many have either. No price table. Result: `results/missed-graduations-2026-11-16.csv`. | 35 rows | 1.63 | about 1 minute |
| `curve-only-candidates.sql` | Issue #102. The curve-only candidate list: one row per coin with a creation record and no graduation record whose plain maximum of the hourly price is under $1,000,000 and, launched from 2025-11-01, at $50,000 or more, or, launched before, at $80,000 or more. Columns of `discovery.sql` plus `is_mayhem_mode`; `graduated_at` is empty (`<nil>`) on every row. Run on 2026-11-16 and downloaded with `dune-discovery.ts --list curve-only`. | 10,391 rows (8,441 launched from 2025-11-01, 1,950 before) | 8.31 | not recorded, under 8 minutes |
| `mayhem-graduates.sql` | Issue #102. Two columns, `mint` and `is_mayhem_mode`: graduates whose creation event carries the flag, to load onto graduates already in the database with `scripts/mayhem-load.ts`. Not run. | not known | not known | not known |
| `schema_probe.sql` | Metadata and coverage statements, each run on its own. | small | about 0.02 to 0.03 for each metadata statement | seconds |

**The curve-only list, measured on 2026-11-16 (issue #102).** `curve-only-candidates.sql` returned 10,391 rows. The execution cost 8.31 credits and the download 15.0, 23.31 credits in all. Its run time was not recorded; it was under 8 minutes. Seed it with `backfill.ts seed --list curve-only --file FILE` (dry run first, without `--confirm`); the list is never guessed from the file. `dune-discovery.ts --list curve-only` downloads it into `data/dune-curve-only` by default and prints counts by launch month and mayhem flag instead of a sample.

**Below-floor sample, measured on 2026-11-15.** The first run of `below-floor-sample.sql` drew 5 `no-price` coins per half-year and returned only 5 of them (125 rows): graduates without an hourly price exist only for coins launched in 2026-H2 (1,876 of them; `sizing-2026-11-15.csv` shows none before 2026-07 and all but 3 in September to November). The quota was raised to 30 for the cell so that the sample holds 30 such coins, and the query was run again (150 rows). Some of the `0-10k` coins of the early half-years launched in 2024 but graduated in 2026: their `graduated_at` is years after `created_at`. Cells `0-10k` of 2024-H1 and 2024-H2 hold 18 coins each, so 7 of 18 are sampled there.

The sample CSV in `results/` holds its times as ISO text, not as the epoch seconds the query text returns. The conversion happened outside the query.

**Downloads are billed separately and are the expensive part.** A 7,000-row CSV page cost 10.0 credits and a 32,000-row page cost 49.1 credits. Dune's page cap is 32,000 rows. Downloading the full discovery list would cost about 530 credits. A download is billed when it is requested, even if the body is never read. A cancelled execution is billed for the work done (5.8 to 17.5 credits for runs cancelled after 150 to 240 seconds).

So the sizing table and the sample are computed in Dune, and the full discovery list is downloaded once, when the backfill starts, with a floor on the peak.

## 2. Tables and columns used

All of these were confirmed live on 2026-11-15. The column lists come from `SELECT * ... LIMIT 0` (statements 2 to 6 of `schema_probe.sql`). `SHOW COLUMNS` and `information_schema.columns` return nothing for the decoded tables; `information_schema.tables` works.

| Table | Columns used | Notes |
|---|---|---|
| `pumpdotfun_solana.pump_evt_completeevent` | `evt_block_time`, `evt_block_date`, `mint`, `bonding_curve`, `user`, `quote_mint`, `timestamp` | One row per graduation. Starts April 2024 (336 events that month). |
| `pumpdotfun_solana.pump_call_withdraw` | `call_block_time`, `call_block_date`, `account_mint`, `account_user` | January 2024 to March 2025. `account_mint` is decoded correctly only up to May 2024; from June 2024 every row carries the same value. The query therefore uses it only before 2024-06-01. |
| `pumpdotfun_solana.pump_evt_createevent` | `evt_block_time`, `evt_block_date`, `mint`, `creator`, `user`, `name`, `symbol`, `uri`, `bonding_curve`, `token_program`, `quote_mint`, `is_mayhem_mode`, `is_cashback_enabled`, `token_total_supply` | 24.8 million rows. Starts April 2024 (34,566 that month), complete from May 2024. |
| `pumpdotfun_solana.pump_call_create` | `call_block_time`, `call_block_date`, `account_mint`, `account_user`, `name`, `symbol`, `uri`, `creator` | Covers January to April 2024. Matches the event table exactly from May 2024 to October 2025 and is incomplete from November 2025. The query uses it only before 2024-05-01. |
| `dex_solana.price_hour` | `contract_address`, `hour`, `price`, `block_month`, `symbol`, `decimals`, `blockchain` | Price is USD per whole coin. It covers bonding-curve hours as well as later pools. It holds infinite and absurd prices, hence the three price filters in the queries: `is_finite(price)`, `price > 0`, `price < 1000`. `block_month` is the partition column. |

Present and not used: `pump_evt_completepumpammmigrationevent` (`mint`, `pool`, `evt_block_time`; starts November 2025), `pump_call_migrate` (`account_mint`, `account_pool`; starts November 2025), `pump_call_migrate_v2` (from May 2026), `pump_call_create_v2` (from April 2026), `pump_evt_tradeevent`, `pump_amm_evt_createpoolevent` (`base_mint`, `pool`, `creator`, `coin_creator`), and the schema's own `trades` and `base_trades`. The schema has 116 tables.

How the queries combine them:

- Graduation time is the first CompleteEvent; before June 2024 the withdraw call stands in for it.
- Creation time and creator come from the CreateEvent; the create call stands in for January to April 2024. `creator` is the event's `creator`, falling back to `user`.
- The peak comes from `dex_solana.price_hour`, joined to the graduates with a RIGHT JOIN so that graduates without a price are kept (`hours` is 0).
- Each source table is read once.

## 3. Coverage

Events and calls per month, from `schema_probe.sql` statements 7 to 9. A dash means no rows.

| Month | Graduation events | Withdraw calls | Create events | Create calls |
|---|---|---|---|---|
| 2024-01 | - | 2 | - | 172 |
| 2024-02 | - | 17 | - | 1,279 |
| 2024-03 | - | 703 | - | 74,691 |
| 2024-04 | 336 | 2,453 | 34,566 | 286,327 |
| 2024-05 | 6,703 | 7,069 | 436,918 | 436,918 |
| 2024-06 | 6,495 | 6,583 | 386,354 | 386,354 |
| 2024-07 | 6,033 | 6,066 | 393,622 | 393,622 |
| 2024-08 | 4,436 | 4,452 | 344,068 | 344,068 |
| 2024-09 | 3,254 | 3,262 | 248,400 | 248,400 |
| 2024-10 | 10,630 | 10,654 | 704,301 | 704,301 |
| 2024-11 | 17,261 | 17,723 | 1,248,131 | 1,248,131 |
| 2024-12 | 14,023 | 14,120 | 1,207,901 | 1,207,901 |
| 2025-01 | 24,008 | 24,342 | 1,727,508 | 1,727,508 |
| 2025-02 | 11,903 | 11,918 | 1,140,175 | 1,140,175 |
| 2025-03 | 6,808 | 4,250 | 823,401 | 823,401 |
| 2025-04 | 9,059 | - | 1,001,077 | 1,001,077 |
| 2025-05 | 8,447 | - | 897,553 | 897,553 |
| 2025-06 | 6,761 | - | 771,771 | 771,771 |
| 2025-07 | 2,801 | - | 346,532 | 346,532 |
| 2025-08 | 4,759 | - | 599,659 | 599,659 |
| 2025-09 | 4,373 | - | 675,397 | 675,397 |
| 2025-10 | 2,920 | - | 449,230 | 449,230 |
| 2025-11 | 3,568 | - | 511,170 | 248,412 |
| 2025-12 | 4,337 | - | 620,682 | 41,744 |
| 2026-01 | 6,473 | - | 878,191 | 31,550 |
| 2026-02 | 8,369 | - | 857,239 | 28,803 |
| 2026-03 | 11,430 | - | 794,571 | 11,376 |
| 2026-04 | 8,193 | - | 803,491 | 6,087 |
| 2026-05 | 7,006 | - | 890,846 | 5,627 |
| 2026-06 | 7,417 | - | 852,083 | 4,197 |
| 2026-07 | 22,079 | - | 857,288 | 2,851 |
| 2026-08 | 34,217 | - | 1,184,684 | 5,774 |
| 2026-09 | 34,109 | - | 1,005,468 | 3,476 |
| 2026-10 | 33,994 | - | 1,476,492 | 5,219 |
| 2026-11 | 12,927 | - | 599,747 | 2,406 |

Other facts:

- Token supply is 1,000,000,000 (raw 10^15, 6 decimals) on every create event that records it.
- From the second quarter of 2026 almost every new coin is a Token-2022 mint, and a large share is created in "mayhem mode".
- `quote_mint` is null before 2026-05-21. After that, `11111111111111111111111111111111` means SOL. Coins are also paired with USDC and, from September 2026, with hundreds of other coins (963 distinct values seen; the first 200 were listed).
- 1,846 graduates have no row in the hourly price table.
- One day of `dex_solana.trades` is about 28.5 million rows (counted for 2025-01-15 and 2026-10-10).

## 4. How good the hourly peak is

Dune's hourly figures for the 20 probe coins, against the highest 1-minute candle high from the Codex probe (`probes/codex-probe-results.json`: `ath1m.highMcap`, otherwise `athFromDaily.highMcap`). All values are market caps in USD.

| Coin | Candle high (USD market cap) | Hourly max, unfiltered | Hourly max, price under 1,000 | Hourly 99.9th pct | 99.9th / candle | Peak on candle day |
|---|---|---|---|---|---|---|
| FARTCOIN | 2,685,924,110 | 2,503,211,197 | 2,503,211,197 | 2,114,387,221 | 0.79 | yes |
| Pnut | 2,492,406,314 | 110,959,030,504 | 110,959,030,504 | 2,313,151,371 | 0.93 | no |
| GOAT | 1,361,665,653 | 4,767,889,350,400 | 25,686,711,511 | 1,541,677,777 | 1.13 | no |
| CHILLGUY | 688,313,768 | 656,175,186 | 656,175,186 | 580,626,245 | 0.84 | yes |
| VANGOAT | 1,239,471 | 934,000 | 934,000 | 934,000 | 0.75 | yes |
| NUT | 1,412,678 | 918,147 | 918,147 | 918,147 | 0.65 | yes |
| Dog | 20,866,579 | 13,210,041 | 13,210,041 | 11,937,221 | 0.57 | yes |
| Pang | 2,404,870 | 1,433,236 | 1,433,236 | 1,433,236 | 0.60 | yes |
| COP | 1,361,583 | 464,928 | 464,928 | 464,928 | 0.34 | yes |
| MM | 764,164 | 387,740 | 387,740 | 387,740 | 0.51 | yes |
| CHILLDOG | 2,679,732 | 1,301,947 | 1,301,947 | 1,301,947 | 0.49 | yes |
| Andrew | 3,675,488 | 1,609,492 | 1,609,492 | 1,609,492 | 0.44 | yes |
| dodge | 1,825,744 | 734,225 | 734,225 | 734,225 | 0.40 | yes |
| DSG | 2,185,003 | 2,138,918 | 2,138,918 | 2,138,918 | 0.98 | yes |
| ROOM | 525,900 | 401,574 | 401,574 | 401,574 | 0.76 | yes |
| WIZARD | 3,008,643 | 1,934,515 | 1,934,515 | 1,934,515 | 0.64 | yes |
| Rose | 176,578 | 123,643 | 123,643 | 103,995 | 0.59 | yes |
| DUMACRATS | 308,796 | 126,104 | 126,104 | 126,104 | 0.41 | yes |
| USOF | 4,315,953 | 2,401,458 | 2,401,458 | 2,401,458 | 0.56 | yes |
| Goyim | 10,239,517 | 7,924,633 | 7,924,633 | 6,901,837 | 0.67 | yes |

What it shows:

- The 99.9th percentile of the hourly price is 0.34 to 1.13 times the highest 1-minute candle high, with a median of 0.62. An hourly price understates a short spike.
- The hour of the hourly maximum falls on the same day as the candle peak for 18 of 20 coins, and in the same hour for 10. The other two are the bad prints below.
- The plain maximum is wrong for long-lived coins that have bad prints. Both are in August 2025: about 45 times the candle high for Pnut, and about 3,500 times for GOAT (19 times once prices of 1,000 USD or more are filtered out, as the queries do). The 99.9th percentile fixes both (0.93 and 1.13).
- The percentile does not protect short-lived coins. 2,839 graduates show a peak of $100M or more, far more than exist. Treat the two top sample cells as holding bad prints as well as real large coins. Bad prints are harmless for discovery, because the coin is checked against candles, and useful for validation.
- So the hourly peak is used to pick candidates and to spread the sample, never as an ATH. A floor of $30k on it is the safe candidate cut (0.34 times $100k is $34k): 216,511 of 347,566 graduates. 99,486 are at $100k or more.

## 5. Known inaccuracies and gaps

- The hourly peak is a price from an hourly table, not a trade. It understates short spikes and includes bad prints (section 4). The real all-time high comes from our own metric library and the candles.
- Coins that never graduated are not in the list. Section 8 sizes them (issue #44): most of the apparent count is bad rows in the price table, and a real group exists that is not the one first expected.
- The list is as of the run time. About 1,100 coins graduate a day in late 2026.
- 1,846 graduates have no hourly price, so they have no peak.
- Before June 2024 graduation comes from the withdraw call, not from an event. Before May 2024 creation comes partly from the create call.
- The create call table is incomplete from November 2025, so the queries use the event table for those months.
- From 2026-05-21, coins may be paired with USDC or with other coins. `dex_solana.price_hour` prices are USD per whole coin; how well it prices coins paired with other coins was not checked.

## 6. Tried and rejected

- **A scan of `dex_solana.trades` with 1-minute buckets** (the first draft's `graduates.sql`). Three days of Raydium and PumpSwap trades joined to all graduates did not finish in four minutes on the medium tier and cost 5.8 credits when cancelled. A month would take about an hour and the full history roughly 3,000 credits.
- **`prices.hour` and `prices.minute`.** A lookup of 20 coins did not finish in 150 seconds and cost 17.5 and 7.1 credits when cancelled. Do not use them.
- **The third-highest hour as a robust peak.** Memecoin peaks are too sharp: one probe coin's second-highest hour is a quarter of its highest, and the bad prints on GOAT and Pnut last more than six hours.
- **The raw-instruction scan of `solana.instruction_calls`** for create and graduation events (the first draft). The decoded event tables replace it.

## 7. How to run

The runner is in PR #24: `ingest/scripts/dune-discovery.ts`. It runs the queries against Dune and writes the results. Follow its own instructions for the key, which is read from an environment variable and is not in this repository.

Order:

1. `sizing.sql` and `sample.sql` need no download of the full list. Their results are already in `results/sizing-2026-11-15.csv` and `results/sample-2026-11-15.csv`.
2. When the backfill starts, run `discovery.sql` once with a floor on the peak (`WHERE peak_max_usd >= 30000` is the safe cut) and download it in pages of up to 32,000 rows. Budget the download credits first (section 1).
3. Re-run `schema_probe.sql` statements 2 to 6 if a table seems to have changed.
4. For the never-graduated queries (section 8), the runner downloads the result and then exits with code 1 and `Header is missing columns`, because it tries to size the candidate list from a file of another shape. The saved file is complete. Use one `--out` directory for each query: the download is always named `discovery.csv`, and the candidate list's directory must not be reused.

## 8. Coins that never graduated (issue #44)

Run on 2026-11-16 (medium tier, about a minute each). Costs: `curve-only-sizing.sql` 5.54 credits for the first version and 5.76 with six more columns, `missed-graduations.sql` 1.63, `curve-only-sample.sql` 5.27: 18.19 credits in all against the issue's 40. Each download was recorded at the known rate (0.05 for 35 rows, 0.26 for 168) and did not show in Dune's usage figure. A coin counts as never graduated when it has a creation record and no graduation by the rule of `sizing.sql`. The price filters are the same. "Plain maximum" is the highest hourly price times one billion. The 99.9th percentile (`p100k`) is computed from the number of hours at or above the line: the nearest-rank 99.9th percentile of n prices is at or above a line exactly when more than floor(n / 1000) of them are, so it agrees with `sizing.sql`'s measure up to the approximation inside `approx_percentile`.

### Count

24,776,959 coins were created and had not graduated by the run; 23,162,015 of them have at least one hourly price. 48,406 reach $100,000 by the plain maximum (48,390 by the 99.9th percentile). Of the 48,406: 1,219 are from $100,000 to under $125,000 (the band), 47,187 are $125,000 or more, and 42,348 are $1,000,000 or more. 38,974 have exactly one hour at or above $100,000 and 9,432 have two or more. The counts by month are in `results/curve-only-sizing-2026-11-16.csv`.

Leaving out a plain maximum of $1,000,000 or more (counts at or above the line, and up to $1,000,000):

| Line | All months | Launched from 2025-11 | Launched before 2025-11 |
|---|---|---|---|
| $30,000 | 56,004 | 14,713 | 41,291 |
| $50,000 | 15,722 | 8,273 | 7,449 |
| $80,000 | 7,307 | 5,357 | 1,950 |
| $100,000 | 6,058 | 4,344 | 1,714 |
| two or more hours at $50,000 | 7,827 | 4,457 | 3,370 |
| two or more hours at $100,000 | 2,366 | 2,243 | 123 |

Of the 1,714 launched before 2025-11 at $100,000, 1,163 are from 2025-09. The band holds 1,219 coins, 335 of them launched before 2025-11 and 287 of those in 2025-09.

### What the three results show

1. **The graduation rule misses nothing that the records can show.** `missed-graduations-2026-11-16.csv`: no never-graduated coin has a migration record (`with_migration` is 0 in every month). In every month from 2025-04 on, nearly every graduate by our rule has an AMM pool or a migration record: `graduates_with_either` equals `graduates` in all but five months (2026-03, 2026-07, 2026-08, 2026-09 and 2026-10), where it is 1 to 3 short (7 coins in all of 348,168). The pool and migration tables do not reach back before about 2025-03 (2,782 of 6,769 graduates of 2025-03 have either, 353 of 23,516 of 2025-01), so earlier months cannot be checked this way. 3,827 never-graduated coins have an AMM pool opened beside the curve, 1,813 of them launched in 2025-03 and 2025-04.
2. **The $1,000,000 group is bad rows in the price table.** In the sample, the 60 `high` coins peak at $1.4 million to $121 billion against hourly lows of $0.14 to $116 million, and up to 1,328 coins share one peak hour. The same holds for `2025-H2 / mid / one` and `2025-H2 / band / one` (coins sharing a peak hour: 309 and 542 in the first, 309 and 189 in the second, against hourly lows of $5,700 to $9,800) and `2026-H2 / mid / one` (peaks of $356,000 to $361,000 against lows of $2,400 to $8,900, with 24 to 91 coins sharing a peak hour, the flag false on all five).
3. **The classic-curve group the issue expected is about 50 coins in three years**: the band before 2025-11 without 2025-09 is 48 coins. A standard curve tops out at about $121,000 at SOL's highest price, and the band holds those.
4. **A real group exists from late 2025: never-graduated coins priced above the classic curve's top over several hours, which a standard curve cannot do.** In the sample, `2026-H1 / mid / one` holds peaks of $127,000 to $197,000 against hourly lows of $6,100 to $46,000, only 1 to 3 coins sharing a peak hour, and `is_mayhem_mode = true` on 4 of 5 (the fifth has no flag); in the sample's non-`high` cells of 2026-H1 and 2026-H2, 29 of 40 rows have the flag set to true. From the sizing: 4,344 coins launched from 2025-11 have a plain maximum from $100,000 to under $1,000,000, and 2,243 of them have two or more hours at $100,000 or more (8,273 reach $50,000). Five were checked against a second source: public hourly candles of the pump.fun curve pool on GeckoTerminal, read on 2026-11-16 (highest hourly high times one billion):

| Mint | Dune peak (USD) | Second source (USD) |
|---|---|---|
| `2stvYh1YZ8NaeM3Uw258Q6ZaQKyAYKZAGx3g4aQ1pump` | 209,739 | 215,863 |
| `B2wAP7ZX77gLW6xNfYahdqu1bFi5Fm1ZvgnYuc38pump` | 142,207 | 142,367 |
| `3fDGfx9uwN3cuEDaqwGrgtLzMa7C4ai76DAVv2vZpump` | 117,860 | 172,477 (highest hourly close 117,606) |
| `GHdQCghEHDfYtDgnjAwFtayL9D5FrFTKtaJUWrQEpump` | 176,225 | 178,042 |
| `7UiZQYZ2PhZgnsWHo4FUGKu6aZPwt43sx1x8MSY9pump` | 120,977 | 115,808 |

   For all five the second source's fully diluted value is exactly two billion times its price. What was observed: prices above the classic curve's top on the curve pool itself, and a supply of two billion at the second source. Why the curve allows this was not established.
5. **`is_mayhem_mode` is empty for coins launched before the flag was filled** (in the sample, 116 of 168 rows have no flag, including the December 2025 coins), so the launch month, not the flag, is the cut. The CSV writes an empty value as `<nil>`.

### Recommendation (lead, 2026-11-16)

> **Recommendation (lead, 2026-11-16): include them, as a second candidate list, once the pipeline can take a coin with no graduation (#102).** Rule: never graduated, plain hourly maximum under $1,000,000, and $50,000 or more if launched from 2025-11-01 (8,273 coins), $80,000 or more if launched before (1,950 coins, about 1,180 of them one bad hour in 2025-09 that the candles will throw out). About 10,200 coins. At the backfill's 16.1 units a coin that is about 165,000 Codex.io units: about $23 at the overage price, nothing extra inside a new plan month. Expected to add roughly 4,000 to 5,000 listed coins, about 3% on top of the 147,910 listed today. The 42,348 coins at $1,000,000 or more are left out as bad rows.

This section does not list the coins or change the pipeline: the candidate list for them and the change to the pipeline are issue #102.
