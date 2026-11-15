-- graduates.sql: one row per pump.fun coin created in [launch_from, launch_to) that
-- graduated within window_days of its creation, with its rough peak market cap.
-- This is the one heavy query. Sizing tables and the Phase A sample are computed in code
-- (issue #23) from its exported rows.
--
-- NOT YET RUN. No Dune key existed when this was written, so no part of this query has
-- been executed. Table and column names are checked against Dune's docs, the Spellbook
-- source and pump.fun's public IDL only (see README.md). Run schema_probe.sql first, then
-- this query on a one-week launch range with window_days 7.
--
-- Returns, in this order (issue #23 reads these by name):
--   mint, created_at, creator, graduated_at, graduation_pool, graduation_venue,
--   rough_peak_usd, rough_peak_at, trade_count, first_trade_at, last_trade_at
--   * created_at, graduated_at, rough_peak_at, first_trade_at, last_trade_at are UTC text,
--     'YYYY-MM-DD HH:MM:SS', which sorts as text. rough_peak_at is the start of the peak minute.
--   * creator: the "user" account of the create instruction.
--   * graduation_venue: 'pumpswap' (migration event) or 'raydium' (first Raydium v4 trade
--     after graduation); both it and graduation_pool are null if neither is found.
--   * rough_peak_usd: market cap in USD; null when no 1-minute bucket counted.
--   * trade_count, first_trade_at, last_trade_at: counted post-graduation trades inside the
--     window; null / 0 when the coin has none.
--
-- Parameters (set the type and default in Dune's parameter box):
--   {{launch_from}}   date    default 2024-01-01 00:00:00   first launch counted (inclusive)
--   {{launch_to}}     date    default 2024-02-01 00:00:00   launch end (exclusive)
--   {{window_days}}   number  default 90                    days after creation in which a coin must
--                                                           graduate and its trades count
--   {{min_peak_usd}}  number  default 0                     smallest rough peak returned; at 0 coins
--                                                           with a null peak are returned too
--
-- Expected result: a guess, not a measurement. One launch month: tens of thousands of
-- rows (every graduate, peak or not), a few MB at about 250 bytes a row.
-- Expected scan: unknown until run.
--
-- HOW EACH TABLE IS READ ONCE. DuneSQL re-runs a WITH block every time it is referenced.
-- So every block below is referenced exactly once, in a chain:
--   pump_raw (the only read of solana.instruction_calls) -> pump_parsed -> pump_by_mint
--   -> graduates -> trade_buckets (the only read of dex_solana.trades, inside it)
--   -> coin_stats -> final SELECT.
-- Graduates with no trades are kept by a RIGHT JOIN from the trades subquery to
-- graduates inside trade_buckets, so graduates is not referenced a second time.
--
-- DECODED TABLES: see the comment block above pump_raw for how they replace the raw scan.

WITH
-- ---------------------------------------------------------------------------
-- pump.fun events. WORKING VERSION: raw instruction rows.
--
-- DECODED-TABLE REPLACEMENT (do not use until schema_probe.sql has run; the column names
-- of the decoded tables are not documented and are NOT guessed here). The tables
-- pumpdotfun_solana.pump_call_create and pumpdotfun_solana.pump_call_withdraw are known to
-- exist. Replace the three blocks pump_raw, pump_parsed and pump_by_mint with ONE block
-- pump_by_mint that has the same output columns:
--   mint, created_at, creator, graduated_at, migration_pool
-- built from the decoded tables, reading each once:
--   create     (pumpdotfun_solana.pump_call_create): needs the mint, the creator or user
--              account, and the call block time (-> created_at).
--   graduation (a complete-event table, or the bonding-curve account plus time from
--              pump_call_withdraw for Raydium-era coins): needs the mint (or the bonding
--              curve, then joined to the create's bonding curve) and the block time
--              (-> graduated_at).
--   migration  (a PumpSwap migrate table or event table): needs the mint and the pool
--              (-> migration_pool). Absent for Raydium-era coins.
-- Combine them with one GROUP BY mint, and keep the block time filters:
--   call_block_date / block_time between launch_from and launch_to + window_days.
-- If the decoded tables expose pump.fun's own creator field, return it as a second column
-- (creator_field) AFTER last_trade_at, so the column order above stays unchanged.
-- ---------------------------------------------------------------------------
pump_raw AS (
  -- The only read of solana.instruction_calls. Four kinds of row: create and create_v2
  -- instructions, the CompleteEvent (curve full = graduated) and the
  -- CompletePumpAmmMigrationEvent (PumpSwap pool made at graduation). The events are inner
  -- "event CPI" instructions: data = 8-byte tag 0xe445a52e51cb9a1d, then the 8-byte event
  -- discriminator, then the fields. The scan runs to launch_to + window_days because a
  -- coin can graduate after the end of the launch range.
  SELECT
    block_time,
    data,
    account_arguments
  FROM solana.instruction_calls
  WHERE executing_account = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
    AND executing_account_prefix = '6E'
    AND tx_success = true
    AND block_date >= CAST(CAST('{{launch_from}}' AS timestamp) AS date)
    AND block_date <= CAST(date_add('day', {{window_days}}, CAST('{{launch_to}}' AS timestamp)) AS date)
    AND block_time >= CAST('{{launch_from}}' AS timestamp)
    AND block_time < date_add('day', {{window_days}}, CAST('{{launch_to}}' AS timestamp))
    AND (
      varbinary_starts_with(data, 0x181ec828051c0777)                    -- create
      OR varbinary_starts_with(data, 0xd6904cec5f8b31b4)                 -- create_v2
      OR varbinary_starts_with(data, 0xe445a52e51cb9a1d5f72619cd42e9808) -- CompleteEvent
      OR varbinary_starts_with(data, 0xe445a52e51cb9a1dbde95db95c94ea94) -- CompletePumpAmmMigrationEvent
    )
),
pump_parsed AS (
  -- One row per event with its kind, mint, creator and pool.
  --   create:      mint = account 1; creator = account 8 (user)
  --   create_v2:   mint = account 1; creator = account 6 (user)
  --   CompleteEvent: mint at bytes 49-80 (1-based)
  --   CompletePumpAmmMigrationEvent: mint at bytes 49-80, pool at bytes 145-176
  SELECT
    block_time,
    CASE
      WHEN varbinary_starts_with(data, 0x181ec828051c0777) THEN 'create'
      WHEN varbinary_starts_with(data, 0xd6904cec5f8b31b4) THEN 'create'
      WHEN varbinary_starts_with(data, 0xe445a52e51cb9a1d5f72619cd42e9808) THEN 'complete'
      ELSE 'migrated'
    END AS kind,
    CASE
      WHEN varbinary_starts_with(data, 0x181ec828051c0777) THEN account_arguments[1]
      WHEN varbinary_starts_with(data, 0xd6904cec5f8b31b4) THEN account_arguments[1]
      ELSE to_base58(bytearray_substring(data, 49, 32))
    END AS mint,
    CASE
      WHEN varbinary_starts_with(data, 0x181ec828051c0777) THEN account_arguments[8]
      WHEN varbinary_starts_with(data, 0xd6904cec5f8b31b4) THEN account_arguments[6]
    END AS creator,
    CASE
      WHEN varbinary_starts_with(data, 0xe445a52e51cb9a1dbde95db95c94ea94)
        THEN to_base58(bytearray_substring(data, 145, 32))
    END AS pool
  FROM pump_raw
),
pump_by_mint AS (
  -- One pass: per mint, the creation time and creator, the graduation time and the
  -- PumpSwap migration pool. Null where the event was not seen.
  SELECT
    mint,
    min(block_time) FILTER (WHERE kind = 'create') AS created_at,
    min_by(creator, block_time) FILTER (WHERE kind = 'create') AS creator,
    min(block_time) FILTER (WHERE kind = 'complete') AS graduated_at,
    min_by(pool, block_time) FILTER (WHERE kind = 'migrated') AS migration_pool
  FROM pump_parsed
  GROUP BY 1
),
graduates AS (
  -- Coins created in the launch range that graduated within window_days of creation.
  -- window_end is the last moment their trades count.
  SELECT
    mint,
    created_at,
    creator,
    graduated_at,
    migration_pool,
    date_add('day', {{window_days}}, created_at) AS window_end
  FROM pump_by_mint
  WHERE created_at >= CAST('{{launch_from}}' AS timestamp)
    AND created_at < CAST('{{launch_to}}' AS timestamp)
    AND graduated_at >= created_at
    AND graduated_at < date_add('day', {{window_days}}, created_at)
),
trade_buckets AS (
  -- The only read of dex_solana.trades. Each trade row is split into its two sides with
  -- UNNEST, so the coin is whichever side matches a graduate's mint. Trades are joined to
  -- graduates with a RIGHT JOIN, so a graduate without trades still gets one row (with
  -- null trade columns); that is how graduates is referenced only once.
  -- Trade rows: venue is not filtered except to drop the pump.fun curve (post-graduation
  -- trades only). Rows with a null or zero USD amount or token amount are skipped.
  -- Token amount = raw / 10^6 (6 decimals for every pump.fun coin). The partition column
  -- block_month limits the scan to launch_from .. launch_to + window_days.
  -- Grouped to 1-minute buckets per coin: USD, tokens, trade count, first and last trade,
  -- and the first Raydium v4 pool with its time.
  SELECT
    g.mint,
    g.created_at,
    g.creator,
    g.graduated_at,
    g.migration_pool,
    date_trunc('minute', tr.block_time) AS bucket_minute,
    sum(tr.usd) AS usd,
    sum(tr.tokens) AS tokens,
    count(tr.block_time) AS trades,
    min(tr.block_time) AS first_trade_at,
    max(tr.block_time) AS last_trade_at,
    min_by(tr.pool_id, tr.block_time) FILTER (WHERE tr.project = 'raydium' AND tr.version = 4) AS raydium_pool,
    min(tr.block_time) FILTER (WHERE tr.project = 'raydium' AND tr.version = 4) AS raydium_pool_at
  FROM (
    SELECT
      s.mint,
      t.block_time,
      t.project,
      t.version,
      t.project_program_id AS pool_id,
      t.amount_usd AS usd,
      s.raw_amount / 1000000 AS tokens
    FROM dex_solana.trades t
    CROSS JOIN UNNEST(ARRAY[
      ROW(t.token_bought_mint_address, CAST(t.token_bought_amount_raw AS double)),
      ROW(t.token_sold_mint_address, CAST(t.token_sold_amount_raw AS double))
    ]) AS s(mint, raw_amount)
    WHERE t.block_month >= CAST(date_trunc('month', CAST('{{launch_from}}' AS timestamp)) AS date)
      AND t.block_month <= CAST(date_trunc('month', date_add('day', {{window_days}}, CAST('{{launch_to}}' AS timestamp))) AS date)
      AND t.block_time >= CAST('{{launch_from}}' AS timestamp)
      AND t.block_time < date_add('day', {{window_days}}, CAST('{{launch_to}}' AS timestamp))
      AND t.project <> 'pumpdotfun'
      AND t.amount_usd > 0
      AND s.raw_amount > 0
  ) tr
  RIGHT JOIN graduates g
    ON g.mint = tr.mint
    AND tr.block_time >= g.graduated_at
    AND tr.block_time < g.window_end
  GROUP BY 1, 2, 3, 4, 5, 6
),
coin_stats AS (
  -- One row per coin. THE ROUGH-PEAK RULE: a 1-minute bucket counts when it has at least
  -- $1,000 of volume and at least 3 trades; bucket price = USD volume / token volume;
  -- rough peak = highest counting bucket price * 1,000,000,000 (fixed supply). The peak
  -- minute is the bucket with that price. Also: total trades, first and last trade, and
  -- the pool of the first Raydium v4 trade.
  SELECT
    mint,
    created_at,
    creator,
    graduated_at,
    migration_pool,
    max(usd / tokens) FILTER (WHERE usd >= 1000 AND trades >= 3) * 1000000000 AS rough_peak_usd,
    max_by(bucket_minute, usd / tokens) FILTER (WHERE usd >= 1000 AND trades >= 3) AS rough_peak_at,
    sum(trades) AS trade_count,
    min(first_trade_at) AS first_trade_at,
    max(last_trade_at) AS last_trade_at,
    min_by(raydium_pool, raydium_pool_at) AS raydium_pool
  FROM trade_buckets
  GROUP BY 1, 2, 3, 4, 5
)
SELECT
  mint,
  date_format(created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
  creator,
  date_format(graduated_at, '%Y-%m-%d %H:%i:%s') AS graduated_at,
  COALESCE(migration_pool, raydium_pool) AS graduation_pool,
  CASE
    WHEN migration_pool IS NOT NULL THEN 'pumpswap'
    WHEN raydium_pool IS NOT NULL THEN 'raydium'
  END AS graduation_venue,
  rough_peak_usd,
  date_format(rough_peak_at, '%Y-%m-%d %H:%i:%s') AS rough_peak_at,
  trade_count,
  date_format(first_trade_at, '%Y-%m-%d %H:%i:%s') AS first_trade_at,
  date_format(last_trade_at, '%Y-%m-%d %H:%i:%s') AS last_trade_at
FROM coin_stats
WHERE COALESCE(rough_peak_usd, 0) >= {{min_peak_usd}}
ORDER BY created_at, mint
