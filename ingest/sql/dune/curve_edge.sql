-- curve_edge.sql: coins that never graduated but whose bonding-curve price times
-- 1,000,000,000 reached {{min_peak_usd}}. Only the weeks when that was possible are scanned:
-- the weeks when SOL traded above about $243, because the end of the curve is about
-- 411 SOL of market cap and 411 SOL x $243 is $100k.
--
-- NOT YET RUN. No Dune key existed when this was written, so no part of this query
-- has been executed. Table and column names are checked against Dune's docs and the
-- Spellbook source only (see README.md). Measure it on a one-week slice first.
--
-- Returns (one row per coin, highest curve price first):
--   mint, curve_peak_usd (highest single curve trade price x 1e9), curve_peak_at,
--   curve_trade_count, first_curve_trade_at, last_curve_trade_at (all inside the
--   scanned ranges), coins_total (the count of rows in this result, repeated on every row).
--
-- Parameters (set the type and default in Dune's parameter box). The three ranges come
-- from Binance SOLUSDT daily candles; see README.md for how. From is inclusive, to is
-- exclusive. Each range has one day of padding on both sides.
--   {{range1_from}}   date    default 2024-11-17 00:00:00
--   {{range1_to}}     date    default 2024-12-09 00:00:00
--   {{range2_from}}   date    default 2025-01-17 00:00:00
--   {{range2_to}}     date    default 2025-01-31 00:00:00
--   {{range3_from}}   date    default 2025-09-11 00:00:00
--   {{range3_to}}     date    default 2025-09-21 00:00:00
--   {{min_peak_usd}}  number  default 100000
--   {{grad_check_days}} number default 30   how many days after the end of a range a
--                                           CompleteEvent still counts as "graduated"
--
-- Each table is read once: curve_trades is the only read of dex_solana.trades and
-- completes the only read of solana.instruction_calls; each block is referenced once.
--
-- Expected result: unknown; guess 10 to 500 rows, under 0.1 MB.
-- Expected scan: three short slices of dex_solana.trades, filtered to project
-- 'pumpdotfun', plus the pump.fun program's CompleteEvent rows for the same three
-- slices (plus grad_check_days). The trades part is the cheaper one in time but the
-- pump.fun curve is the busiest venue. First run: shrink range1 to one day.
WITH curve_trades AS (
  -- Curve trades inside the ranges. On the curve the quote side is always wrapped SOL
  -- (the Spellbook curve model hard-codes it), so the coin is the side whose mint is not
  -- wrapped SOL. Token amount = raw amount / 10^6. Rows with a null or zero USD amount
  -- or token amount are skipped, and so are trades under $1 (rounding noise in lamports).
  -- block_month limits the scan to the months of each range; block_time to the range.
  SELECT
    CASE WHEN t.token_bought_mint_address = 'So11111111111111111111111111111111111111112'
      THEN t.token_sold_mint_address ELSE t.token_bought_mint_address END AS mint,
    t.block_time,
    t.amount_usd AS usd,
    CAST(CASE WHEN t.token_bought_mint_address = 'So11111111111111111111111111111111111111112'
      THEN t.token_sold_amount_raw ELSE t.token_bought_amount_raw END AS double) / 1000000 AS tokens
  FROM dex_solana.trades t
  WHERE t.project = 'pumpdotfun'
    AND (
      (t.block_month >= CAST(date_trunc('month', CAST('{{range1_from}}' AS timestamp)) AS date)
        AND t.block_month <= CAST(date_trunc('month', CAST('{{range1_to}}' AS timestamp)) AS date)
        AND t.block_time >= CAST('{{range1_from}}' AS timestamp)
        AND t.block_time < CAST('{{range1_to}}' AS timestamp))
      OR
      (t.block_month >= CAST(date_trunc('month', CAST('{{range2_from}}' AS timestamp)) AS date)
        AND t.block_month <= CAST(date_trunc('month', CAST('{{range2_to}}' AS timestamp)) AS date)
        AND t.block_time >= CAST('{{range2_from}}' AS timestamp)
        AND t.block_time < CAST('{{range2_to}}' AS timestamp))
      OR
      (t.block_month >= CAST(date_trunc('month', CAST('{{range3_from}}' AS timestamp)) AS date)
        AND t.block_month <= CAST(date_trunc('month', CAST('{{range3_to}}' AS timestamp)) AS date)
        AND t.block_time >= CAST('{{range3_from}}' AS timestamp)
        AND t.block_time < CAST('{{range3_to}}' AS timestamp))
    )
    AND t.amount_usd >= 1
    AND CAST(t.token_bought_amount_raw AS double) > 0
    AND CAST(t.token_sold_amount_raw AS double) > 0
),
curve_peaks AS (
  -- Per coin: the highest single-trade curve price. The curve price is set by the curve
  -- itself, so a trade price is a real price. Keep coins at or above the threshold.
  SELECT
    mint,
    max(usd / tokens) * 1000000000 AS curve_peak_usd,
    max_by(block_time, usd / tokens) AS curve_peak_at,
    count(*) AS curve_trade_count,
    min(block_time) AS first_curve_trade_at,
    max(block_time) AS last_curve_trade_at
  FROM curve_trades
  GROUP BY 1
  HAVING max(usd / tokens) * 1000000000 >= {{min_peak_usd}}
),
completes AS (
  -- Coins whose curve completed (graduated), scanned over the same ranges, each
  -- extended by grad_check_days. CompleteEvent: mint at bytes 49-80.
  SELECT DISTINCT
    to_base58(bytearray_substring(data, 49, 32)) AS mint
  FROM solana.instruction_calls
  WHERE executing_account = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
    AND executing_account_prefix = '6E'
    AND tx_success = true
    AND varbinary_starts_with(data, 0xe445a52e51cb9a1d5f72619cd42e9808)
    AND (
      (block_date >= CAST(CAST('{{range1_from}}' AS timestamp) AS date)
        AND block_date <= CAST(date_add('day', {{grad_check_days}}, CAST('{{range1_to}}' AS timestamp)) AS date)
        AND block_time >= CAST('{{range1_from}}' AS timestamp)
        AND block_time < date_add('day', {{grad_check_days}}, CAST('{{range1_to}}' AS timestamp)))
      OR
      (block_date >= CAST(CAST('{{range2_from}}' AS timestamp) AS date)
        AND block_date <= CAST(date_add('day', {{grad_check_days}}, CAST('{{range2_to}}' AS timestamp)) AS date)
        AND block_time >= CAST('{{range2_from}}' AS timestamp)
        AND block_time < date_add('day', {{grad_check_days}}, CAST('{{range2_to}}' AS timestamp)))
      OR
      (block_date >= CAST(CAST('{{range3_from}}' AS timestamp) AS date)
        AND block_date <= CAST(date_add('day', {{grad_check_days}}, CAST('{{range3_to}}' AS timestamp)) AS date)
        AND block_time >= CAST('{{range3_from}}' AS timestamp)
        AND block_time < date_add('day', {{grad_check_days}}, CAST('{{range3_to}}' AS timestamp)))
    )
)
SELECT
  p.mint,
  p.curve_peak_usd,
  p.curve_peak_at,
  p.curve_trade_count,
  p.first_curve_trade_at,
  p.last_curve_trade_at,
  count(*) OVER () AS coins_total
FROM curve_peaks p
LEFT JOIN completes c ON c.mint = p.mint
WHERE c.mint IS NULL
ORDER BY p.curve_peak_usd DESC, p.mint
