-- curve-only-sample.sql (issue #44): a sample by quota of never-graduated coins whose plain maximum
-- of the hourly price (times one billion coins) is $100,000 or more, to tell apart what the
-- curve-only count mixes: curve prices, bad price rows, graduations our rule misses, other quote
-- coins. Same method as sample.sql: quota per cell, order by the SHA-256 of the mint, no random
-- function. No parameters. At most 180 rows.
--
-- Cells: launch half-year (2024-H1 to 2026-H2) by `size` (band: $100,000 to under $125,000; mid:
-- $125,000 to under $1,000,000; high: $1,000,000 or more) by `hours_cell` (one: exactly one hour at or
-- above $100,000; two_plus: two or more). 5 coins a cell.
--
-- Columns: mint, created_at (epoch seconds), half_year, size, hours_cell, cell_coins (coins in the
-- cell in all), hours (hours with a price), hours_hi (hours at or above $100,000), peak_max_usd,
-- low_usd (lowest hourly price times one billion), peak_at (epoch seconds),
-- same_peak_hour (coins in this whole set, the coin itself included, whose peak is in the same
-- hour), quote_mint, is_mayhem_mode and token_program (from the creation event; null for a coin
-- known only from the create call, and quote_mint is null before 2026-05-21 on events too),
-- has_amm_pool (the mint is a base_mint in pump_amm_evt_createpoolevent), has_migration (the mint
-- is in pump_evt_completepumpammmigrationevent or in pump_call_migrate), and
-- cell_with_pool_or_migration (coins in the cell with either flag).
WITH grads AS (
  -- Graduation: the first CompleteEvent. The event table starts in April 2024; before that the
  -- migration withdraw call marks graduation (its mint column is decoded correctly up to May 2024).
  SELECT mint, min(t) AS graduated_at
  FROM (
    SELECT mint, evt_block_time AS t
    FROM pumpdotfun_solana.pump_evt_completeevent
    UNION ALL
    SELECT account_mint AS mint, call_block_time AS t
    FROM pumpdotfun_solana.pump_call_withdraw
    WHERE call_block_date < DATE '2024-06-01'
  ) x
  WHERE mint IS NOT NULL
  GROUP BY 1
),
creates AS (
  -- Creation: the CreateEvent (complete from May 2024), plus the create call for January to April
  -- 2024. The event's own columns are kept only from event rows (src = 0).
  SELECT
    mint,
    min(t) AS created_at,
    min_by(quote_mint, t) FILTER (WHERE src = 0) AS quote_mint,
    min_by(is_mayhem_mode, t) FILTER (WHERE src = 0) AS is_mayhem_mode,
    min_by(token_program, t) FILTER (WHERE src = 0) AS token_program
  FROM (
    SELECT mint, evt_block_time AS t, 0 AS src, quote_mint, is_mayhem_mode, token_program
    FROM pumpdotfun_solana.pump_evt_createevent
    UNION ALL
    SELECT
      account_mint AS mint,
      call_block_time AS t,
      1 AS src,
      CAST(NULL AS varchar) AS quote_mint,
      CAST(NULL AS boolean) AS is_mayhem_mode,
      CAST(NULL AS varchar) AS token_program
    FROM pumpdotfun_solana.pump_call_create
    WHERE call_block_date < DATE '2024-05-01'
  ) y
  WHERE mint IS NOT NULL
  GROUP BY 1
),
nograd AS (
  -- Created, never graduated: a creation record and no graduation record.
  SELECT c.mint, c.created_at, c.quote_mint, c.is_mayhem_mode, c.token_program
  FROM creates c
  LEFT JOIN grads g ON g.mint = c.mint
  WHERE g.mint IS NULL
),
priced AS (
  SELECT
    k.mint,
    arbitrary(k.created_at) AS created_at,
    arbitrary(k.quote_mint) AS quote_mint,
    arbitrary(k.is_mayhem_mode) AS is_mayhem_mode,
    arbitrary(k.token_program) AS token_program,
    count(p.hour) AS hours,
    max(p.price) * 1e9 AS peak_max_usd,
    min(p.price) * 1e9 AS low_usd,
    max_by(p.hour, p.price) AS peak_at,
    -- Hours at or above $100,000.
    count_if(p.price * 1e9 >= 100000) AS hours_hi
  FROM dex_solana.price_hour p
  INNER JOIN nograd k ON k.mint = p.contract_address
  WHERE p.block_month >= DATE '2024-01-01'
    -- The table holds some infinite and absurd prices. 1,000 USD per coin would be a market cap
    -- of a trillion dollars, so anything at or above it is a bad print.
    AND is_finite(p.price)
    AND p.price > 0
    AND p.price < 1000
  GROUP BY k.mint
),
labelled AS (
  -- Only the coins at $100,000 or more (a few tens of thousands), so the pool and migration
  -- look-ups below are against a small set.
  SELECT
    d.*,
    CAST(year(created_at) AS varchar) || '-H' || CAST(IF(month(created_at) <= 6, 1, 2) AS varchar) AS half_year,
    CASE
      WHEN peak_max_usd >= 1000000 THEN 'high'
      WHEN peak_max_usd >= 125000 THEN 'mid'
      ELSE 'band'
    END AS size,
    IF(hours_hi = 1, 'one', 'two_plus') AS hours_cell,
    d.mint IN (
      SELECT base_mint FROM pumpdotfun_solana.pump_amm_evt_createpoolevent WHERE base_mint IS NOT NULL
    ) AS has_amm_pool,
    (
      d.mint IN (
        SELECT mint FROM pumpdotfun_solana.pump_evt_completepumpammmigrationevent WHERE mint IS NOT NULL
      )
      OR d.mint IN (
        SELECT account_mint FROM pumpdotfun_solana.pump_call_migrate WHERE account_mint IS NOT NULL
      )
    ) AS has_migration
  FROM priced d
  WHERE peak_max_usd >= 100000
),
ranked AS (
  SELECT
    l.*,
    row_number() OVER (PARTITION BY half_year, size, hours_cell ORDER BY sha256(to_utf8(mint)), mint) AS rn,
    count(*) OVER (PARTITION BY half_year, size, hours_cell) AS cell_coins,
    sum(IF(has_amm_pool OR has_migration, 1, 0)) OVER (PARTITION BY half_year, size, hours_cell) AS cell_with_pool_or_migration,
    count(*) OVER (PARTITION BY peak_at) AS same_peak_hour
  FROM labelled l
)
SELECT
  mint,
  CAST(to_unixtime(created_at) AS bigint) AS created_at,
  half_year,
  size,
  hours_cell,
  cell_coins,
  hours,
  hours_hi,
  CAST(round(peak_max_usd) AS bigint) AS peak_max_usd,
  CAST(round(low_usd, 2) AS double) AS low_usd,
  CAST(to_unixtime(peak_at) AS bigint) AS peak_at,
  same_peak_hour,
  quote_mint,
  is_mayhem_mode,
  token_program,
  has_amm_pool,
  has_migration,
  cell_with_pool_or_migration
FROM ranked
WHERE created_at >= TIMESTAMP '2024-01-01 00:00:00 UTC'
  AND created_at < TIMESTAMP '2027-01-01 00:00:00 UTC'
  AND rn <= 5
ORDER BY half_year, size, hours_cell, rn
