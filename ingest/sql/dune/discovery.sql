-- discovery.sql: one row per pump.fun coin that graduated: creation data and the peak from
-- Dune's hourly price table. No parameters. Times are epoch seconds (UTC).
-- Optional filter, as the last line: WHERE peak_max_usd >= <floor>.
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
SELECT
  mint,
  CAST(to_unixtime(created_at) AS bigint) AS created_at,
  creator,
  CAST(to_unixtime(graduated_at) AS bigint) AS graduated_at,
  hours,
  CAST(round(peak_max_usd) AS bigint) AS peak_max_usd,
  CAST(round(peak_p999_usd) AS bigint) AS peak_p999_usd,
  CAST(to_unixtime(peak_at) AS bigint) AS peak_at,
  CAST(to_unixtime(last_hour) AS bigint) AS last_hour
FROM disc
