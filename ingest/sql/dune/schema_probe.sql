-- schema_probe.sql: the metadata and coverage statements that worked on Dune on 2026-11-15.
-- Each statement is run on its own (one per query or API call, not as a batch).
-- NOT part of the discovery path: they document how the tables and columns in README.md were
-- checked, and they can be re-run to check that nothing has changed.
--
-- What did not work: SHOW COLUMNS and information_schema.columns return nothing for the decoded
-- pumpdotfun_solana tables. SELECT * ... LIMIT 0 returns the column names and types in the result
-- metadata instead.
--
-- Cost, measured: statement 1 about 0.02 credits; each LIMIT 0 statement (2 to 6) about 0.03 credits;
-- coverage statements 7 to 10 a few credits each at most (not measured one by one).

-- 1. The tables of the schema (116 on 2026-11-15).
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'pumpdotfun_solana'
ORDER BY table_name;

-- 2. Column names and types of pumpdotfun_solana.pump_evt_completeevent.
SELECT * FROM pumpdotfun_solana.pump_evt_completeevent LIMIT 0;

-- 3. Column names and types of pumpdotfun_solana.pump_call_withdraw.
SELECT * FROM pumpdotfun_solana.pump_call_withdraw LIMIT 0;

-- 4. Column names and types of pumpdotfun_solana.pump_evt_createevent.
SELECT * FROM pumpdotfun_solana.pump_evt_createevent LIMIT 0;

-- 5. Column names and types of pumpdotfun_solana.pump_call_create.
SELECT * FROM pumpdotfun_solana.pump_call_create LIMIT 0;

-- 6. Column names and types of dex_solana.price_hour.
SELECT * FROM dex_solana.price_hour LIMIT 0;

-- 7. Graduation events per month, with the count of events that have a null mint or a quote other than SOL.
SELECT
  date_trunc('month', evt_block_date) AS month,
  count(*) AS events,
  count(DISTINCT mint) AS mints,
  count_if(mint IS NULL) AS null_mint,
  count_if(quote_mint IS NOT NULL AND quote_mint <> 'So11111111111111111111111111111111111111112') AS non_sol_quote
FROM pumpdotfun_solana.pump_evt_completeevent
GROUP BY 1
ORDER BY 1;

-- 8. Withdraw, migrate and migrate_v2 calls per month.
SELECT 'withdraw' AS src, date_trunc('month', call_block_date) AS month, count(*) AS n, count(DISTINCT account_mint) AS mints
FROM pumpdotfun_solana.pump_call_withdraw GROUP BY 1, 2
UNION ALL
SELECT 'migrate', date_trunc('month', call_block_date), count(*), count(DISTINCT account_mint)
FROM pumpdotfun_solana.pump_call_migrate GROUP BY 1, 2
UNION ALL
SELECT 'migrate_v2', date_trunc('month', call_block_date), count(*), CAST(NULL AS bigint)
FROM pumpdotfun_solana.pump_call_migrate_v2 GROUP BY 1, 2
ORDER BY 1, 2;

-- 9. Create events and create calls per month.
SELECT 'evt_create' AS src, date_trunc('month', evt_block_date) AS month, count(*) AS n
FROM pumpdotfun_solana.pump_evt_createevent GROUP BY 1, 2
UNION ALL
SELECT 'call_create', date_trunc('month', call_block_date), count(*)
FROM pumpdotfun_solana.pump_call_create GROUP BY 1, 2
UNION ALL
SELECT 'call_create_v2', date_trunc('month', call_block_date), count(*)
FROM pumpdotfun_solana.pump_call_create_v2 GROUP BY 1, 2
ORDER BY 2, 1;

-- 10. Token supply, token program, mayhem mode and quote mint of create events, per quarter.
SELECT
  date_format(date_trunc('quarter', evt_block_date), '%Y-%m') AS quarter,
  CAST(token_total_supply AS varchar) AS supply_raw,
  is_mayhem_mode,
  token_program,
  CASE
    WHEN quote_mint IS NULL THEN 'null'
    WHEN quote_mint = '11111111111111111111111111111111' THEN 'SOL'
    WHEN quote_mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' THEN 'USDC'
    ELSE 'other'
  END AS quote,
  count(*) AS coins
FROM pumpdotfun_solana.pump_evt_createevent
GROUP BY 1, 2, 3, 4, 5
ORDER BY 1, 6 DESC;
