-- curve-only-top.sql (issue #44): real cases for curve-only-sizing.sql. At most 100 rows: the 50
-- largest never-graduated coins by the plain maximum of the hourly price (`grp` = 'largest'), and
-- the 50 largest of those whose maximum is from $100,000 up to but not including $125,000
-- (`grp` = 'band'). A coin in the band is in both lists. `rnk` is the place in its list.
-- Same source tables, graduation rule and price filters as sizing.sql. No parameters.
-- Times are epoch seconds (UTC), as in discovery.sql.
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
  SELECT mint, min(t) AS created_at
  FROM (
    SELECT mint, evt_block_time AS t
    FROM pumpdotfun_solana.pump_evt_createevent
    UNION ALL
    SELECT account_mint AS mint, call_block_time AS t
    FROM pumpdotfun_solana.pump_call_create
    WHERE call_block_date < DATE '2024-05-01'
  ) y
  WHERE mint IS NOT NULL
  GROUP BY 1
),
nograd AS (
  -- Created, never graduated: a creation record and no graduation record.
  SELECT c.mint, c.created_at
  FROM creates c
  LEFT JOIN grads g ON g.mint = c.mint
  WHERE g.mint IS NULL
),
priced AS (
  SELECT
    k.mint,
    arbitrary(k.created_at) AS created_at,
    count(p.hour) AS hours,
    max(p.price) * 1e9 AS peak_max_usd,
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
ranked AS (
  -- Both places are computed in one pass over the coins at $100,000 or more.
  SELECT
    mint,
    created_at,
    hours,
    peak_max_usd,
    peak_at,
    hours_hi,
    row_number() OVER (ORDER BY peak_max_usd DESC, mint) AS rn_all,
    row_number() OVER (PARTITION BY (peak_max_usd < 125000) ORDER BY peak_max_usd DESC, mint) AS rn_part
  FROM priced
  WHERE peak_max_usd >= 100000
)
SELECT
  g.grp,
  CASE WHEN g.grp = 'largest' THEN r.rn_all ELSE r.rn_part END AS rnk,
  r.mint,
  CAST(to_unixtime(r.created_at) AS bigint) AS created_at,
  CAST(round(r.peak_max_usd) AS bigint) AS peak_max_usd,
  CAST(to_unixtime(r.peak_at) AS bigint) AS peak_at,
  r.hours,
  r.hours_hi
FROM ranked r
CROSS JOIN (VALUES ('largest'), ('band')) AS g(grp)
WHERE (g.grp = 'largest' AND r.rn_all <= 50)
   OR (g.grp = 'band' AND r.peak_max_usd < 125000 AND r.rn_part <= 50)
ORDER BY g.grp, rnk
