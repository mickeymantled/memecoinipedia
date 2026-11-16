-- curve-only-sizing.sql (issue #44): sizing.sql turned round. One row per launch month for the
-- coins that have a creation record and no graduation record: how many reached $100,000 on the
-- hourly price (price times one billion coins), and how many of those sit in the band a standard
-- bonding curve can produce (up to about $125,000) and how many above it. No parameters.
--
-- Why $125,000 is a line: on the standard curve a coin is worth at most about 411 SOL before it
-- graduates, about $121,000 at SOL's highest price. A never-graduated coin above about $125,000 is
-- not showing a curve price: a bad price row, a pool opened beside the curve, a graduation our
-- tables missed, or a launch on another quote coin. Those are counted apart.
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
  -- One row per never-graduated coin that has at least one hourly price. Only cheap aggregates:
  -- no percentile is computed per coin (see p100k below), because this side of the join is
  -- millions of coins, not the 347,000 graduates sizing.sql groups.
  SELECT
    k.mint,
    arbitrary(k.created_at) AS created_at,
    count(p.hour) AS hours,
    max(p.price) * 1e9 AS peak_max_usd,
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
)
SELECT
  date_format(date_trunc('month', k.created_at), '%Y-%m') AS launch_month,
  count(*) AS never_graduated,
  count(d.mint) AS with_price,
  -- Reached $100,000 by the plain maximum of the hourly price (max100k in sizing.sql).
  count_if(d.peak_max_usd >= 100000) AS max100k,
  -- Reached $100,000 by the 99.9th percentile (p100k in sizing.sql). The nearest-rank 99.9th
  -- percentile of n prices is at or above a line exactly when more than floor(n / 1000) of them
  -- are at or above it, so it is computed from the two counts and needs no per-coin percentile.
  -- (Integer division: bigint / bigint truncates.)
  count_if(d.hours_hi > d.hours / 1000) AS p100k,
  -- The plain-maximum group, split: the curve band, above it, and $1,000,000 or more (inside "above").
  count_if(d.peak_max_usd >= 100000 AND d.peak_max_usd < 125000) AS max_100k_to_125k,
  count_if(d.peak_max_usd >= 125000) AS max_above_125k,
  count_if(d.peak_max_usd >= 1000000) AS max_1m_plus,
  -- Of the plain-maximum group: exactly one hour at or above $100,000, and two or more.
  count_if(d.peak_max_usd >= 100000 AND d.hours_hi = 1) AS max100k_one_hour,
  count_if(d.peak_max_usd >= 100000 AND d.hours_hi >= 2) AS max100k_two_plus_hours
FROM nograd k
LEFT JOIN priced d ON d.mint = k.mint
GROUP BY 1
ORDER BY 1
