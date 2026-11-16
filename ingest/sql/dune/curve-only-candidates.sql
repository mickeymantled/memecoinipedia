-- curve-only-candidates.sql (issue #102): the second candidate list. One row per pump.fun coin that
-- has a creation record and no graduation record, whose plain maximum of the hourly price (times
-- one billion coins) is under $1,000,000, and that is
--   * launched from 2025-11-01: at $50,000 or more at its maximum, or
--   * launched before that: at $80,000 or more at its maximum.
-- The rule is the lead's decision on issue #102; the counts it was sized on are in README section 8
-- (8,273 and 1,950 coins on 2026-11-16, about 10,200 in all). A plain maximum of $1,000,000 or more
-- is left out: those are bad rows in the hourly price table (README section 8, point 2).
-- No parameters. Times are epoch seconds (UTC).
--
-- Columns, in the order of discovery.sql (the candidate file of the graduates), with one more at
-- the end: mint, created_at, creator, graduated_at, hours, peak_max_usd, peak_p999_usd, peak_at,
-- last_hour, is_mayhem_mode.
--   * graduated_at is empty on every row (these coins never graduated). Dune writes it as <nil>.
--   * peak_p999_usd is the 99.9th percentile of the hourly prices times one billion, exactly as in
--     discovery.sql; the seed uses it as the rough ATH.
--   * is_mayhem_mode is the creation event's flag. Empty for a coin launched before the event
--     carried it (about May 2026) and for a coin known only from the create call (before 2024-05).
--
-- Built from curve-only-sizing.sql (same graduation and creation rules, same price filters). Two
-- steps, so that the percentile, which is costly per coin, is computed only for the candidates:
--   1. `peaks`: one cheap aggregate per never-graduated coin with a price (the shape that ran in
--      curve-only-sizing.sql and curve-only-sample.sql), then the rule, giving `cand`.
--   2. `disc`: the hourly prices of the candidates read again, with the percentile (the aggregate
--      of discovery.sql), their last hour and their peak hour.
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
  -- 2024. The creator is the event's creator, falling back to its user (as in discovery.sql). The
  -- flag is kept only from event rows (src = 0), as in curve-only-sample.sql.
  SELECT
    mint,
    min(t) AS created_at,
    min_by(creator, t) AS creator,
    min_by(is_mayhem_mode, t) FILTER (WHERE src = 0) AS is_mayhem_mode
  FROM (
    SELECT mint, evt_block_time AS t, 0 AS src, coalesce(creator, "user") AS creator, is_mayhem_mode
    FROM pumpdotfun_solana.pump_evt_createevent
    UNION ALL
    SELECT
      account_mint AS mint,
      call_block_time AS t,
      1 AS src,
      account_user AS creator,
      CAST(NULL AS boolean) AS is_mayhem_mode
    FROM pumpdotfun_solana.pump_call_create
    WHERE call_block_date < DATE '2024-05-01'
  ) y
  WHERE mint IS NOT NULL
  GROUP BY 1
),
nograd AS (
  -- Created, never graduated: a creation record and no graduation record.
  SELECT c.mint, c.created_at, c.creator, c.is_mayhem_mode
  FROM creates c
  LEFT JOIN grads g ON g.mint = c.mint
  WHERE g.mint IS NULL
),
peaks AS (
  -- Step 1. One row per never-graduated coin that has at least one hourly price. Only cheap
  -- aggregates: no percentile here, because this side of the join is millions of coins.
  SELECT
    k.mint,
    arbitrary(k.created_at) AS created_at,
    arbitrary(k.creator) AS creator,
    arbitrary(k.is_mayhem_mode) AS is_mayhem_mode,
    max(p.price) * 1e9 AS peak_max_usd
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
cand AS (
  -- The candidate rule, on the plain maximum.
  SELECT mint, created_at, creator, is_mayhem_mode
  FROM peaks
  WHERE peak_max_usd < 1000000
    AND (
      (created_at >= TIMESTAMP '2025-11-01 00:00:00 UTC' AND peak_max_usd >= 50000)
      OR (created_at < TIMESTAMP '2025-11-01 00:00:00 UTC' AND peak_max_usd >= 80000)
    )
),
disc AS (
  -- Step 2. The candidates' hourly prices again, with the same three price filters, so that
  -- peak_max_usd here is the figure the rule was applied to.
  SELECT
    k.mint,
    arbitrary(k.created_at) AS created_at,
    arbitrary(k.creator) AS creator,
    arbitrary(k.is_mayhem_mode) AS is_mayhem_mode,
    count(p.hour) AS hours,
    max(p.price) * 1e9 AS peak_max_usd,
    approx_percentile(p.price, 0.999) * 1e9 AS peak_p999_usd,
    max_by(p.hour, p.price) AS peak_at,
    max(p.hour) AS last_hour
  FROM dex_solana.price_hour p
  INNER JOIN cand k ON k.mint = p.contract_address
  WHERE p.block_month >= DATE '2024-01-01'
    AND is_finite(p.price)
    AND p.price > 0
    AND p.price < 1000
  GROUP BY k.mint
)
SELECT
  mint,
  CAST(to_unixtime(created_at) AS bigint) AS created_at,
  creator,
  CAST(NULL AS bigint) AS graduated_at,
  hours,
  CAST(round(peak_max_usd) AS bigint) AS peak_max_usd,
  CAST(round(peak_p999_usd) AS bigint) AS peak_p999_usd,
  CAST(to_unixtime(peak_at) AS bigint) AS peak_at,
  CAST(to_unixtime(last_hour) AS bigint) AS last_hour,
  is_mayhem_mode
FROM disc
ORDER BY mint
