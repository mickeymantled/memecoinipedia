-- Metric rules version 4 (docs/metrics.md section 6): how much stood behind the
-- peak. `ath_liquidity_usd` is the liquidity reported by the window that set the
-- ATH; `ath_hour_volume_usd` is the 1-minute volume of every pool in the hour up
-- to and including the ATH minute. Both are null when the ATH is null.
ALTER TABLE coins
  ADD COLUMN ath_liquidity_usd double precision,
  ADD COLUMN ath_hour_volume_usd double precision;
