-- candidates.sql: the discovery list. One row per graduated pump.fun coin whose rough
-- peak market cap is at least {{min_peak_usd}}.
--
-- NOT YET RUN. No Dune key existed when this was written, so no part of this query
-- has been executed. Table and column names are checked against Dune's docs and the
-- Spellbook source only (see README.md). Measure it on a one-week slice first.
--
-- Returns (one row per coin):
--   mint, created_at, creator (the wallet that signed the create instruction),
--   graduated_at (CompleteEvent time), graduation_pool and graduation_venue
--   ('pumpswap' from the migration event, or 'raydium' from the coin's first Raydium v4
--   trade; both null if neither was found), rough_peak_usd (market cap in USD),
--   rough_peak_at (start of the peak minute), trade_count, first_trade_at,
--   last_trade_at (counted post-graduation trades inside the window_days window).
--
-- Parameters (set the type and default in Dune's parameter box):
--   {{launch_from}}   date    default 2024-01-01 00:00:00   first launch counted
--   {{launch_to}}     date    default 2024-02-01 00:00:00   launch end, exclusive (run one month at a time)
--   {{window_days}}   number  default 90                    days after creation in which a coin
--                                                           must graduate and its trades count
--   {{min_peak_usd}}  number  default 50000                 smallest rough peak returned
--
-- Expected result: a guess, not a measurement. About 2,000 to 15,000 rows for one launch
-- month at the $50k default, 0.5 to 5 MB (about 300 bytes a row). Roughly 100,000 to
-- 300,000 rows for the whole range.
-- Expected scan: unknown until run. First run: a one-week range with window_days 7.
WITH params AS (
  -- Dune replaces each double-brace parameter with its value before the query runs.
  SELECT
    CAST('{{launch_from}}' AS timestamp) AS launch_from,  -- first launch time counted (inclusive)
    CAST('{{launch_to}}' AS timestamp) AS launch_to       -- last launch time counted (exclusive)
),
pump_raw AS (
  -- One scan of the pump.fun program's instructions, keeping only four kinds of row:
  --   create / create_v2 (the instruction that makes the coin),
  --   CompleteEvent (the curve is full, the coin is "graduated"),
  --   CompletePumpAmmMigrationEvent (the PumpSwap pool made at graduation).
  -- The two events are inner "event CPI" instructions: data = 8-byte event tag
  -- 0xe445a52e51cb9a1d, then the 8-byte event discriminator, then the fields.
  -- The scan runs from launch_from to launch_to + window_days, because a coin can
  -- graduate after the end of the launch range.
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
creates AS (
  -- One row per coin created in the launch range. Mint is account 1 of both create
  -- instructions. The creator wallet is the "user" account (8th account of create,
  -- 6th of create_v2).
  SELECT
    account_arguments[1] AS mint,
    min(block_time) AS created_at,
    min_by(
      CASE WHEN varbinary_starts_with(data, 0x181ec828051c0777)
        THEN account_arguments[8] ELSE account_arguments[6] END,
      block_time
    ) AS creator
  FROM pump_raw
  CROSS JOIN params
  WHERE (varbinary_starts_with(data, 0x181ec828051c0777) OR varbinary_starts_with(data, 0xd6904cec5f8b31b4))
    AND block_time >= params.launch_from
    AND block_time < params.launch_to
  GROUP BY 1
),
completes AS (
  -- One row per coin whose curve completed. CompleteEvent fields: user (bytes 17-48),
  -- mint (bytes 49-80). Positions are 1-based, as in bytearray_substring.
  SELECT
    to_base58(bytearray_substring(data, 49, 32)) AS mint,
    min(block_time) AS graduated_at
  FROM pump_raw
  WHERE varbinary_starts_with(data, 0xe445a52e51cb9a1d5f72619cd42e9808)
  GROUP BY 1
),
migrations AS (
  -- The PumpSwap pool made at graduation (March 2025 onwards). Event fields: mint at
  -- bytes 49-80, pool at bytes 145-176. Coins that went to Raydium have no row here.
  SELECT
    to_base58(bytearray_substring(data, 49, 32)) AS mint,
    min_by(to_base58(bytearray_substring(data, 145, 32)), block_time) AS pool
  FROM pump_raw
  WHERE varbinary_starts_with(data, 0xe445a52e51cb9a1dbde95db95c94ea94)
  GROUP BY 1
),
graduates AS (
  -- One row per graduated coin: created in the launch range, and graduated within
  -- window_days of creation. window_end is the last moment its trades are counted.
  SELECT
    c.mint,
    c.created_at,
    c.creator,
    g.graduated_at,
    m.pool AS migration_pool,
    date_add('day', {{window_days}}, c.created_at) AS window_end
  FROM creates c
  INNER JOIN completes g ON g.mint = c.mint
  LEFT JOIN migrations m ON m.mint = c.mint
  WHERE g.graduated_at >= c.created_at
    AND g.graduated_at < date_add('day', {{window_days}}, c.created_at)
),
coin_trades AS (
  -- Post-graduation trades of each graduated coin, on every venue in dex_solana.trades
  -- except the pump.fun curve. The coin is whichever side of the trade has the coin's
  -- mint, so the query is run once for the bought side and once for the sold side.
  -- Token amount = raw amount / 10^6 (every pump.fun coin has 6 decimals). The raw
  -- amount is used because the decimal-adjusted column is null when the mint is
  -- missing from tokens_solana.fungible. Rows with a null or zero USD amount or
  -- token amount are skipped.
  -- The partition column block_month limits the scan to the months from launch_from
  -- to launch_to + window_days; block_time then limits it to each coin's own window.
  SELECT
    g.mint,
    t.block_time,
    t.project,
    t.version,
    t.project_program_id AS pool_id,
    t.amount_usd AS usd,
    CAST(t.token_bought_amount_raw AS double) / 1000000 AS tokens
  FROM dex_solana.trades t
  INNER JOIN graduates g ON g.mint = t.token_bought_mint_address
  WHERE t.block_month >= CAST(date_trunc('month', CAST('{{launch_from}}' AS timestamp)) AS date)
    AND t.block_month <= CAST(date_trunc('month', date_add('day', {{window_days}}, CAST('{{launch_to}}' AS timestamp))) AS date)
    AND t.block_time >= g.graduated_at
    AND t.block_time < g.window_end
    AND t.project <> 'pumpdotfun'
    AND t.amount_usd > 0
    AND CAST(t.token_bought_amount_raw AS double) > 0
  UNION ALL
  SELECT
    g.mint,
    t.block_time,
    t.project,
    t.version,
    t.project_program_id AS pool_id,
    t.amount_usd AS usd,
    CAST(t.token_sold_amount_raw AS double) / 1000000 AS tokens
  FROM dex_solana.trades t
  INNER JOIN graduates g ON g.mint = t.token_sold_mint_address
  WHERE t.block_month >= CAST(date_trunc('month', CAST('{{launch_from}}' AS timestamp)) AS date)
    AND t.block_month <= CAST(date_trunc('month', date_add('day', {{window_days}}, CAST('{{launch_to}}' AS timestamp))) AS date)
    AND t.block_time >= g.graduated_at
    AND t.block_time < g.window_end
    AND t.project <> 'pumpdotfun'
    AND t.amount_usd > 0
    AND CAST(t.token_sold_amount_raw AS double) > 0
),
trade_stats AS (
  -- Per coin: how many counted trades, when the first and last were, and the pool of
  -- its first Raydium v4 trade (used as the graduation pool for Raydium-era coins).
  SELECT
    mint,
    count(*) AS trade_count,
    min(block_time) AS first_trade_at,
    max(block_time) AS last_trade_at,
    min_by(pool_id, block_time) FILTER (WHERE project = 'raydium' AND version = 4) AS raydium_pool
  FROM coin_trades
  GROUP BY 1
),
rough_peak AS (
  -- THE ROUGH-PEAK RULE. Same text in sizing.sql, candidates.sql and sample.sql.
  -- 1-minute buckets of a coin's post-graduation trades. A bucket counts when it has
  -- at least $1,000 of volume and at least 3 trades. Bucket price = USD volume / token
  -- volume. Rough peak = highest counting bucket price * 1,000,000,000 (fixed supply).
  SELECT
    mint,
    max(bucket_price_usd) * 1000000000 AS rough_peak_usd,
    max_by(bucket_minute, bucket_price_usd) AS rough_peak_at
  FROM (
    SELECT
      mint,
      date_trunc('minute', block_time) AS bucket_minute,
      sum(usd) / sum(tokens) AS bucket_price_usd
    FROM coin_trades
    GROUP BY 1, 2
    HAVING sum(usd) >= 1000 AND count(*) >= 3
  )
  GROUP BY 1
),
coin_rows AS (
  -- One row per graduated coin with every output column. A coin with no counting
  -- bucket has a null rough peak.
  SELECT
    g.mint,
    g.created_at,
    g.creator,
    g.graduated_at,
    COALESCE(g.migration_pool, s.raydium_pool) AS graduation_pool,
    CASE
      WHEN g.migration_pool IS NOT NULL THEN 'pumpswap'
      WHEN s.raydium_pool IS NOT NULL THEN 'raydium'
    END AS graduation_venue,
    p.rough_peak_usd,
    p.rough_peak_at,
    s.trade_count,
    s.first_trade_at,
    s.last_trade_at
  FROM graduates g
  LEFT JOIN rough_peak p ON p.mint = g.mint
  LEFT JOIN trade_stats s ON s.mint = g.mint
)
SELECT
  mint,
  created_at,
  creator,
  graduated_at,
  graduation_pool,
  graduation_venue,
  rough_peak_usd,
  rough_peak_at,
  trade_count,
  first_trade_at,
  last_trade_at
FROM coin_rows
WHERE rough_peak_usd >= {{min_peak_usd}}
ORDER BY rough_peak_usd DESC, mint
