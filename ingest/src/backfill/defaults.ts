/**
 * Defaults for a backfill, and why.
 *
 * Rate. Codex.io documents the Growth plan's limit as 300 requests a second
 * (https://docs.codex.io/concepts/rate-limits, read 2026-11-15). The default is half of that,
 * capped at 100: a run that gets 429s slows itself down (see `RateLimiter.penalize`), but there is
 * no reason to start at the edge.
 *
 * Coins in flight. A coin's candle fetch is a handful of requests one after another (2 for a coin
 * screened out, about 6 on average, 40 for a large one). With R requests a second and L seconds
 * per request, R x L requests are in the air, and each coin has one at a time, so at least R x L
 * coins must be in flight to keep the limiter busy. L is not known until the paid run (a GraphQL
 * answer is a few hundred milliseconds), so the default is 200: enough for L up to 2 seconds at
 * 100 a second. Coins waiting on a provider hold no database connection.
 *
 * Connections. This Postgres is shared with other databases, so the whole run stays at or under
 * `MAX_CONNECTIONS`: the run's own pool, plus the queue library's pool.
 */

/** Codex.io's documented request limit on the Growth plan, per second. */
export const CODEX_DOCUMENTED_GROWTH_RPS = 300;
/** Requests a second to Codex.io unless told otherwise: half the limit, and never above 100. */
export const DEFAULT_CODEX_RPS = Math.min(100, CODEX_DOCUMENTED_GROWTH_RPS / 2);

/** Candle fetches running at once. */
export const BACKFILL_CANDLES_CONCURRENCY = 200;
/** Metrics only read and write the database. */
export const DEFAULT_METRICS_CONCURRENCY = 16;
/**
 * Metadata fetches running at once. Each waits on a per-host limiter (a request or two a second
 * to each gateway), and a stage that outlasts its timeout is taken over, so this stays modest.
 */
export const DEFAULT_METADATA_CONCURRENCY = 40;
/**
 * Metadata files fetched at once (`--file-concurrency`). The gateways are slow to answer, not
 * short of capacity: probed one request at a time, filebase answered 42 of 42 files with a median
 * of 1.0 s and pinata 42 of 42 with a median of 5.7 s. With 37 coins in flight (the metadata
 * stage's default) 152 of 260 coins failed their first try in three minutes (filebase timed out
 * under the pile of open requests, pinata then rate-limited the fallback); with 3 in flight at the
 * same 1.5 requests a second the stage did 86 coins a minute with no failure and no warning. At
 * the default gateway rate the limiter, not the number in flight, is what paces the stage (3
 * coins at 1 s each can ask for 3 requests a second), so 3 loses no speed and keeps few requests
 * open. Raise it only with a faster gateway rate.
 */
export const DEFAULT_METADATA_FILE_CONCURRENCY = 3;

/** Connections in the run's Kysely pool. */
export const DEFAULT_DB_POOL = 30;
/** Connections in the queue library's pool. */
export const DEFAULT_QUEUE_POOL = 8;
/** The most connections a run may open, in total. */
export const MAX_CONNECTIONS = 40;

/** Coins the feeder keeps waiting or running, as a multiple of the candles concurrency. */
export const OUTSTANDING_PER_SLOT = 2;
/** Coins read from the selection and queued at a time. */
export const FEED_PAGE = 500;

export const DEFAULT_MIN_ROUGH_PEAK_USD = 30_000;

/**
 * Jobs a worker takes at a time, per stage (see `PipelineWorkerOptions.stageBatchSize`). Stages that
 * only touch the database take more; the ones that wait on a provider keep batches small, because
 * a batch ends when its slowest coin does.
 */
export const BACKFILL_BATCH_SIZE = {
  candles: 5,
  metrics: 10,
  metadata: 5,
  metadata_file: 5,
} as const;
