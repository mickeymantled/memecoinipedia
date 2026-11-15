/**
 * Every interval, age boundary and line of the live process, in one place, each with its reason.
 * Nothing else in `src/live` has a number of its own for these.
 */
import { DEFAULT_PLAN_LIMITS } from '../candles/plan.js';
import { FILTER_TOKENS_MAX_LIMIT } from '../sources/codex/queries.js';

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// ---------------------------------------------------------------- what is stored

/** `coins.discovery_source` of a coin the live process found. */
export const LIVE_DISCOVERY_SOURCE = 'codex-live';
/** `ingest_runs.kind` of a live process (status joins stage rows to runs by it). */
export const LIVE_RUN_KIND = 'live';
export const LIVE_CHAIN = 'solana';
export const LIVE_LAUNCHPAD = 'pump.fun';

/** Keys of `live_state`. Per-day counters are `day:YYYY-MM-DD` (UTC). */
export const STATE_DISCOVERY_CURSOR = 'discovery_cursor';
export const STATE_LAST_DISCOVERY = 'last_discovery';
export const STATE_LAST_SWEEP = 'last_sweep';
export const STATE_SETTINGS = 'live_settings';
export const dayKey = (d: Date): string => `day:${d.toISOString().slice(0, 10)}`;

// -------------------------------------------------------------------- discovery

/** The issue asks for a look every 5 minutes: new graduates are in `coins` within 5 minutes of Codex.io listing them. */
export const DISCOVERY_INTERVAL_SECONDS = 5 * MINUTE;
/**
 * Each pass reads from the cursor less this. Codex.io can list a migration some minutes after its
 * migration time, so a window read once at its end could miss a late-listed coin; reading the
 * last half hour again costs one request and finds it. (Set by the issue.)
 */
export const DISCOVERY_OVERLAP_SECONDS = 30 * MINUTE;
/** Rows a request asks for: the most the API gives (a smaller page means more requests for the same rows). */
export const DISCOVERY_PAGE_SIZE = FILTER_TOKENS_MAX_LIMIT;
/**
 * The longest stretch one query covers, and the unit the catch-up after a stop is walked in. At
 * 3,000 graduates a day a window holds about 250 rows (two 200-row pages, depth 400) against the
 * query's depth limit of 10,000; a burst 20 times that still stays under it. Rows are stored and
 * the cursor moved after every window, so a failure part-way loses at most one window's work.
 */
export const DISCOVERY_WINDOW_SECONDS = 2 * HOUR;

// ------------------------------------------------------------------------ watch

/** A coin is watched for this long after it graduated (set by the issue). */
export const WATCH_WINDOW_SECONDS = 14 * DAY;
/**
 * How often a watched coin's price is read, by age since graduation (set by the issue). Young coins
 * move fast and are the ones worth a one-hour target; old ones that never reached the line rarely
 * do, so they are looked at hourly.
 */
export const WATCH_FRESH_UNDER_SECONDS = DAY;
export const WATCH_FRESH_EVERY_SECONDS = 2 * MINUTE;
export const WATCH_MID_UNDER_SECONDS = 3 * DAY;
export const WATCH_MID_EVERY_SECONDS = 10 * MINUTE;
export const WATCH_OLDER_EVERY_SECONDS = HOUR;
/**
 * A coin is queued for its candles at this market cap: the line the staged fetch refines from
 * (`DEFAULT_PLAN_LIMITS.refineFromUsd`, $90,000), so a coin that crosses it is fetched while a coin
 * near $100,000 is still worth the fetch. Taken from the fetcher's own limit so the two cannot drift.
 */
export const TRIGGER_MARKET_CAP_USD = DEFAULT_PLAN_LIMITS.refineFromUsd;
/**
 * Mints per Jupiter request (its maximum is 100) and requests per pass. A pass is capped so that
 * after a long stop, with thousands of coins due at once, it hands back to the other loops
 * (Jupiter's own limiter allows about 1 request a second); the rest are due again next pass.
 */
export const WATCH_MINTS_PER_REQUEST = 100;
export const WATCH_MAX_REQUESTS_PER_PASS = 60;
/** How often the watch loop looks for coins that are due. The shortest interval is 120 s; this is a quarter of it. */
export const WATCH_PASS_SECONDS = 30;

// ------------------------------------------------------------------------ sweep

/**
 * The sweep queues every watched coin at least this old (24 hours: by then a coin that spiked
 * and fell between two polls has a daily bar showing it, and the staged fetch screens on daily bars).
 */
export const SWEEP_MIN_AGE_SECONDS = DAY;
/** The sweep reads discovery again for this long back: covers a cursor that ran ahead of a late listing, and a short outage. */
export const SWEEP_REREAD_SECONDS = 2 * DAY;
/** The sweep runs once per UTC day, not before this many seconds into it: the day's unit budget has just been renewed. */
export const SWEEP_AFTER_UTC_SECONDS = 10 * MINUTE;
/** After a sweep that failed or was paused, the next try is this much later (not every pass: the provider may be down). */
export const SWEEP_RETRY_SECONDS = 15 * MINUTE;
/** Coins read and queued at a time by the sweep. */
export const SWEEP_PAGE = 1_000;

// ------------------------------------------------------------------- the process

/** The scheduler looks at the clock this often. */
export const TICK_SECONDS = 15;
/** Coins waiting for candles with no job in the queue (the queue was cleared, or a pause dropped them) are queued again this often. */
export const REQUEUE_WAITING_SECONDS = 10 * MINUTE;
/** The day's Codex.io units at which discovery and candle fetches pause until the next UTC day (set by the issue). */
export const DEFAULT_MAX_CODEX_UNITS_PER_DAY = 40_000;
/** How often the usage history gets a sample: the unit ceiling is checked against these, so it is finer than the backfill's 30 s. */
export const USAGE_SAMPLE_SECONDS = 15;

/**
 * Concurrency and connections. The live process runs a trickle (hundreds of coins a day), next to
 * other databases on a shared Postgres, so these are a tenth of the backfill's.
 */
export const LIVE_CANDLES_CONCURRENCY = 20;
export const LIVE_METRICS_CONCURRENCY = 4;
export const LIVE_METADATA_CONCURRENCY = 4;
export const LIVE_DB_POOL = 10;
export const LIVE_QUEUE_POOL = 4;

// ------------------------------------------------------------------ the dry run

/** Graduates a day the dry run assumes when the database has none to count: the middle of 850 to 1,140 (candidate list, since August 2026). */
export const ASSUMED_GRADUATES_PER_DAY = 1_000;
/** Share of graduates that reach about $100,000: 250 to 340 of 850 to 1,140 a day. */
export const ASSUMED_TRIGGER_SHARE = 0.3;
/**
 * Compute units per candle fetch, from the backfill's measured figures (`UNITS_PER_COIN_BY_CELL`).
 * Triggered coins are in the $100k-and-up cells, weighted by their share of those (74,030, 15,640
 * and 9,816 coins): (20.9 x 74,030 + 27.9 x 15,640 + 33.3 x 9,816) / 99,486 = 23.2. Coins screened
 * out are in the cells under $100k (129,210, 57,341, 59,685 coins at 11, 14.7, 17.9): 13.5.
 */
export const UNITS_PER_TRIGGERED_COIN = 23.2;
export const UNITS_PER_SCREENED_COIN = 13.5;
/** Compute units per request, as the backfill's plan assumes (`FLAT_UNITS`). */
export const UNITS_PER_REQUEST = 4;
