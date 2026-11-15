-- sizing.sql: how many pump.fun coins were created and graduated each launch month,
-- how many graduates had a rough peak of $50k / $80k / $100k / $125k / $1M / $10M /
-- $100M or more, and how many trades and active days the $100k-or-more coins have.
--
-- NOT YET RUN. No Dune key existed when this was written, so no part of this query
-- has been executed. Table and column names are checked against Dune's docs and the
-- Spellbook source only (see README.md). Measure it on a one-week slice first.
--
-- Returns: one row per launch month (month of the create instruction).
--   launch_month, coins_created, coins_graduated,
--   peak_ge_50k, peak_ge_80k, peak_ge_100k, peak_ge_125k, peak_ge_1m, peak_ge_10m, peak_ge_100m,
--   trades_p50, trades_p90, trades_p99, trades_max,                  (coins with peak >= $100k)
--   active_days_p50, active_days_p90, active_days_p99, active_days_max  (days from first to last
--                                                                         counted trade, same coins)
-- A "peak" here is the rough peak market cap in USD (rule in the rough_peak CTE).
-- Trades and active days only count trades inside the coin's window (window_days).
--
-- Parameters (set the type and default in Dune's parameter box):
--   {{launch_from}}  date    default 2024-01-01 00:00:00   first launch counted
--   {{launch_to}}    date    default 2026-12-01 00:00:00   launch end, exclusive
--   {{window_days}}  number  default 90                    days after creation in which a coin
--                                                          must graduate and its trades count
--
-- Expected result: one row per month in the range, 35 rows by default, under 10 KB.
-- Expected scan: unknown until run. It reads the pump.fun program's instruction rows
-- (solana.instruction_calls) and dex_solana.trades for the months from launch_from to
-- launch_to + window_days. First run: launch_from 2025-06-01, launch_to 2025-06-08,
-- window_days 7. The result is then one or two rows.
--
-- Sizing must be run for the full range in slices of one to three months and the rows
-- appended, because a single full-range run reads about 3 years of trades.
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
per_coin AS (
  -- One row per graduated coin, with the numbers the summary needs.
  SELECT
    CAST(date_trunc('month', g.created_at) AS date) AS launch_month,
    p.rough_peak_usd,
    s.trade_count,
    date_diff('second', s.first_trade_at, s.last_trade_at) / 86400.0 AS active_days
  FROM graduates g
  LEFT JOIN rough_peak p ON p.mint = g.mint
  LEFT JOIN trade_stats s ON s.mint = g.mint
),
created_by_month AS (
  -- Coins created per launch month (graduated or not).
  SELECT
    CAST(date_trunc('month', created_at) AS date) AS launch_month,
    count(*) AS coins_created
  FROM creates
  GROUP BY 1
),
graduated_by_month AS (
  -- Graduates per launch month, split by rough peak, plus the $100k-or-more statistics.
  SELECT
    launch_month,
    count(*) AS coins_graduated,
    count_if(rough_peak_usd >= 50000) AS peak_ge_50k,
    count_if(rough_peak_usd >= 80000) AS peak_ge_80k,
    count_if(rough_peak_usd >= 100000) AS peak_ge_100k,
    count_if(rough_peak_usd >= 125000) AS peak_ge_125k,
    count_if(rough_peak_usd >= 1000000) AS peak_ge_1m,
    count_if(rough_peak_usd >= 10000000) AS peak_ge_10m,
    count_if(rough_peak_usd >= 100000000) AS peak_ge_100m,
    approx_percentile(trade_count, 0.5) FILTER (WHERE rough_peak_usd >= 100000) AS trades_p50,
    approx_percentile(trade_count, 0.9) FILTER (WHERE rough_peak_usd >= 100000) AS trades_p90,
    approx_percentile(trade_count, 0.99) FILTER (WHERE rough_peak_usd >= 100000) AS trades_p99,
    max(trade_count) FILTER (WHERE rough_peak_usd >= 100000) AS trades_max,
    approx_percentile(active_days, 0.5) FILTER (WHERE rough_peak_usd >= 100000) AS active_days_p50,
    approx_percentile(active_days, 0.9) FILTER (WHERE rough_peak_usd >= 100000) AS active_days_p90,
    approx_percentile(active_days, 0.99) FILTER (WHERE rough_peak_usd >= 100000) AS active_days_p99,
    max(active_days) FILTER (WHERE rough_peak_usd >= 100000) AS active_days_max
  FROM per_coin
  GROUP BY 1
)
SELECT
  c.launch_month,
  c.coins_created,
  COALESCE(g.coins_graduated, 0) AS coins_graduated,
  COALESCE(g.peak_ge_50k, 0) AS peak_ge_50k,
  COALESCE(g.peak_ge_80k, 0) AS peak_ge_80k,
  COALESCE(g.peak_ge_100k, 0) AS peak_ge_100k,
  COALESCE(g.peak_ge_125k, 0) AS peak_ge_125k,
  COALESCE(g.peak_ge_1m, 0) AS peak_ge_1m,
  COALESCE(g.peak_ge_10m, 0) AS peak_ge_10m,
  COALESCE(g.peak_ge_100m, 0) AS peak_ge_100m,
  g.trades_p50,
  g.trades_p90,
  g.trades_p99,
  g.trades_max,
  g.active_days_p50,
  g.active_days_p90,
  g.active_days_p99,
  g.active_days_max
FROM created_by_month c
LEFT JOIN graduated_by_month g ON g.launch_month = c.launch_month
ORDER BY c.launch_month
