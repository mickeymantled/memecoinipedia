# Dune queries for discovering pump.fun graduates

**Status: NOT YET RUN.** There is no Dune key and the credit limit for this task is zero, so no query here has been executed. Everything below comes from Dune's documentation and from source code on GitHub, read on 2026-11-15. Nothing was tested against real data.

Labels used below:

- **Verified in docs or source**: I read the definition at the linked page.
- **Assumed**: I could not find a definition; the query depends on it anyway.


## 1. The files and the first live run

| File | What it is | Parameters (default) |
|---|---|---|
| `schema_probe.sql` | Metadata statements that list the tables of schema `pumpdotfun_solana` and the columns of the create, complete, withdraw and migrate tables. Two forms (`information_schema` and `SHOW`) as separate statements, each run on its own, because Dune may refuse one. Almost free. | none |
| `graduates.sql` | The one heavy query. One row per coin created in `[launch_from, launch_to)` that graduated within `window_days` of creation. Columns, in this order: `mint, created_at, creator, graduated_at, graduation_pool, graduation_venue, rough_peak_usd, rough_peak_at, trade_count, first_trade_at, last_trade_at`. Coins with no counting bucket come back with a null rough peak. | `launch_from` (2024-01-01), `launch_to` (2024-02-01), `window_days` (90), `min_peak_usd` (0; null peaks are returned only at 0) |
| `curve_edge.sql` | Coins that never graduated but whose curve price times 1e9 reached `min_peak_usd`, with a count on every row. | `range1_from` to `range3_to` (section 4), `min_peak_usd` (100000), `grad_check_days` (30) |

Timestamps in `graduates.sql` are UTC text, `YYYY-MM-DD HH:MM:SS`, which sorts as text. They come from `date_format(ts, '%Y-%m-%d %H:%i:%s')` and assume Dune formats `block_time` in UTC (unverified).

Sizing tables (graduates and peak counts per launch month, trades and active days per coin) and the 500-coin Phase A sample draw are **not** done in SQL. They are computed in tested code from the exported `graduates.sql` rows under issue #23.

**Order of the first live run**

1. `schema_probe.sql`, each statement on its own. It is close to free. Read which decoded create, complete and migrate tables exist and what their columns are.
2. `graduates.sql` on a one-week launch range with `window_days` 7. This measures cost and checks the parsing (for example, that the probe coins' mints appear). If the probe found usable decoded tables, switch the event pass first (see the comment block at the top of the query).
3. `graduates.sql` for full months, one month at a time.
4. `curve_edge.sql`, first with `range1` cut to one day to measure cost.

Expected size: `graduates.sql` one month is tens of thousands of rows and a few MB (a guess). `curve_edge.sql` is a guess of 10 to 500 rows. Expected megabytes of **scan** (what Dune bills) are unknown. The only number I found is from Spellbook's test config: `dex_solana.trades` holds 17.2 billion rows and 236 GB in total ([_schema.yml, comment on `amount_usd`](https://github.com/duneanalytics/spellbook/blob/main/dbt_subprojects/solana/models/_sector/dex/_schema.yml)). I found no size for `solana.instruction_calls`.

### How each table is read once

DuneSQL runs a `WITH` block again every time it is referenced. Every block that reads a table is therefore referenced once, in a chain:

- `graduates.sql`: `pump_raw` (the only read of `solana.instruction_calls`) -> `pump_parsed` -> `pump_by_mint` -> `graduates` -> `trade_buckets` (the only read of `dex_solana.trades`, in a subquery) -> `coin_stats` -> final `SELECT`.
- The two sides of a trade are split with `CROSS JOIN UNNEST(ARRAY[ROW(bought mint, bought raw), ROW(sold mint, sold raw)])`, so the coin is whichever side matches a graduate. The table is read once, not once per side.
- Graduates with no trades are kept by a `RIGHT JOIN` from the trades subquery to `graduates` inside `trade_buckets`, so `graduates` is not referenced a second time.
- `curve_edge.sql`: `curve_trades` and `completes` are each referenced once.

### Decoded tables

`pumpdotfun_solana.pump_call_create` and `pumpdotfun_solana.pump_call_withdraw` exist (a published analysis queries them: <https://seouldatalabs.substack.com/p/can-we-rescue-trapped-sol-from-pumpfun>). Their columns are not documented, so `graduates.sql` keeps the raw-instruction pass as the working version and carries a comment block showing which columns the decoded tables must supply (mint, creator or user, block time for create; mint or bonding curve and block time for graduation; mint and pool for the PumpSwap migration). No column name of a decoded pump.fun table is written in executable SQL.

## 2. The scan bound: `window_days`

`window_days` (default 90) bounds each coin, not the whole query:

- A coin counts as graduated only if its CompleteEvent is within `window_days` of its creation.
- Only trades from graduation to creation + `window_days` count toward its rough peak, trade count, first and last trade.
- The trades scan covers the calendar months from `launch_from` to `launch_to + window_days` (partition column `block_month`), and `block_time` trims it.

A per-coin window means running a full range or twelve one-month slices gives the same row for the same coin.

**The limitation, plainly.** With `window_days` = 90, a coin that first passes $100k more than 90 days after creation is missed. A rough peak inside 90 days understates coins that peaked later. FARTCOIN's all-time high came about three months after launch. Both are accepted for sizing and discovery. The real all-time high comes from our own pipeline, and late peaks are handled later, per coin, for the coins we ingest. A coin that took longer than `window_days` to graduate is not returned at all.

For a cost measurement on a one-week slice, set `window_days` to 7 too. Otherwise a one-week slice still reads about 4 months of trade partitions. The value 90 is a guess; no measurement supports it.


## 3. Tables and columns used

### 3.1 `dex_solana.trades` (Dune curated table, built by Spellbook)

Definition checked against:

- Dune docs: <https://docs.dune.com/data-catalog/curated/dex-trades/solana/solana-dex-trades>
- Spellbook model: <https://github.com/duneanalytics/spellbook/blob/main/dbt_subprojects/solana/models/_sector/dex/dex_solana_trades.sql>
- Spellbook base model, which lists the venue models: <https://github.com/duneanalytics/spellbook/blob/main/dbt_subprojects/solana/models/_sector/dex/dex_solana_base_trades.sql>

| Column | Type | Used for | Checked |
|---|---|---|---|
| `block_month` | DATE | **The partition column.** Spellbook's config says `partition_by = ['block_month']`; the docs say "partition key". Every trades scan filters on it. | Verified in docs and source |
| `block_time` | TIMESTAMP | Time of the trade; trims each coin's window | Verified in docs and source |
| `project` | VARCHAR | Venue name; used to exclude the curve (`'pumpdotfun'`), to find the first Raydium pool (`'raydium'`), and to select curve trades in `curve_edge.sql` | Verified in docs and in each venue model (below) |
| `version` | INTEGER | Raydium v4 is `project = 'raydium'` and `version = 4` | Verified in the Raydium v4 model |
| `project_program_id` | VARCHAR | **Despite the name, this is the pool address** for PumpSwap and Raydium v4, and the bonding-curve account for the pump.fun curve. Used as `graduation_pool` for Raydium-era coins. | Verified in the PumpSwap and Raydium v4 models; see "naming trap" below |
| `token_bought_mint_address`, `token_sold_mint_address` | VARCHAR | The coin is whichever side equals its mint (base58 text) | Verified in docs and source. `_schema.yml` calls them `token_bought_address` and `token_sold_address`, which does not match the model SQL or the docs page; I used the SQL and docs names |
| `token_bought_amount_raw`, `token_sold_amount_raw` | UINT256 | Token volume. Divided by 1,000,000 (6 decimals) | Verified in docs and source |
| `amount_usd` | DOUBLE | USD value of the trade | Verified in docs and source |

Facts about these columns that the queries rely on:

- **Bought and sold sides.** One row per swap leg. The bought side and sold side each have a mint and a raw amount. The queries scan once for "coin is the bought side" and once for "coin is the sold side" and union the two. A single join on `mint IN (bought, sold)` would be slow.
- **Which amounts are decimal-adjusted.** `token_bought_amount` and `token_sold_amount` are decimal-adjusted, using decimals from `tokens_solana.fungible`; when that join finds nothing the result is null (`dex_solana_trades.sql`: `raw / pow(10, coalesce(decimal_project_specific, token.decimals))`). The `_raw` columns are not adjusted and are always present. The queries use `_raw / 1,000,000`, because every pump.fun coin has 6 decimals (given in the task brief; not re-checked here), and a brand-new Token-2022 mint may be missing from `tokens_solana.fungible`.
- **How `amount_usd` is made.** From `dex_solana_trades.sql`: if the bought token is in `prices.trusted_tokens`, bought amount times its minute price; otherwise sold amount times its minute price; otherwise bought amount times its minute price. The coin itself is not a trusted token, so for a coin trade the USD value normally comes from the quote side (SOL, USDC and so on) at that minute's price. It is null when the quote side has no price in `prices.usd`.
- **Spellings.** `project` is `pumpdotfun` (version 1) for the curve, `pumpswap` (version 1) for PumpSwap, `raydium` with `version` 4 (and `version_name` `amm`) for Raydium v4. Sources: [pumpdotfun_solana_base_trades.sql](https://github.com/duneanalytics/spellbook/blob/main/dbt_subprojects/solana/models/_sector/dex/pumpdotfun/solana/pumpdotfun_solana_base_trades.sql), [pumpswap_solana_base_trades_backfill.sql](https://github.com/duneanalytics/spellbook/blob/main/dbt_subprojects/solana/models/_sector/dex/pumpswap/pumpswap_solana_base_trades_backfill.sql), [raydium_v4_base_trades_backfill.sql](https://github.com/duneanalytics/spellbook/blob/main/dbt_subprojects/solana/models/_sector/dex/raydium/raydium_v4_base_trades_backfill.sql). The queries filter on `project` only to pick out the curve, Raydium v4 and (in `curve_edge.sql`) the curve; they do not filter on any other venue.
- **Venues in the table.** `dex_solana_base_trades.sql` unions 36 models. Relevant ones: `raydium_version_clmm`, `raydium_v4`, `raydium_v5`, `raydium_launchlab_version_1`, `orca_whirlpool` v1 and v2, `meteora` amm, dlmm, cpamm and v4, `pumpdotfun_version_1`, `pumpswap_version_1`, and others. `sanctum_router` is excluded on purpose. This confirms the list in `docs/data-sources.md` (36 models).
- **Naming trap.** `project_program_id` holds the pool address and `project_main_id` holds the program id. If a later reader assumes the name, the graduation pool column will look wrong.

### 3.2 `solana.instruction_calls` (Dune raw table)

Definition checked against: <https://docs.dune.com/data-catalog/solana/instruction-calls>. Used the same way in Spellbook's curve model: [pumpdotfun_solana_base_trades.sql](https://github.com/duneanalytics/spellbook/blob/main/dbt_subprojects/solana/models/_sector/dex/pumpdotfun/solana/pumpdotfun_solana_base_trades.sql).

| Column | Used for | Checked |
|---|---|---|
| `executing_account` | The pump.fun program, `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` | Verified in docs; the address is verified in the pump.fun IDL (below) |
| `executing_account_prefix` | First two characters of the program id (`6E`), as Spellbook does | **Assumed** to exist: Spellbook's model uses it, but Dune's docs page does not list it |
| `tx_success` | Only successful transactions | Verified in docs |
| `block_date`, `block_time` | Time filters. `block_date` is added so the engine can prune by date | Verified in docs. **Assumed** that `block_date` is a partition or sort key. The docs do not say what the table is partitioned by; Spellbook filters on `block_time` |
| `data` (VARBINARY) | Instruction or event bytes. The first 8 bytes are the instruction discriminator; for events the first 16 bytes are the event tag and discriminator | Verified in docs and in Spellbook's use |
| `account_arguments` (ARRAY(VARCHAR)) | Mint and user accounts of the create instructions. Arrays are 1-based | Verified in docs and in Spellbook's use (`account_arguments[1]` is the mint) |

### 3.3 Decoded-table data and Spellbook data: which is which

- **Decoded-table data (instruction-level, from IDLs):** Dune's decoded pump.fun tables exist in the schema `pumpdotfun_solana`, but the only tables I could confirm by name are the PumpSwap ones: `pump_amm_call_buy`, `pump_amm_call_sell`, `pump_amm_call_create_pool`, `pump_amm_call_create_config`, `pump_amm_call_update_fee_config`, `pump_amm_evt_buyevent` ([Spellbook `_sources.yml`](https://github.com/duneanalytics/spellbook/blob/main/dbt_subprojects/solana/models/_sources.yml)). `pump_call_create` and `pump_call_withdraw` also exist (a published analysis queries them, see section 1), but their columns are undocumented. I could not confirm any decoded table for CompleteEvent or the migration. Dune's docs do not list them, and Spellbook's curve model avoids them and reads raw instruction rows instead. So **no query here uses a decoded pump.fun table**. Using one would likely be cheaper (smaller table); `schema_probe.sql` lists their columns; switching to them is the first thing to try once it has run.
- **Raw table with IDL-derived layouts (what the queries use):** create, create_v2, CompleteEvent and CompletePumpAmmMigrationEvent are read from `solana.instruction_calls` using discriminators and byte offsets from pump.fun's IDL.
- **Spellbook-derived:** all trades come from `dex_solana.trades`.

### 3.4 pump.fun create, graduation and migration: the exact layouts

Source for every row below: pump.fun's IDL, <https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump.json> (program address `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`, which matches Spellbook). I recomputed the Anchor discriminators (first 8 bytes of SHA-256 of `global:<name>` or `event:<Name>`); they match the IDL, and `create` and `TradeEvent` also match Spellbook's hard-coded values.

| What | Where | Discriminator | Fields used |
|---|---|---|---|
| Create (classic) | instruction `create` | `0x181ec828051c0777` | account 1 = `mint`, account 8 = `user` (creator wallet signer) |
| Create (Token-2022, new coins) | instruction `create_v2` | `0xd6904cec5f8b31b4` | account 1 = `mint`, account 6 = `user` |
| Graduation | event `CompleteEvent`, inner instruction, data starts `0xe445a52e51cb9a1d` + `0x5f72619cd42e9808` | | `mint` at bytes 49 to 80 (1-based). The IDL's other fields: user, bonding_curve, timestamp, quote_mint |
| Graduation pool, PumpSwap era | event `CompletePumpAmmMigrationEvent`, data starts `0xe445a52e51cb9a1d` + `0xbde95db95c94ea94` | | `mint` at bytes 49 to 80, `pool` at bytes 145 to 176 |
| Graduation pool, Raydium era | none on the pump.fun side | | The query uses the pool of the coin's first Raydium v4 trade after graduation |

Things to know:

- **create_v2 is covered.** The create-event source selects both `create` and `create_v2`, so Token-2022 coins are not dropped. The creator wallet is the `user` account. The instructions also take a `creator` argument that can differ from `user`; I did not parse it, because it sits after three variable-length strings. It is unverified how often the two differ.
- The IDL is newer than the Spellbook curve model: it has `create_v2`, `buy_v2`, `buy_v3`, `migrate_v2`, a `quote_mint` on `CompleteEvent`, `CompletePumpAmmMigrationEvent` and `TradeEvent`, and a `multi_hop_curve_swap`. The 8-byte discriminators of the events I use did not change, but I **assumed** that the field positions I use (mint at 49, pool at 145) held for every program version since 2024. The IDL I read is the current one only. This is the biggest unverified point.
- **Migrate instruction vs event.** The `migrate` and `migrate_v2` instructions also carry the pool as an account (account 10 and 11, 0-based). I read the event instead, because one event covers both instruction versions.
- **Graduation time** is the block time of the CompleteEvent row.

### 3.5 What Spellbook already has, and why I did not use it

- Spellbook has **no model of pump.fun graduates or token launches**. I searched the full file tree of the repository (`dbt_subprojects/solana/models/_sector/dex/pumpdotfun` has only trade models; `pumpswap` has trade models plus `pumpswap_solana_pools`).
- `pumpswap_solana.pools` ([source](https://github.com/duneanalytics/spellbook/blob/main/dbt_subprojects/solana/models/_sector/dex/pumpswap/pumpswap_solana_pools.sql)) lists every PumpSwap pool: `pool`, `created_at`, `baseMint`, `quoteMint`. It would be cheap, but it lists all pools, not only pump.fun graduation pools; anyone can open a PumpSwap pool, and I could not tell from the source how to isolate migrations. It also only starts at 2025-03-14. I did not use it.
- Spellbook's own curve model reads only the classic `create` instruction (discriminator `0x181ec828051c0777`) to find the bonding-curve account. For `create_v2` coins the curve rows' `project_program_id` is probably null. The queries here do not read that column for the curve, so it does not affect them.

## 4. `curve_edge.sql`: when SOL was above $243

The curve ends at about 411 SOL of market cap (`docs/data-sources.md`, section 2, labelled Inferred there). 411 SOL is $100k at a SOL price of about $243. The ranges are the days when SOL's daily high on Binance SOLUSDT was above $243.

Price source: Binance spot daily candles for SOLUSDT, `GET https://api.binance.com/api/v3/klines?symbol=SOLUSDT&interval=1d` ([documentation](https://developers.binance.com/docs/binance-spot-api-docs/rest-api/market-data-endpoints)). Read on 2026-11-15 for 2024-01-01 to 2026-11-15. The all-time daily high in that period was $295.83 on 2025-01-19. Days with a daily high above $243:

| Dates (UTC) | Notes |
|---|---|
| 2024-11-18 to 2024-11-19, 2024-11-21 to 2024-11-25, 2024-11-27 to 2024-11-30, 2024-12-05 to 2024-12-07 | Merged into one range, because the gaps are single days |
| 2025-01-18 to 2025-01-26, 2025-01-28, 2025-01-30 | One range |
| 2025-09-12 to 2025-09-15, 2025-09-17 to 2025-09-19 | One range |

The defaults add one day on each side and use an exclusive end:

| Parameter | Default |
|---|---|
| `range1_from`, `range1_to` | 2024-11-17, 2024-12-09 |
| `range2_from`, `range2_to` | 2025-01-17, 2025-01-31 |
| `range3_from`, `range3_to` | 2025-09-11, 2025-09-21 |

**This differs from `docs/data-sources.md`.** That document says the weeks were "late 2024 and January 2025". The Binance data adds a third window in mid-September 2025. SOL's price could also have been above $243 on Dune's price feed while below it on Binance; one day of padding covers small gaps only.

Two assumptions in this query:

- The curve model gives each trade's `amount_usd` using a SOL price. For a coin on a non-SOL quote (the IDL's `TradeEvent` now has a `quote_mint` and a `quote_amount`), Spellbook still reads the old `sol_amount` field and labels the quote wrapped SOL (`pumpdotfun_solana_base_trades.sql` hard-codes `So111...112`). Such coins' USD values may be wrong. I could not check whether `sol_amount` holds the quote amount for them.
- The coin side of a curve trade is "the side that is not wrapped SOL". It follows from the hard-coded quote in the Spellbook model; it is not a filter on the quote currency and drops no coin.

## 5. Known inaccuracies of the rough peak

The rough peak sizes and finds candidates. The real ATH comes from our metric library (`docs/metrics.md`). The rough peak can be wrong in these ways:

1. **Thin or manipulated buckets.** A bucket needs $1,000 and 3 trades, not 3 distinct traders. One wallet can pass it. `docs/metrics.md` requires at least 5 traders over a 3-minute window and the second-highest close, so the rough peak is generally higher than the real ATH. Counts at the $100k level are therefore upper bounds.
2. **Price = USD volume / token volume mixes buys and sells.** A bucket with one large sell and small buys can print a price away from the last trade.
3. **`amount_usd` null.** If the quote token has no price in `prices.usd` at that minute, `amount_usd` is null and the trade is skipped. This applies to coins whose pool is quoted in another memecoin: Spellbook's PumpSwap model keeps only pools whose quote mint is SOL, mSOL, USDC, USDT, PUMP or BONK (`pumpswap_solana_pools.sql`, column `is_valid_pool`), so trades in pools quoted in other coins are **missing** from the table, not just null. The pump.fun curve model assumes SOL quote.
4. **`amount_usd` outliers.** Spellbook's data test only flags amounts above $1 billion for the last 7 days ([_schema.yml](https://github.com/duneanalytics/spellbook/blob/main/dbt_subprojects/solana/models/_sector/dex/_schema.yml)). A mispriced trade can set a very high bucket price. The rough peak has no cap, as the issue fixes the rule. `docs/metrics.md` has a data-error cap of $20 billion that the real ATH uses.
5. **Aggregator routes.** `dex_solana.trades` has one row per pool leg, and `trade_source` says if it went through an aggregator. A multi-hop route that passes through the coin in two legs counts twice (once as bought, once as sold) with USD values taken from different quote sides. A route that is split across two pools counts as two trades. I did not de-duplicate them. The `trade_count` and "at least 3 trades" test are in legs, not in user trades.
6. **Venues missing from Dune.** The table has Raydium v4, CPMM (v5), CLMM and LaunchLab, Orca Whirlpool, Meteora (AMM, DLMM, CPAMM, v4) and PumpSwap. Venues outside the 36 models are absent, and `sanctum_router` is excluded. Pools opened later on a missing venue would be missed.
7. **Data lag.** Dune's table refreshes about every 3 hours (`docs/data-sources.md`, Reported), and the Spellbook monitoring config allows 24 hours before a warning. Coins from the last day are incomplete.
8. **The window.** Peaks after `window_days` are missed (section 2). Coins that took longer than `window_days` to graduate are not counted at all.
9. **Graduation time and pool.** A Raydium-era coin's pool is its first Raydium v4 trade, which can be a different pool than pump.fun's if someone opened another Raydium pool first (unverified). A graduated coin whose first post-graduation trade is on neither venue gets a null pool and venue.
10. **Token amount.** `_raw / 1e6` assumes 6 decimals for every coin.
11. **Tied minutes.** `max_by` picks an arbitrary minute if two buckets have the same price; the peak value is unaffected.
12. **Creator.** The `user` account of the create instruction is returned. It is the signer paying for the create, which is the creator in the normal case.

## 6. What could make each query expensive

| Query | Expensive parts |
|---|---|
| `graduates.sql` | (a) `pump_raw` reads the pump.fun program's rows, which include every curve trade event (at least two rows per pump.fun trade); the discriminator tests on `data` probably cannot prune, only the date filters do. (b) `trade_buckets` reads `dex_solana.trades` for `launch_from` to `launch_to + window_days` in months, splits each row into two sides, and only then joins to the graduate list, so nothing prunes the unnest by mint (dynamic filtering may not reach below the unnest). That is the heavy step. (c) The `RIGHT JOIN` is meant to build its hash table on the small side (`graduates`); if Dune builds on the trades side instead, memory use will be high. |
| `curve_edge.sql` | The curve is probably the busiest venue in those weeks (unmeasured). Three ranges of 2 to 3 weeks. The CompleteEvent scan repeats the `pump_raw` cost for the same ranges. |
| `schema_probe.sql` | Metadata only. |

Possible failure points on a first run (all untested):

- `executing_account_prefix` or `block_date` not existing or not pruning on `solana.instruction_calls` (section 3.2).
- `CROSS JOIN UNNEST(ARRAY[ROW(...), ROW(...)]) AS s(mint, raw_amount)`: standard Trino, but not run. A fallback is two `UNION ALL` subqueries over `dex_solana.trades`, which reads the table twice.
- `CAST(uint256 AS double)`, `date_format` on a timestamp, `min_by` and `max_by` with `FILTER`, and `min_by` over a column with nulls (`raydium_pool`) have not been executed.
- A `RIGHT JOIN` whose `ON` clause holds range conditions on both sides.
- The field offsets in section 3.4.
- Memory in `pump_raw` if `data` of create rows (long names and URIs) is large.
- `schema_probe.sql`: Dune may refuse `information_schema` or `SHOW` statements; that is why both forms exist.

## 7. Sources, with what each supports

| Link | Supports |
|---|---|
| <https://docs.dune.com/data-catalog/curated/dex-trades/solana/solana-dex-trades> | Columns, types and "partition key" of `dex_solana.trades` |
| <https://github.com/duneanalytics/spellbook/tree/main/dbt_subprojects/solana/models/_sector/dex> | Models and their SQL (all Spellbook claims above) |
| <https://docs.dune.com/data-catalog/solana/instruction-calls> | `solana.instruction_calls` columns |
| <https://docs.dune.com/data-catalog/solana/idl-tables> | How decoded Solana tables are named and that they only decode instructions, not inner instructions |
| <https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump.json> | pump.fun instructions, events and their fields |
| <https://docs.dune.com/web-app/query-editor/parameters> | `{{name}}` parameter rules |
| <https://developers.binance.com/docs/binance-spot-api-docs/rest-api/market-data-endpoints> | SOLUSDT daily candles used for the $243 ranges |

One note on a source: the decoded-tables page says decoded call tables "only decode from instructions, and not inner instructions." Dune also has event tables (`pump_amm_evt_buyevent` is one, per Spellbook's `_sources.yml`), so an event table for CompleteEvent may exist. I could not confirm it, which is why the queries read the raw table.
