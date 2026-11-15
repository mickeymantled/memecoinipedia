-- Metric rules version 6 (docs/metrics.md section 6): `ath_near_volume_usd` is the
-- USD volume of the clean bars, of every pool that counts, whose close is at or
-- above half the ATH price, each stretch of time counted once at the finest
-- resolution held. Null when the ATH is null. The flag `ath_thinly_traded` goes in
-- `metric_flags` like any other. (Number 0015 belongs to another pull request.)
ALTER TABLE coins
  ADD COLUMN ath_near_volume_usd double precision;
