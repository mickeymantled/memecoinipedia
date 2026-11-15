-- below-floor-sample.sql: graduates under the $30,000 backfill floor (issue #40). About 120 coins
-- with an hourly peak under $30k, in three cells (0-10k, 10k-20k, 20k-30k) by six launch
-- half-years (7, 7 and 6 coins per half-year), plus 30 coins with no hourly price at all (cell
-- `no-price`, up to 30 per half-year; only 2026-H2 has any, so 30 in all). Same source tables, same hourly peak and same fixed order (SHA-256
-- of the mint) as sample.sql. `cell_size` counts the coins in that cell and half-year, for weighting.
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
  -- Creation: the CreateEvent (complete from May 2024), plus the create call for January to April 2024.
  SELECT mint, min(t) AS created_at, min_by(creator, t) AS creator
  FROM (
    SELECT mint, evt_block_time AS t, coalesce(creator, "user") AS creator
    FROM pumpdotfun_solana.pump_evt_createevent
    UNION ALL
    SELECT account_mint AS mint, call_block_time AS t, account_user AS creator
    FROM pumpdotfun_solana.pump_call_create
    WHERE call_block_date < DATE '2024-05-01'
  ) y
  WHERE mint IS NOT NULL
  GROUP BY 1
),
coins AS (
  SELECT g.mint, c.created_at, c.creator, g.graduated_at
  FROM grads g
  INNER JOIN creates c ON c.mint = g.mint
),
disc AS (
  SELECT
    k.mint,
    arbitrary(k.created_at) AS created_at,
    arbitrary(k.creator) AS creator,
    arbitrary(k.graduated_at) AS graduated_at,
    count(p.hour) AS hours,
    max(p.price) * 1e9 AS peak_max_usd,
    approx_percentile(p.price, 0.999) * 1e9 AS peak_p999_usd,
    max_by(p.hour, p.price) AS peak_at,
    max(p.hour) AS last_hour
  FROM dex_solana.price_hour p
  RIGHT JOIN coins k
    ON k.mint = p.contract_address
    AND p.block_month >= DATE '2024-01-01'
    -- The table holds some infinite and absurd prices. 1,000 USD per coin would be a market cap
    -- of a trillion dollars, so anything at or above it is a bad print.
    AND is_finite(p.price)
    AND p.price > 0
    AND p.price < 1000
  GROUP BY k.mint
)

, labelled AS (
  SELECT
    d.*,
    CAST(year(created_at) AS varchar) || '-H' || CAST(IF(month(created_at) <= 6, 1, 2) AS varchar) AS half_year,
    CASE
      WHEN hours = 0 OR peak_p999_usd IS NULL THEN 'no-price'
      WHEN peak_p999_usd >= 30000 THEN NULL
      WHEN peak_p999_usd >= 20000 THEN '20k-30k'
      WHEN peak_p999_usd >= 10000 THEN '10k-20k'
      ELSE '0-10k'
    END AS cell
  FROM disc d
  WHERE created_at >= TIMESTAMP '2024-01-01 00:00:00 UTC'
    AND created_at < TIMESTAMP '2027-01-01 00:00:00 UTC'
),
ranked AS (
  SELECT
    l.*,
    row_number() OVER (PARTITION BY half_year, cell ORDER BY sha256(to_utf8(mint)), mint) AS rn,
    count(*) OVER (PARTITION BY half_year, cell) AS cell_size
  FROM labelled l
  WHERE cell IS NOT NULL
)
SELECT
  mint,
  half_year,
  cell,
  false AS probe,
  cell_size,
  CAST(to_unixtime(created_at) AS bigint) AS created_at,
  creator,
  CAST(to_unixtime(graduated_at) AS bigint) AS graduated_at,
  hours,
  CAST(round(peak_max_usd) AS bigint) AS peak_max_usd,
  CAST(round(peak_p999_usd) AS bigint) AS peak_p999_usd,
  CAST(to_unixtime(peak_at) AS bigint) AS peak_at
FROM ranked
WHERE rn <= CASE cell
  WHEN '0-10k' THEN 7
  WHEN '10k-20k' THEN 7
  WHEN '20k-30k' THEN 6
  WHEN 'no-price' THEN 30
END
ORDER BY half_year, cell, rn
