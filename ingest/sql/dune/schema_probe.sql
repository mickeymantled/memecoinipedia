-- schema_probe.sql: lists the decoded pump.fun tables and their columns, so that
-- graduates.sql can use them instead of the raw-instruction scan.
--
-- NOT YET RUN. It reads only metadata, so it should cost almost nothing. It is the first
-- thing to run live.
--
-- HOW TO RUN: each statement below is run on its own (one statement per Dune query tab or
-- API call, no semicolon-separated batch). Statements are in two forms, A and B, because
-- Dune may refuse one of them. Run A1 and A2; if Dune refuses them, run B1 to B4 instead.
-- No parameters.
--
-- What we know: the schema pumpdotfun_solana exists and holds pump_call_create and
-- pump_call_withdraw (named in a published analysis,
-- https://seouldatalabs.substack.com/p/can-we-rescue-trapped-sol-from-pumpfun) and the
-- PumpSwap tables pump_amm_call_buy, pump_amm_call_sell, pump_amm_call_create_pool,
-- pump_amm_call_create_config, pump_amm_call_update_fee_config and pump_amm_evt_buyevent
-- (Spellbook, dbt_subprojects/solana/models/_sources.yml). Their columns are not documented.
--
-- What to read from the result, for graduates.sql:
--   create:     mint, creator or user account, block time
--   graduation: mint or bonding curve, block time
--   migration:  mint, pool
--
-- Expected result: A1 and B1 a few dozen rows; A2 and B2 to B4 a few hundred rows.

-- ============================== FORM A: information_schema ==============================

-- A1: every table in the schema.
SELECT
  table_name
FROM information_schema.tables
WHERE table_schema = 'pumpdotfun_solana'
ORDER BY table_name;

-- A2: columns and types of every table whose name contains create, complete, withdraw or migrat.
SELECT
  table_name,
  ordinal_position,
  column_name,
  data_type
FROM information_schema.columns
WHERE table_schema = 'pumpdotfun_solana'
  AND (
    lower(table_name) LIKE '%create%'
    OR lower(table_name) LIKE '%complete%'
    OR lower(table_name) LIKE '%withdraw%'
    OR lower(table_name) LIKE '%migrat%'
  )
ORDER BY table_name, ordinal_position;

-- ============================== FORM B: SHOW ==============================

-- B1: every table in the schema.
SHOW TABLES FROM pumpdotfun_solana;

-- B2: tables whose name contains create, complete, withdraw or migrat: run one statement
-- per pattern, each on its own, then SHOW COLUMNS for each table name that comes back.
-- B2a:
SHOW TABLES FROM pumpdotfun_solana LIKE '%complete%';
-- B2b:
SHOW TABLES FROM pumpdotfun_solana LIKE '%migrat%';

-- B3: columns and types of the two tables known to exist.
SHOW COLUMNS FROM pumpdotfun_solana.pump_call_create;

-- B4:
SHOW COLUMNS FROM pumpdotfun_solana.pump_call_withdraw;

-- B5, B6, ...: SHOW COLUMNS FROM pumpdotfun_solana.<name> for every complete or migrate
-- table that B2a and B2b return. The names are not known yet, so none is written here.
