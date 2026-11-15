# Dune queries: discovering pump.fun graduates

These queries were run on Dune on 2026-11-15, and the figures below are what that run measured. Every table and column named here was confirmed live on that date. The results of the sizing query and of the sample query are in `results/`. They hold public chain data only.

The design changed after the first draft of this pull request. The first draft scanned `dex_solana.trades` for 1-minute buckets. That did not finish in a useful time (section 6). The queries now take the peak from Dune's hourly price table, `dex_solana.price_hour`, and use pump.fun's decoded event tables for creation and graduation.

## 1. The queries

Plan: Dune Analyst, medium tier (the small tier is refused on this plan). None of the queries has parameters.

| File | Returns | Result | Execution credits | Run time |
|---|---|---|---|---|
| `discovery.sql` | One row per pump.fun coin that graduated: `mint`, `created_at`, `creator`, `graduated_at`, `hours` (hours with a price), `peak_max_usd`, `peak_p999_usd`, `peak_at`, `last_hour`. Times are epoch seconds (UTC). The peak is a market cap in USD: hourly price times 1,000,000,000. An optional filter goes on a last line: `WHERE peak_max_usd >= <floor>`. | 347,564 rows, 49.9 MB | 3.2 | 65 s |
| `sizing.sql` | One row per launch month (35 rows): graduates, graduates with no hourly price, graduates reaching $30k, $50k, $80k, $100k, $125k, $250k, $1M, $10M and $100M by the 99.9th percentile of the hourly price (`p30k` to `p100m`), the same at $30k and $100k by the plain maximum (`max30k`, `max100k`), and for coins at $100k or more the median, p90, p99 and maximum of hours with a price (`hours_p50` to `hours_max`), plus the sum of hours for coins at $30k or more (`hours_sum_30k`). | 35 rows | 7.2 | 38 s |
| `sample.sql` | The Phase A sample: the 20 probe coins from `probes/coins.json`, plus a draw by quota from each launch half-year and peak cell, ordered by the SHA-256 of the mint (no random function). Quotas per half-year: 5 for $30k to $50k, 10 for $50k to $100k, 30 for $100k to $1M, 20 for $1M to $10M, 15 for $10M and above. Cells are cut on the 99.9th percentile peak. Columns: `mint`, `half_year`, `cell`, `probe`, `cell_size`, `created_at`, `creator`, `graduated_at`, `hours`, `peak_max_usd`, `peak_p999_usd`, `peak_at`. | 500 rows | 7.4 | 101 s |
| `schema_probe.sql` | Metadata and coverage statements, each run on its own. | small | about 0.02 to 0.03 for each metadata statement | seconds |

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
- Coins that never graduated are not in the list. In the weeks when SOL was above about $243 a coin could pass $100k on the curve without graduating. This is not covered yet.
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
