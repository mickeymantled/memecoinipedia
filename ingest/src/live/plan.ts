/**
 * The dry run of `live run`: reads the database, makes no request to any provider and writes
 * nothing, and prints what the process would do: the watched coins by age, and the requests and
 * compute units a day it expects from each provider.
 *
 * The expectation is a model, not a measurement: it takes graduates a day (counted from the
 * database, or assumed), the share that reaches the trigger, and the intervals and per-coin costs
 * in `constants.ts`, and works out the passes and requests those imply.
 */
import {
  countListedCoins,
  countTopUp,
  countWatchedByAge,
  getLiveState,
  latestGraduatedAt,
  type Database,
  type TopUpCounts,
  type WatchedCounts,
} from '@memecoinipedia/db';
import { sql, type Kysely } from 'kysely';
import { FILTER_BASE_UNITS, FILTER_UNITS_PER_TOKEN } from '../sources/codex/client.js';
import { JUPITER_MAX_MINTS_PER_REQUEST } from '../sources/jupiter/client.js';
import { estimateMetadata } from '../worker/plan.js';
import {
  ASSUMED_GRADUATES_PER_DAY,
  ASSUMED_LATER_TRIGGERS_PER_TRIGGERED_COIN,
  ASSUMED_TRIGGER_SHARE,
  DISCOVERY_INTERVAL_SECONDS,
  DISCOVERY_OVERLAP_SECONDS,
  DISCOVERY_PAGE_SIZE,
  DISCOVERY_WINDOW_SECONDS,
  JUPITER_FREE_RPS,
  REFRESH_LISTED_USD,
  REFRESH_MINTS_PER_REQUEST,
  ASSUMED_LISTED_COINS,
  TOPUP_POOL_LIST_MAX_AGE_DAYS,
  TOPUP_STOP_SHARE,
  UNITS_PER_TOPUP,
  topUpListsPerDay,
  STATE_DISCOVERY_CURSOR,
  SWEEP_REREAD_SECONDS,
  UNITS_PER_LAST_LOOK,
  UNITS_PER_LATER_TRIGGER,
  UNITS_PER_REQUEST,
  UNITS_PER_SCREENED_COIN,
  UNITS_PER_TRIGGERED_COIN,
  WATCH_FRESH_EVERY_SECONDS,
  WATCH_FRESH_UNDER_SECONDS,
  WATCH_MID_EVERY_SECONDS,
  WATCH_MID_UNDER_SECONDS,
  WATCH_OLDER_EVERY_SECONDS,
  WATCH_PASS_SECONDS,
} from './constants.js';
import type { Cursor } from './discover.js';
import { topUpSpec } from './topup.js';
import { watchSpec } from './util.js';

const DAY = 86_400;

export interface LiveLoad {
  graduatesPerDay: number;
  /** Coins in each age tier of the watched set that the model assumes. */
  watched: { fresh: number; mid: number; older: number };
  codex: {
    discoveryRequests: number;
    discoveryUnits: number;
    sweepRequests: number;
    sweepUnits: number;
    candlesRequests: number;
    candlesUnits: number;
    lastLookRequests: number;
    lastLookUnits: number;
    laterRequests: number;
    laterUnits: number;
    requests: number;
    units: number;
  };
  jupiter: {
    watchRequests: number;
    /** The daily refresh of every listed coin, 100 mints a request. */
    refreshRequests: number;
    metadataRequests: number;
    requests: number;
    /** Requests a day the free rate allows (`JUPITER_FREE_RPS` all day). */
    freeRateRequests: number;
  };
  helius: { requests: number; credits: number };
}

/** Requests of one discovery walk over `rows` rows in `windows` equal windows. */
function discoveryCost(rows: number, windows: number): { requests: number; units: number } {
  const perWindow = rows / windows;
  const requestsPerWindow = Math.floor(perWindow / DISCOVERY_PAGE_SIZE) + 1;
  return {
    requests: windows * requestsPerWindow,
    units: windows * requestsPerWindow * FILTER_BASE_UNITS + rows * FILTER_UNITS_PER_TOKEN,
  };
}

/**
 * The load a day for `graduatesPerDay` graduates, at steady state.
 *
 * Every graduate is watched for 14 days, fetched or not: a day's graduates are under 24 hours
 * old, the previous two days' are 1 to 3 days old, and the 11 days before are older. Each coin is
 * fetched once (when it reaches the trigger, or at the sweep after 24 hours), then at most once
 * more by the last look at 13 days (the coins that are not listed), and again whenever it
 * reaches a new high (the allowance for later triggers).
 */
export function predictLoad(o: {
  graduatesPerDay: number;
  triggerShare?: number;
  /** Listed coins the daily refresh reads (0: leave the refresh out). */
  listedCoins?: number;
}): LiveLoad {
  const g = o.graduatesPerDay;
  const share = o.triggerShare ?? ASSUMED_TRIGGER_SHARE;
  const triggered = g * share;
  const screened = g - triggered;

  const watched = { fresh: g, mid: 2 * g, older: 11 * g };
  // Coins due in one watch pass, by tier, then Jupiter requests (100 mints each) a day.
  const duePerPass =
    (watched.fresh * WATCH_PASS_SECONDS) / WATCH_FRESH_EVERY_SECONDS +
    (watched.mid * WATCH_PASS_SECONDS) / WATCH_MID_EVERY_SECONDS +
    (watched.older * WATCH_PASS_SECONDS) / WATCH_OLDER_EVERY_SECONDS;
  const passesPerDay = DAY / WATCH_PASS_SECONDS;
  const watchRequests =
    duePerPass > 0 ? Math.ceil(duePerPass / JUPITER_MAX_MINTS_PER_REQUEST) * passesPerDay : 0;

  const discoveryPasses = DAY / DISCOVERY_INTERVAL_SECONDS;
  const rowsPerPass = (g * (DISCOVERY_INTERVAL_SECONDS + DISCOVERY_OVERLAP_SECONDS)) / DAY;
  const pass = discoveryCost(rowsPerPass, 1);
  const sweep = discoveryCost(2 * g, SWEEP_REREAD_SECONDS / DISCOVERY_WINDOW_SECONDS);
  const candlesUnits = triggered * UNITS_PER_TRIGGERED_COIN + screened * UNITS_PER_SCREENED_COIN;
  const candlesRequests = candlesUnits / UNITS_PER_REQUEST;
  // Every graduate gets one: a coin that lists costs a later trigger's worth, one that does not a daily-bars request.
  const lastLookUnits = triggered * UNITS_PER_LATER_TRIGGER + screened * UNITS_PER_LAST_LOOK;
  const lastLookRequests = lastLookUnits / UNITS_PER_REQUEST;
  const laterCount = triggered * ASSUMED_LATER_TRIGGERS_PER_TRIGGERED_COIN;
  const laterUnits = laterCount * UNITS_PER_LATER_TRIGGER;
  const laterRequests = laterUnits / UNITS_PER_REQUEST;

  // Metadata runs for coins that turn out listed: at most the triggered ones.
  const meta = estimateMetadata(Math.ceil(triggered));
  const codexRequests =
    discoveryPasses * pass.requests +
    sweep.requests +
    candlesRequests +
    lastLookRequests +
    laterRequests;
  const codexUnits =
    discoveryPasses * pass.units + sweep.units + candlesUnits + lastLookUnits + laterUnits;
  const metadataJupiter = meta.jupiter?.requests ?? 0;
  const refreshRequests = Math.ceil((o.listedCoins ?? 0) / REFRESH_MINTS_PER_REQUEST);
  return {
    graduatesPerDay: g,
    watched,
    codex: {
      discoveryRequests: Math.round(discoveryPasses * pass.requests),
      discoveryUnits: Math.round(discoveryPasses * pass.units),
      sweepRequests: Math.round(sweep.requests),
      sweepUnits: Math.round(sweep.units),
      candlesRequests: Math.round(candlesRequests),
      candlesUnits: Math.round(candlesUnits),
      lastLookRequests: Math.round(lastLookRequests),
      lastLookUnits: Math.round(lastLookUnits),
      laterRequests: Math.round(laterRequests),
      laterUnits: Math.round(laterUnits),
      requests: Math.round(codexRequests),
      units: Math.round(codexUnits),
    },
    jupiter: {
      watchRequests: watchRequests,
      metadataRequests: metadataJupiter,
      refreshRequests,
      requests: watchRequests + refreshRequests + metadataJupiter,
      freeRateRequests: Math.floor(JUPITER_FREE_RPS * DAY),
    },
    helius: { requests: meta.helius?.requests ?? 0, credits: meta.helius?.credits ?? 0 },
  };
}

export interface LivePlan {
  watched: WatchedCounts;
  cursorAt: Date | null;
  latestGraduatedAt: Date | null;
  graduatesPerDay: number;
  graduatesSource: 'database' | 'assumed' | 'given';
  load: LiveLoad;
  /** Listed coins (ATH of $100,000 or more), counted, or assumed when the database has none. */
  listedCoins: number;
  listedSource: 'database' | 'assumed';
  /** What each top-up rule selects now, refresh condition left out (the refresh has not run). */
  topUp: TopUpCounts;
  /** Codex.io units the top-up would spend if every selected coin were fetched. */
  topUpUnits: number;
  /**
   * List requests a day for the pool lists the top-up reads again (issue #87): `dueNow` is the
   * selected coins whose list is already old (what the first top-up would find), `today` the part
   * of it a day allows (the cap), `steadyPerDay` the selected coins over the limit in days (a coin
   * selected every day is read once in that many days). Units: `UNITS_PER_REQUEST` each.
   */
  topUpLists: { dueNow: number; cap: number; today: number; steadyPerDay: number; units: number };
  maxCodexUnitsPerDay: number;
  /** False when the model's Codex.io units a day are above the ceiling. */
  withinCeiling: boolean;
  /** False when migration 0015 has not been applied to this database. */
  stateTable: boolean;
}

export async function planLive(
  db: Kysely<Database>,
  o: { now: Date; maxCodexUnitsPerDay: number; graduatesPerDay?: number },
): Promise<LivePlan> {
  const w = watchSpec(o.now);
  const watched = await countWatchedByAge(db, w, {
    freshUnderSeconds: WATCH_FRESH_UNDER_SECONDS,
    midUnderSeconds: WATCH_MID_UNDER_SECONDS,
  });
  let cursor: Cursor | null = null;
  let stateTable = true;
  try {
    cursor = await getLiveState<Cursor>(db, STATE_DISCOVERY_CURSOR);
  } catch {
    stateTable = false;
  }
  const since = new Date(o.now.getTime() - DAY * 1000);
  const counted = Number(
    (
      await sql<{
        n: string;
      }>`select count(*)::text as n from coins where graduated_at > ${since} and graduated_at <= ${o.now}`.execute(
        db,
      )
    ).rows[0]!.n,
  );
  const graduatesPerDay = o.graduatesPerDay ?? (counted > 0 ? counted : ASSUMED_GRADUATES_PER_DAY);
  const listedCounted = await countListedCoins(db, REFRESH_LISTED_USD);
  const listedCoins = listedCounted > 0 ? listedCounted : ASSUMED_LISTED_COINS;
  const topUp = await countTopUp(db, topUpSpec(o.now, null));
  const load = predictLoad({ graduatesPerDay, listedCoins });
  return {
    watched,
    cursorAt: cursor ? new Date(cursor.at * 1000) : null,
    latestGraduatedAt: await latestGraduatedAt(db),
    graduatesPerDay,
    graduatesSource:
      o.graduatesPerDay !== undefined ? 'given' : counted > 0 ? 'database' : 'assumed',
    load,
    listedCoins,
    listedSource: listedCounted > 0 ? 'database' : 'assumed',
    topUp,
    topUpUnits: topUp.total * UNITS_PER_TOPUP,
    topUpLists: topUpListEstimate(topUp, o.maxCodexUnitsPerDay),
    maxCodexUnitsPerDay: o.maxCodexUnitsPerDay,
    withinCeiling: load.codex.units <= o.maxCodexUnitsPerDay,
    stateTable,
  };
}

export function topUpListEstimate(
  topUp: TopUpCounts,
  ceilingUnits: number,
): LivePlan['topUpLists'] {
  const cap = topUpListsPerDay(ceilingUnits);
  const today = Math.min(topUp.poolListDue, cap);
  return {
    dueNow: topUp.poolListDue,
    cap,
    today,
    steadyPerDay: Math.ceil(topUp.total / TOPUP_POOL_LIST_MAX_AGE_DAYS),
    units: today * UNITS_PER_REQUEST,
  };
}

const n = (x: number) => Math.round(x).toLocaleString('en-US');

export function formatLivePlan(p: LivePlan): string {
  const lines: string[] = [];
  lines.push('Live plan (dry run): no request to any provider, nothing written.');
  lines.push(
    `Watched coins now: ${n(p.watched.total)} ` +
      `(under 24 hours ${n(p.watched.fresh)}, 1 to 3 days ${n(p.watched.mid)}, 3 to 14 days ${n(p.watched.older)}); ` +
      `${n(p.watched.triggeredWaiting)} already triggered and waiting for a worker.`,
  );
  if (!p.stateTable) {
    lines.push('Discovery cursor: none (migration 0015 is not applied to this database yet).');
  } else if (p.cursorAt) {
    lines.push(
      `Discovery cursor: ${p.cursorAt.toISOString()}; the next pass reads from 30 minutes before it.`,
    );
  } else if (p.latestGraduatedAt) {
    lines.push(
      `Discovery cursor: none; a first start begins at the latest graduation in the database, ${p.latestGraduatedAt.toISOString()}.`,
    );
  } else {
    lines.push('Discovery cursor: none, and no coins; a first start begins at the current time.');
  }
  const src =
    p.graduatesSource === 'database'
      ? 'counted in the database over the last 24 hours'
      : p.graduatesSource === 'given'
        ? 'given'
        : 'assumed: none in the database in the last 24 hours';
  const l = p.load;
  lines.push(
    `Expected load for ${n(l.graduatesPerDay)} graduates a day (${src}), ` +
      `${Math.round(ASSUMED_TRIGGER_SHARE * 100)}% of them reaching the trigger:`,
  );
  lines.push(
    `  Codex.io  ${n(l.codex.requests)} requests, ${n(l.codex.units)} compute units a day: ` +
      `discovery ${n(l.codex.discoveryRequests)} requests / ${n(l.codex.discoveryUnits)} units, ` +
      `sweep re-read ${n(l.codex.sweepRequests)} / ${n(l.codex.sweepUnits)}, ` +
      `first candle fetches ${n(l.codex.candlesRequests)} / ${n(l.codex.candlesUnits)}, ` +
      `last looks ${n(l.codex.lastLookRequests)} / ${n(l.codex.lastLookUnits)}, ` +
      `later triggers ${n(l.codex.laterRequests)} / ${n(l.codex.laterUnits)}.`,
  );
  lines.push(
    `  Jupiter   ${n(l.jupiter.requests)} requests a day (watch ${n(l.jupiter.watchRequests)}, daily refresh ${n(l.jupiter.refreshRequests)}, metadata ${n(l.jupiter.metadataRequests)}); no units. ` +
      `The free rate allows ${n(l.jupiter.freeRateRequests)} a day (${JUPITER_FREE_RPS} a second): ` +
      `${l.jupiter.requests <= l.jupiter.freeRateRequests ? 'within it' : 'ABOVE IT, so the refresh would not finish'} ` +
      `(${Math.round((l.jupiter.requests / l.jupiter.freeRateRequests) * 100)}% of it, the watch loop going first).`,
  );
  lines.push(
    `  Refresh   ${n(p.listedCoins)} listed coins (${p.listedSource === 'database' ? 'counted in the database' : 'assumed: none in the database'}), ` +
      `${REFRESH_MINTS_PER_REQUEST} mints a request, no Codex.io units.`,
  );
  lines.push(
    `  Top-up    selects ${n(p.topUp.total)} coins now: ${n(p.topUp.byMarketCap)} by rule 1 (current market cap at least half the ATH), ` +
      `${n(p.topUp.byStaleBars)} by rule 2 (newest bar over 7 days old), a coin can match both; ` +
      `expected ${n(p.topUpUnits)} Codex.io units at ${UNITS_PER_TOPUP} each, spent after discovery, new coins and later triggers, ` +
      `and stopping at ${Math.round(TOPUP_STOP_SHARE * 100)}% of the ceiling.`,
  );
  const tl = p.topUpLists;
  lines.push(
    `  Pool lists  the top-up reads a coin's pool list again when it is over ${TOPUP_POOL_LIST_MAX_AGE_DAYS} days old, ` +
      `one request of about ${UNITS_PER_REQUEST} units each, counted in the ceiling: ` +
      `${n(tl.dueNow)} of the selected coins are due now, so the first top-up makes ${n(tl.today)} list requests ` +
      `(${n(tl.units)} units; at most ${n(tl.cap)} a day, a coin left out is due the next day); ` +
      `afterwards about ${n(tl.steadyPerDay)} a day (${n(tl.steadyPerDay * UNITS_PER_REQUEST)} units) at this many selected coins.`,
  );
  lines.push(
    `  Helius    ${n(l.helius.requests)} requests, ${n(l.helius.credits)} credits a day (metadata of listed coins, at most).`,
  );
  lines.push(
    `  The ceiling is ${n(p.maxCodexUnitsPerDay)} Codex.io units a UTC day: ` +
      `${p.withinCeiling ? 'the expectation is within it' : 'THE EXPECTATION IS ABOVE IT, so fetches would pause each day'} ` +
      `(${Math.round((l.codex.units / p.maxCodexUnitsPerDay) * 100)}% of it).`,
  );
  lines.push(
    `  Assumptions: every graduate is watched for 14 days (Jupiter figure above is for that steady state). ` +
      `Every graduate gets a last look: one daily-bars request (${UNITS_PER_LAST_LOOK} units) for a coin that does not list, ${UNITS_PER_LATER_TRIGGER} units for one that does. ` +
      `The later-trigger allowance is ${ASSUMED_LATER_TRIGGERS_PER_TRIGGERED_COIN} later fetch per triggered coin, ` +
      `${UNITS_PER_LATER_TRIGGER} units each (3 requests: a daily bar, an hourly window, a refinement window); ` +
      `it is a guess, bounded by the 5% step and the 15 minutes, not a measurement.`,
  );
  lines.push('Add --confirm to run.');
  return lines.join('\n');
}
