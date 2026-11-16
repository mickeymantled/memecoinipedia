/**
 * Every interval, age boundary and line of the live process, in one place, each with its reason.
 * Nothing else in `src/live` has a number of its own for these.
 */
import { DEFAULT_PLAN_LIMITS } from '../candles/plan.js';
import { FILTER_TOKENS_MAX_LIMIT } from '../sources/codex/queries.js';
import { LISTED_ATH_USD } from '../worker/stage.js';

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
export const STATE_REFRESH = 'refresh_state';
export const STATE_LAST_WATCH = 'last_watch';
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
 * A coin that was fetched before is fetched again only at a new high: its market cap must reach
 * the trigger line and this multiple of the larger of its stored ATH and its market cap at the
 * last trigger. Without the step a coin sitting at $92,000 for a week would be fetched at every
 * poll; with it, once, and again only at about $96,600 and up.
 */
export const RETRIGGER_STEP = 1.05;
/**
 * A later fetch waits this long after the candles last finished: the fetch asks only for bars
 * after what is held, so a second fetch minutes after the first would find almost no new bars.
 */
export const RETRIGGER_MIN_SECONDS = 15 * MINUTE;
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
/**
 * The last look: a watched coin this old (13 days, a day before it leaves the window), listed or not,
 * whose candles last finished before it was this old, is fetched once more. With fresh daily bars
 * the staged fetch screens it cheaply, and a spike that the hourly polls of days 3 to 14 missed
 * shows in a daily bar.
 */
export const LAST_LOOK_AGE_SECONDS = 13 * DAY;
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
/**
 * Cost of one last look: the fetch asks only for bars after what is held, and a coin with nothing
 * new at hourly or minute scale needs fresh daily bars only: one request. A last look that finds a
 * spike costs more; those are part of the later-trigger allowance. Every graduate gets a last look;
 * one that lists costs `UNITS_PER_LATER_TRIGGER` instead.
 */
export const UNITS_PER_LAST_LOOK = UNITS_PER_REQUEST;
/**
 * Allowance for later triggers (a fetched coin reaching a new high, or a screened one crossing the
 * line after its first fetch): this many a day per triggered coin, each costing three requests
 * (a new daily bar, a new hourly window, one refinement window). An assumption, not a measurement:
 * most coins peak in their first day, and the 5% step and the 15 minutes bound the rest.
 */
export const ASSUMED_LATER_TRIGGERS_PER_TRIGGERED_COIN = 1;
export const UNITS_PER_LATER_TRIGGER = 3 * UNITS_PER_REQUEST;

// ------------------------------------------------------------- refresh and top-up

/** A coin is listed, and so refreshed and topped up, at this ATH market cap (the stage's own line). */
export const REFRESH_LISTED_USD = LISTED_ATH_USD;
/** Mints per refresh request: Jupiter's maximum, as the watch loop uses. */
export const REFRESH_MINTS_PER_REQUEST = 100;
/**
 * Refresh requests one scheduler tick may send. The shared Jupiter limiter spaces them (0.5 a
 * second without a key), so a tick stays well inside the next one; 150,000 listed coins is 1,500
 * requests, 150 ticks, under an hour.
 */
export const REFRESH_REQUESTS_PER_PASS = 10;
/** Jupiter's rate without a key, requests a second: the dry run measures the day's requests against it. */
export const JUPITER_FREE_RPS = 0.5;
/** Listed coins the dry run assumes when the database has none to count (the issue's figure). */
export const ASSUMED_LISTED_COINS = 150_000;

/** Top-up rule 1: the current market cap is at least this share of the stored ATH (the coin still trades near it). */
export const TOPUP_ATH_SHARE = 0.5;
/** Top-up rule 2: the newest stored bar is older than this (a week of bars is missing for a coin Jupiter shows alive). */
export const TOPUP_STALE_BAR_SECONDS = 7 * DAY;
/**
 * Listed coins whose candles may be waiting or running at once when the top-up adds more. The top-up
 * feeds the queue a little at a time, so discovery, new coins and later triggers (which go straight
 * to the queue) are never behind thousands of top-ups.
 */
export const TOPUP_MAX_IN_FLIGHT = 200;
/** Coins one top-up pass reopens at most. */
export const TOPUP_BATCH = 100;
/**
 * The top-up takes no new coin once the day's Codex.io units reach this share of the ceiling, so the
 * last part is left to discovery, new coins and later triggers, which come first. At the ceiling
 * itself the candles stage holds everything anyway.
 */
export const TOPUP_STOP_SHARE = 0.8;
/** Compute units the dry run assumes for one top-up: a new daily bar, a new hourly window and a refinement window (as a later trigger). */
export const UNITS_PER_TOPUP = UNITS_PER_LATER_TRIGGER;

// ------------------------------------------------------------ the pool list in a top-up

/**
 * A top-up reads a coin's pool list again when it was last read more than this many days ago
 * (issue #87). One list request costs about 4 compute units (`UNITS_PER_REQUEST`; 4 plus 0.0048 a
 * pool listed, 5.2 at most), a top-up of a coin about 12 (`UNITS_PER_TOPUP`), and a coin the top-up
 * selects every day is read once in this many days, so the lists add 4 / (12 x days) to the
 * top-up's own spend: 2.4% at 14 days, 4.8% at 7, 1.1% at 30. A later read finds a new pool just
 * as well, and the pool's bars are fetched from its first trade, so a long limit loses no high; it
 * only leaves the coin's ATH and metrics stale for that long. Fourteen days: two weeks is the
 * longest a missing venue stays unseen, for a spend that is small next to the top-up itself.
 */
export const TOPUP_POOL_LIST_MAX_AGE_DAYS = 14;
export const TOPUP_POOL_LIST_MAX_AGE_SECONDS = TOPUP_POOL_LIST_MAX_AGE_DAYS * DAY;
/**
 * The most the top-up spends on list requests in one UTC day, as a share of the day's ceiling. It
 * matters on the first days after this shipped: every coin is then due (no stored time, and its
 * newest pool is older than the limit), so without it each coin the top-up selects would cost a
 * list on top of its fetch. A coin left out today is still due tomorrow. Counted in
 * `live_state` as `topup_lists`, one per coin handed a list, at `UNITS_PER_REQUEST` units each.
 */
export const TOPUP_POOL_LIST_UNIT_SHARE = 0.1;
/** The counter of the day (`dayKey`) of coins handed a list read by the top-up. */
export const COUNTER_TOPUP_LISTS = 'topup_lists';
/** List requests the top-up may make in a day under a ceiling of `ceilingUnits`. */
export const topUpListsPerDay = (ceilingUnits: number): number =>
  Math.floor((ceilingUnits * TOPUP_POOL_LIST_UNIT_SHARE) / UNITS_PER_REQUEST);
