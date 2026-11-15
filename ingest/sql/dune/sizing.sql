-- sizing.sql: one row per launch month: graduates, and how many reached each market cap by
-- the hourly peak (99.9th percentile of hourly prices times one billion). No parameters.
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
  date_format(date_trunc('month', created_at), '%Y-%m') AS launch_month,
  count(*) AS graduates,
  count_if(hours = 0) AS no_price,
  count_if(peak_p999_usd >= 30000) AS p30k,
  count_if(peak_p999_usd >= 50000) AS p50k,
  count_if(peak_p999_usd >= 80000) AS p80k,
  count_if(peak_p999_usd >= 100000) AS p100k,
  count_if(peak_p999_usd >= 125000) AS p125k,
  count_if(peak_p999_usd >= 250000) AS p250k,
  count_if(peak_p999_usd >= 1000000) AS p1m,
  count_if(peak_p999_usd >= 10000000) AS p10m,
  count_if(peak_p999_usd >= 100000000) AS p100m,
  count_if(peak_max_usd >= 30000) AS max30k,
  count_if(peak_max_usd >= 100000) AS max100k,
  approx_percentile(hours, 0.5) FILTER (WHERE peak_p999_usd >= 100000) AS hours_p50,
  approx_percentile(hours, 0.9) FILTER (WHERE peak_p999_usd >= 100000) AS hours_p90,
  approx_percentile(hours, 0.99) FILTER (WHERE peak_p999_usd >= 100000) AS hours_p99,
  max(hours) FILTER (WHERE peak_p999_usd >= 100000) AS hours_max,
  sum(hours) FILTER (WHERE peak_p999_usd >= 30000) AS hours_sum_30k
FROM disc
GROUP BY 1
ORDER BY 1
