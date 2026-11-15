-- Metric rules version 7 (docs/metrics.md section 6): `ath_backed_market_cap_usd` is the
-- largest market cap, no larger than the ATH, that enough trading stood behind: the
-- volume of the bars closing at or above half of it is at least a fifth of it. Equal
-- to the ATH unless `ath_thinly_traded` is raised. Null when the ATH is null.
-- (Numbers 0015 and 0016 are taken.)
ALTER TABLE coins
  ADD COLUMN ath_backed_market_cap_usd double precision;
