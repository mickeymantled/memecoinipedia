-- sample.sql: the Phase A sample. The 20 probe coins, plus a draw by quota from each launch
-- half-year and hourly-peak cell, ordered by the SHA-256 of the mint (no random function).
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
      WHEN peak_p999_usd >= 10000000 THEN '10M+'
      WHEN peak_p999_usd >= 1000000 THEN '1M-10M'
      WHEN peak_p999_usd >= 100000 THEN '100k-1M'
      WHEN peak_p999_usd >= 50000 THEN '50k-100k'
      WHEN peak_p999_usd >= 30000 THEN '30k-50k'
    END AS cell,
    mint IN (
    '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump',
    '2qEHjDLDLbuBgRYvsxhc5D6uDWAivNFZGan56P1tpump',
    'CzLSujWBLFsSjncfkh59rUFqvafWcY5tzedWJSuypump',
    'Df6yfrKC8kZE3KNkrHERKzAetSxbrWeniQfyJY4Jpump',
    '82DC7kRHVwkVEuK8NjbrwDDqbfkTrQWXuCp4T6C9noie',
    'GjSNU94GKHHQ9ou9nFDDYsQnAx2oKATHsmHJTrhV5cQV',
    'GACuDtvf7EboY8SMiNyGorpWPc6tvXhKT4FGbQ6PpjF',
    'AWZ9wdUGjBPiYRAwGRTxrkX91amWZKmcfq91cwBPpump',
    'copJmvZPQayNtCmaEMC9wGwQKvtw16PzHQEhesbsHsq',
    'FYs3kU6Q1jwRF5oQV6UvHgjyuuW3bGdz2iJD7JCNpump',
    'GhGFyCZB4EktM9raEQR7CCKdU84Zxcj5EXE3ZWd2pump',
    'DRwRNuXGen2nmBKeXBdgd7zyNWAKgZkbjZubwQRepump',
    'DwpnoX1YvBSkRFUJyvgeYamptg7WEb3DvV315dAUpump',
    '7LsX88bhz8KiFcEFQYcdP6xMRsiMYPUXgYMPZMUzpump',
    'Fgp2JaPkmw6WaNqVcfm1RxHBi2VUJCToxfAEE2wCpump',
    'C8T9P27ABMvLHsRKEavFqa9etSsfw8EqkF2XkzT4pump',
    'HfVxfzmAPWER3LQ8VbDcbch6ACchbpuyXv3ujgRtpump',
    'GqmP8uGseERgZYa7NAvzNrFw9qbGzMM6YnpwWiH46TGX',
    '5xczFwu1UcM2H66dn9VGTPHEyXEHYyC97DeWcrev19xC',
    '9S8edqWxoWz5LYLnxWUmWBJnePg35WfdYQp7HQkUpump'
    ) AS probe
  FROM disc d
),
ranked AS (
  SELECT
    l.*,
    row_number() OVER (PARTITION BY half_year, cell, probe ORDER BY sha256(to_utf8(mint)), mint) AS rn,
    count(*) OVER (PARTITION BY half_year, cell, probe) AS cell_size
  FROM labelled l
)
SELECT
  mint,
  half_year,
  cell,
  probe,
  cell_size,
  CAST(to_unixtime(created_at) AS bigint) AS created_at,
  creator,
  CAST(to_unixtime(graduated_at) AS bigint) AS graduated_at,
  hours,
  CAST(round(peak_max_usd) AS bigint) AS peak_max_usd,
  CAST(round(peak_p999_usd) AS bigint) AS peak_p999_usd,
  CAST(to_unixtime(peak_at) AS bigint) AS peak_at
FROM ranked
WHERE probe
   OR (
     created_at >= TIMESTAMP '2024-01-01 00:00:00 UTC'
     AND created_at < TIMESTAMP '2027-01-01 00:00:00 UTC'
     AND rn <= CASE cell
       WHEN '30k-50k' THEN 5
       WHEN '50k-100k' THEN 10
       WHEN '100k-1M' THEN 30
       WHEN '1M-10M' THEN 20
       WHEN '10M+' THEN 15
       ELSE 0
     END
   )
ORDER BY probe DESC, half_year, cell, rn
