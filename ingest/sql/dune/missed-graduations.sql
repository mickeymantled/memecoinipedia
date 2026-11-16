-- missed-graduations.sql (issue #44): checks the candidate list's own graduation rule against the
-- pool and migration records. No price table. One row per launch month:
--   never_graduated        coins with a creation record and no graduation by our rule
--   with_amm_pool          of those, the mint is a base_mint in pump_amm_evt_createpoolevent
--   with_migration         of those, the mint is in pump_evt_completepumpammmigrationevent or pump_call_migrate
--   with_either            of those, either of the two
--   graduates              coins with a creation record and a graduation by our rule (for scale)
--   graduates_with_either  of those, either of the two
-- No parameters.
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
pools AS (
  SELECT DISTINCT base_mint AS mint
  FROM pumpdotfun_solana.pump_amm_evt_createpoolevent
  WHERE base_mint IS NOT NULL
),
migrations AS (
  SELECT DISTINCT mint
  FROM (
    SELECT mint FROM pumpdotfun_solana.pump_evt_completepumpammmigrationevent
    UNION ALL
    SELECT account_mint AS mint FROM pumpdotfun_solana.pump_call_migrate
  ) z
  WHERE mint IS NOT NULL
)
SELECT
  date_format(date_trunc('month', c.created_at), '%Y-%m') AS launch_month,
  count_if(g.mint IS NULL) AS never_graduated,
  count_if(g.mint IS NULL AND p.mint IS NOT NULL) AS with_amm_pool,
  count_if(g.mint IS NULL AND m.mint IS NOT NULL) AS with_migration,
  count_if(g.mint IS NULL AND (p.mint IS NOT NULL OR m.mint IS NOT NULL)) AS with_either,
  count_if(g.mint IS NOT NULL) AS graduates,
  count_if(g.mint IS NOT NULL AND (p.mint IS NOT NULL OR m.mint IS NOT NULL)) AS graduates_with_either
FROM creates c
LEFT JOIN grads g ON g.mint = c.mint
LEFT JOIN pools p ON p.mint = c.mint
LEFT JOIN migrations m ON m.mint = c.mint
GROUP BY 1
ORDER BY 1
