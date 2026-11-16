-- Search and list indexes for the API (task C1). Forward-only; never edit once applied.
--
-- Every API query serves listed coins only: ath_market_cap_usd >= 100000. The
-- partial indexes below carry that predicate, so they stay small and the
-- planner can use them for every query (the API always writes the same
-- condition; keep the two in step: api/src/coins.ts LISTED_MIN_ATH_USD).
-- Each index here was kept because EXPLAIN ANALYZE on 300,000 synthetic rows
-- shows a query using it; see the pull request for C1.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Keyword search: trigram similarity on lower(ticker) and lower(name).
CREATE INDEX coins_listed_ticker_trgm_idx
  ON coins USING gin (lower(ticker) gin_trgm_ops)
  WHERE ath_market_cap_usd >= 100000;
CREATE INDEX coins_listed_name_trgm_idx
  ON coins USING gin (lower(name) gin_trgm_ops)
  WHERE ath_market_cap_usd >= 100000;
-- Exact and prefix ticker match (LIKE 'abc%').
CREATE INDEX coins_listed_ticker_prefix_idx
  ON coins (lower(ticker) text_pattern_ops)
  WHERE ath_market_cap_usd >= 100000;

-- Whole-address search. UNIQUE (chain, address) cannot serve it: the API
-- searches by address alone.
CREATE INDEX coins_listed_address_idx
  ON coins (address)
  WHERE ath_market_cap_usd >= 100000;

-- Narrative filter, narrative counts and the narrative ATH distributions
-- (rows arrive grouped by narrative and already sorted by ATH).
CREATE INDEX coins_listed_narrative_ath_idx
  ON coins (primary_narrative, ath_market_cap_usd, id)
  WHERE ath_market_cap_usd >= 100000;

-- Sort by ATH, both directions, keyset on (ath, id).
CREATE INDEX coins_listed_ath_idx
  ON coins (ath_market_cap_usd, id)
  WHERE ath_market_cap_usd >= 100000;

-- Sort by launch time. Coins without a launch time sort last in both
-- directions and are read from their own small index.
CREATE INDEX coins_listed_launched_idx
  ON coins (launched_at, id)
  WHERE ath_market_cap_usd >= 100000 AND launched_at IS NOT NULL;
CREATE INDEX coins_listed_no_launch_idx
  ON coins (id)
  WHERE ath_market_cap_usd >= 100000 AND launched_at IS NULL;
