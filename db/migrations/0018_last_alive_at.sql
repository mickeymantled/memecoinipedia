-- Issue #74: the daily refresh. The last time the coin met the alive line (volume of at least
-- $1,000 in 24 hours and liquidity of at least $5,000): set from the stored bars by the metrics
-- computation, and from Jupiter's figures by the daily refresh. It only moves forward. The status is
-- decided from it (docs/metrics.md, section 14). Null: never met, or not computed yet.
ALTER TABLE coins ADD COLUMN last_alive_at timestamptz;

-- The refresh reads the listed coins (ATH of $100,000 or more) in id order, a page at a time.
CREATE INDEX coins_listed_idx ON coins (id) WHERE ath_market_cap_usd >= 100000;
