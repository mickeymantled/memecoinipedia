-- sample.sql: the Phase A sample, at most 500 rows. The 20 probe coins from
-- probes/coins.json, plus 480 coins drawn by quota from each launch half-year.
--
-- NOT YET RUN. No Dune key existed when this was written, so no part of this query
-- has been executed. Table and column names are checked against Dune's docs and the
-- Spellbook source only (see README.md). Measure it on a one-week slice first.
--
-- Returns: the candidates.sql columns (mint, created_at, creator, graduated_at,
-- graduation_pool, graduation_venue, rough_peak_usd, rough_peak_at, trade_count,
-- first_trade_at, last_trade_at) followed by three extra columns:
--   half_year (for example 2025-H1), sample_cell (which quota cell, or 'probe'),
--   is_probe (true for the 20 probes).
--
-- Quota per half-year (a coin's cell comes from its rough peak market cap):
--   $50k to $100k  10   (near misses)
--   $100k to $1M   35
--   $1M to $10M    20
--   $10M and above 15
-- A cell with too few coins takes all it has; the shortfall goes to the $100k to $1M
-- cell of the same half-year. Order inside a cell: xxhash64 of the mint, then the mint.
-- Same inputs give the same rows. Six half-years (2024-H1 to 2026-H2) at 80 each is 480.
--
-- Parameters (set the type and default in Dune's parameter box):
--   {{launch_from}}  date    default 2024-01-01 00:00:00   first launch counted
--   {{launch_to}}    date    default 2027-01-01 00:00:00   launch end, exclusive
--   {{window_days}}  number  default 90                    days after creation in which a coin
--                                                          must graduate and its trades count
-- A probe is only found if it was created inside the launch range. Run the full default
-- range for the real sample. The probes' creation dates run from April 2024 to 2026.
--
-- Expected result: at most 500 rows, about 150 KB.
-- Expected scan: the largest of the five queries, because the quota draw needs the rough
-- peak of every graduate in the range: about 3 years of dex_solana.trades for graduated
-- coins. Unknown until run. First run: launch_from 2025-06-01, launch_to 2025-06-08,
-- window_days 7 (it returns the probes, with nulls, plus the few coins of that week).
WITH params AS (
  -- Dune replaces each double-brace parameter with its value before the query runs.
  SELECT
    CAST('{{launch_from}}' AS timestamp) AS launch_from,  -- first launch time counted (inclusive)
    CAST('{{launch_to}}' AS timestamp) AS launch_to       -- last launch time counted (exclusive)
),
pump_raw AS (
  -- One scan of the pump.fun program's instructions, keeping only four kinds of row:
  --   create / create_v2 (the instruction that makes the coin),
  --   CompleteEvent (the curve is full, the coin is "graduated"),
  --   CompletePumpAmmMigrationEvent (the PumpSwap pool made at graduation).
  -- The two events are inner "event CPI" instructions: data = 8-byte event tag
  -- 0xe445a52e51cb9a1d, then the 8-byte event discriminator, then the fields.
  -- The scan runs from launch_from to launch_to + window_days, because a coin can
  -- graduate after the end of the launch range.
  SELECT
    block_time,
    data,
    account_arguments
  FROM solana.instruction_calls
  WHERE executing_account = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
    AND executing_account_prefix = '6E'
    AND tx_success = true
    AND block_date >= CAST(CAST('{{launch_from}}' AS timestamp) AS date)
    AND block_date <= CAST(date_add('day', {{window_days}}, CAST('{{launch_to}}' AS timestamp)) AS date)
    AND block_time >= CAST('{{launch_from}}' AS timestamp)
    AND block_time < date_add('day', {{window_days}}, CAST('{{launch_to}}' AS timestamp))
    AND (
      varbinary_starts_with(data, 0x181ec828051c0777)                    -- create
      OR varbinary_starts_with(data, 0xd6904cec5f8b31b4)                 -- create_v2
      OR varbinary_starts_with(data, 0xe445a52e51cb9a1d5f72619cd42e9808) -- CompleteEvent
      OR varbinary_starts_with(data, 0xe445a52e51cb9a1dbde95db95c94ea94) -- CompletePumpAmmMigrationEvent
    )
),
creates AS (
  -- One row per coin created in the launch range. Mint is account 1 of both create
  -- instructions. The creator wallet is the "user" account (8th account of create,
  -- 6th of create_v2).
  SELECT
    account_arguments[1] AS mint,
    min(block_time) AS created_at,
    min_by(
      CASE WHEN varbinary_starts_with(data, 0x181ec828051c0777)
        THEN account_arguments[8] ELSE account_arguments[6] END,
      block_time
    ) AS creator
  FROM pump_raw
  CROSS JOIN params
  WHERE (varbinary_starts_with(data, 0x181ec828051c0777) OR varbinary_starts_with(data, 0xd6904cec5f8b31b4))
    AND block_time >= params.launch_from
    AND block_time < params.launch_to
  GROUP BY 1
),
completes AS (
  -- One row per coin whose curve completed. CompleteEvent fields: user (bytes 17-48),
  -- mint (bytes 49-80). Positions are 1-based, as in bytearray_substring.
  SELECT
    to_base58(bytearray_substring(data, 49, 32)) AS mint,
    min(block_time) AS graduated_at
  FROM pump_raw
  WHERE varbinary_starts_with(data, 0xe445a52e51cb9a1d5f72619cd42e9808)
  GROUP BY 1
),
migrations AS (
  -- The PumpSwap pool made at graduation (March 2025 onwards). Event fields: mint at
  -- bytes 49-80, pool at bytes 145-176. Coins that went to Raydium have no row here.
  SELECT
    to_base58(bytearray_substring(data, 49, 32)) AS mint,
    min_by(to_base58(bytearray_substring(data, 145, 32)), block_time) AS pool
  FROM pump_raw
  WHERE varbinary_starts_with(data, 0xe445a52e51cb9a1dbde95db95c94ea94)
  GROUP BY 1
),
graduates AS (
  -- One row per graduated coin: created in the launch range, and graduated within
  -- window_days of creation. window_end is the last moment its trades are counted.
  SELECT
    c.mint,
    c.created_at,
    c.creator,
    g.graduated_at,
    m.pool AS migration_pool,
    date_add('day', {{window_days}}, c.created_at) AS window_end
  FROM creates c
  INNER JOIN completes g ON g.mint = c.mint
  LEFT JOIN migrations m ON m.mint = c.mint
  WHERE g.graduated_at >= c.created_at
    AND g.graduated_at < date_add('day', {{window_days}}, c.created_at)
),
coin_trades AS (
  -- Post-graduation trades of each graduated coin, on every venue in dex_solana.trades
  -- except the pump.fun curve. The coin is whichever side of the trade has the coin's
  -- mint, so the query is run once for the bought side and once for the sold side.
  -- Token amount = raw amount / 10^6 (every pump.fun coin has 6 decimals). The raw
  -- amount is used because the decimal-adjusted column is null when the mint is
  -- missing from tokens_solana.fungible. Rows with a null or zero USD amount or
  -- token amount are skipped.
  -- The partition column block_month limits the scan to the months from launch_from
  -- to launch_to + window_days; block_time then limits it to each coin's own window.
  SELECT
    g.mint,
    t.block_time,
    t.project,
    t.version,
    t.project_program_id AS pool_id,
    t.amount_usd AS usd,
    CAST(t.token_bought_amount_raw AS double) / 1000000 AS tokens
  FROM dex_solana.trades t
  INNER JOIN graduates g ON g.mint = t.token_bought_mint_address
  WHERE t.block_month >= CAST(date_trunc('month', CAST('{{launch_from}}' AS timestamp)) AS date)
    AND t.block_month <= CAST(date_trunc('month', date_add('day', {{window_days}}, CAST('{{launch_to}}' AS timestamp))) AS date)
    AND t.block_time >= g.graduated_at
    AND t.block_time < g.window_end
    AND t.project <> 'pumpdotfun'
    AND t.amount_usd > 0
    AND CAST(t.token_bought_amount_raw AS double) > 0
  UNION ALL
  SELECT
    g.mint,
    t.block_time,
    t.project,
    t.version,
    t.project_program_id AS pool_id,
    t.amount_usd AS usd,
    CAST(t.token_sold_amount_raw AS double) / 1000000 AS tokens
  FROM dex_solana.trades t
  INNER JOIN graduates g ON g.mint = t.token_sold_mint_address
  WHERE t.block_month >= CAST(date_trunc('month', CAST('{{launch_from}}' AS timestamp)) AS date)
    AND t.block_month <= CAST(date_trunc('month', date_add('day', {{window_days}}, CAST('{{launch_to}}' AS timestamp))) AS date)
    AND t.block_time >= g.graduated_at
    AND t.block_time < g.window_end
    AND t.project <> 'pumpdotfun'
    AND t.amount_usd > 0
    AND CAST(t.token_sold_amount_raw AS double) > 0
),
trade_stats AS (
  -- Per coin: how many counted trades, when the first and last were, and the pool of
  -- its first Raydium v4 trade (used as the graduation pool for Raydium-era coins).
  SELECT
    mint,
    count(*) AS trade_count,
    min(block_time) AS first_trade_at,
    max(block_time) AS last_trade_at,
    min_by(pool_id, block_time) FILTER (WHERE project = 'raydium' AND version = 4) AS raydium_pool
  FROM coin_trades
  GROUP BY 1
),
rough_peak AS (
  -- THE ROUGH-PEAK RULE. Same text in sizing.sql, candidates.sql and sample.sql.
  -- 1-minute buckets of a coin's post-graduation trades. A bucket counts when it has
  -- at least $1,000 of volume and at least 3 trades. Bucket price = USD volume / token
  -- volume. Rough peak = highest counting bucket price * 1,000,000,000 (fixed supply).
  SELECT
    mint,
    max(bucket_price_usd) * 1000000000 AS rough_peak_usd,
    max_by(bucket_minute, bucket_price_usd) AS rough_peak_at
  FROM (
    SELECT
      mint,
      date_trunc('minute', block_time) AS bucket_minute,
      sum(usd) / sum(tokens) AS bucket_price_usd
    FROM coin_trades
    GROUP BY 1, 2
    HAVING sum(usd) >= 1000 AND count(*) >= 3
  )
  GROUP BY 1
),
coin_rows AS (
  -- One row per graduated coin with every output column. A coin with no counting
  -- bucket has a null rough peak.
  SELECT
    g.mint,
    g.created_at,
    g.creator,
    g.graduated_at,
    COALESCE(g.migration_pool, s.raydium_pool) AS graduation_pool,
    CASE
      WHEN g.migration_pool IS NOT NULL THEN 'pumpswap'
      WHEN s.raydium_pool IS NOT NULL THEN 'raydium'
    END AS graduation_venue,
    p.rough_peak_usd,
    p.rough_peak_at,
    s.trade_count,
    s.first_trade_at,
    s.last_trade_at
  FROM graduates g
  LEFT JOIN rough_peak p ON p.mint = g.mint
  LEFT JOIN trade_stats s ON s.mint = g.mint
),
probes AS (
  -- The 20 probe coins from probes/coins.json. Always returned, never counted against
  -- the quotas.
  SELECT mint
  FROM (VALUES
    ('9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump'), -- FARTCOIN
    ('2qEHjDLDLbuBgRYvsxhc5D6uDWAivNFZGan56P1tpump'), -- Pnut
    ('CzLSujWBLFsSjncfkh59rUFqvafWcY5tzedWJSuypump'), -- GOAT
    ('Df6yfrKC8kZE3KNkrHERKzAetSxbrWeniQfyJY4Jpump'), -- CHILLGUY
    ('82DC7kRHVwkVEuK8NjbrwDDqbfkTrQWXuCp4T6C9noie'), -- VANGOAT
    ('GjSNU94GKHHQ9ou9nFDDYsQnAx2oKATHsmHJTrhV5cQV'), -- NUT
    ('GACuDtvf7EboY8SMiNyGorpWPc6tvXhKT4FGbQ6PpjF'), -- Dog
    ('AWZ9wdUGjBPiYRAwGRTxrkX91amWZKmcfq91cwBPpump'), -- Pang
    ('copJmvZPQayNtCmaEMC9wGwQKvtw16PzHQEhesbsHsq'), -- COP
    ('FYs3kU6Q1jwRF5oQV6UvHgjyuuW3bGdz2iJD7JCNpump'), -- MM
    ('GhGFyCZB4EktM9raEQR7CCKdU84Zxcj5EXE3ZWd2pump'), -- CHILLDOG
    ('DRwRNuXGen2nmBKeXBdgd7zyNWAKgZkbjZubwQRepump'), -- Andrew
    ('DwpnoX1YvBSkRFUJyvgeYamptg7WEb3DvV315dAUpump'), -- dodge
    ('7LsX88bhz8KiFcEFQYcdP6xMRsiMYPUXgYMPZMUzpump'), -- DSG
    ('Fgp2JaPkmw6WaNqVcfm1RxHBi2VUJCToxfAEE2wCpump'), -- ROOM
    ('C8T9P27ABMvLHsRKEavFqa9etSsfw8EqkF2XkzT4pump'), -- WIZARD
    ('HfVxfzmAPWER3LQ8VbDcbch6ACchbpuyXv3ujgRtpump'), -- Rose
    ('GqmP8uGseERgZYa7NAvzNrFw9qbGzMM6YnpwWiH46TGX'), -- DUMACRATS
    ('5xczFwu1UcM2H66dn9VGTPHEyXEHYyC97DeWcrev19xC'), -- USOF
    ('9S8edqWxoWz5LYLnxWUmWBJnePg35WfdYQp7HQkUpump')  -- Goyim
  ) AS p(mint)
),
quotas AS (
  -- The quota table from the issue. A coin belongs to the cell whose range holds its
  -- rough peak: lower bound inclusive, upper bound exclusive.
  SELECT cell, peak_from, peak_to, quota
  FROM (VALUES
    ('1_near_miss_50k_100k', DOUBLE '50000',    DOUBLE '100000', 10),
    ('2_100k_1m',            DOUBLE '100000',   DOUBLE '1000000', 35),
    ('3_1m_10m',             DOUBLE '1000000',  DOUBLE '10000000', 20),
    ('4_10m_plus',           DOUBLE '10000000', DOUBLE '1000000000000000', 15)
  ) AS q(cell, peak_from, peak_to, quota)
),
eligible AS (
  -- Candidate coins (rough peak of $50k or more, not a probe) with their half-year and
  -- quota cell. Half-year is the half of the creation date, for example 2025-H2.
  SELECT
    r.mint,
    CAST(year(r.created_at) AS varchar) || '-H' || CAST(if(month(r.created_at) <= 6, 1, 2) AS varchar) AS half_year,
    q.cell
  FROM coin_rows r
  INNER JOIN quotas q ON r.rough_peak_usd >= q.peak_from AND r.rough_peak_usd < q.peak_to
  WHERE r.mint NOT IN (SELECT mint FROM probes)
),
ranked AS (
  -- Deterministic order inside each half-year and cell: by a hash of the mint, then the
  -- mint itself. There is no random function anywhere in this query.
  SELECT
    mint,
    half_year,
    cell,
    row_number() OVER (PARTITION BY half_year, cell ORDER BY xxhash64(to_utf8(mint)), mint) AS draw_rank,
    count(*) OVER (PARTITION BY half_year, cell) AS cell_available
  FROM eligible
),
cell_limits AS (
  -- How many coins each half-year and cell may take. A cell with fewer coins than its
  -- quota takes all it has (a cell with no coins counts as zero). The shortfall of the
  -- other cells is added to the quota of the $100k to $1M cell of the same half-year.
  SELECT
    h.half_year,
    q.cell,
    CASE
      WHEN q.cell = '2_100k_1m' THEN q.quota + sum(CASE WHEN q.cell <> '2_100k_1m' THEN greatest(q.quota - COALESCE(c.cell_available, 0), 0) ELSE 0 END)
                                                OVER (PARTITION BY h.half_year)
      ELSE q.quota
    END AS take_limit
  FROM (SELECT DISTINCT half_year FROM eligible) h
  CROSS JOIN quotas q
  LEFT JOIN (SELECT DISTINCT half_year, cell, cell_available FROM ranked) c
    ON c.half_year = h.half_year AND c.cell = q.cell
),
drawn AS (
  -- The coins drawn by quota: at most 10 + 35 + 20 + 15 per half-year, plus the fill.
  SELECT
    k.mint,
    k.half_year,
    k.cell AS sample_cell,
    false AS is_probe,
    xxhash64(to_utf8(k.mint)) AS draw_hash
  FROM ranked k
  INNER JOIN cell_limits l ON l.half_year = k.half_year AND l.cell = k.cell
  WHERE k.draw_rank <= l.take_limit
),
probe_rows AS (
  -- The probes. A probe the query cannot find (created outside the launch range, or not
  -- seen as graduated) is still returned, with null columns, so a gap is visible.
  SELECT
    p.mint,
    CAST(year(r.created_at) AS varchar) || '-H' || CAST(if(month(r.created_at) <= 6, 1, 2) AS varchar) AS half_year,
    'probe' AS sample_cell,
    true AS is_probe,
    xxhash64(to_utf8(p.mint)) AS draw_hash
  FROM probes p
  LEFT JOIN coin_rows r ON r.mint = p.mint
),
picked AS (
  SELECT mint, half_year, sample_cell, is_probe, draw_hash FROM drawn
  UNION ALL
  SELECT mint, half_year, sample_cell, is_probe, draw_hash FROM probe_rows
)
SELECT
  k.mint,
  r.created_at,
  r.creator,
  r.graduated_at,
  r.graduation_pool,
  r.graduation_venue,
  r.rough_peak_usd,
  r.rough_peak_at,
  r.trade_count,
  r.first_trade_at,
  r.last_trade_at,
  k.half_year,
  k.sample_cell,
  k.is_probe
FROM picked k
LEFT JOIN coin_rows r ON r.mint = k.mint
ORDER BY k.is_probe DESC, k.half_year, k.sample_cell, k.draw_hash, k.mint
