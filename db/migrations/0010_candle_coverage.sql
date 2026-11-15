-- Which time ranges of bars have been requested from the provider, per pool and
-- resolution. Bars alone cannot say this: a bucket with no trades has no bar, so
-- "nothing stored" is the same for "never asked" and "asked, nobody traded".
-- One row per request. Rows are never merged or updated (a request repeated for
-- the same range is a no-op), and a reason lets a cap count requests of one kind.
CREATE TABLE candle_coverage (
  pool_id        bigint NOT NULL REFERENCES pools (id) ON DELETE CASCADE,
  resolution_sec int    NOT NULL CHECK (resolution_sec IN (60, 3600, 86400)),
  from_t         bigint NOT NULL,           -- unix seconds, inclusive
  to_t           bigint NOT NULL,           -- unix seconds, exclusive
  reason         text   NOT NULL,
  fetched_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pool_id, resolution_sec, from_t, to_t),
  CHECK (to_t > from_t)
);
