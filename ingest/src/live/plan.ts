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
  countWatchedByAge,
  getLiveState,
  latestGraduatedAt,
  type Database,
  type WatchedCounts,
} from '@memecoinipedia/db';
import { sql, type Kysely } from 'kysely';
import { FILTER_BASE_UNITS, FILTER_UNITS_PER_TOKEN } from '../sources/codex/client.js';
import { JUPITER_MAX_MINTS_PER_REQUEST } from '../sources/jupiter/client.js';
import { estimateMetadata } from '../worker/plan.js';
import {
  ASSUMED_GRADUATES_PER_DAY,
  ASSUMED_TRIGGER_SHARE,
  DISCOVERY_INTERVAL_SECONDS,
  DISCOVERY_OVERLAP_SECONDS,
  DISCOVERY_PAGE_SIZE,
  DISCOVERY_WINDOW_SECONDS,
  STATE_DISCOVERY_CURSOR,
  SWEEP_REREAD_SECONDS,
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
    requests: number;
    units: number;
  };
  jupiter: { watchRequests: number; metadataRequests: number; requests: number };
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
 * The load a day for `graduatesPerDay` graduates.
 *
 * `sweepConsumes: true` follows the rules as written: the sweep queues every watched coin a day
 * old, and a coin whose candles were attempted is no longer watched, so at any time the watched
 * set is the day's graduates plus, until the next sweep, those a day old and not yet swept (half a
 * day's on average). `false` is the upper bound if coins stayed watched the whole 14 days: the
 * sweep would not take them out.
 */
export function predictLoad(o: {
  graduatesPerDay: number;
  triggerShare?: number;
  sweepConsumes: boolean;
}): LiveLoad {
  const g = o.graduatesPerDay;
  const share = o.triggerShare ?? ASSUMED_TRIGGER_SHARE;
  const triggered = g * share;
  const screened = g - triggered;

  const watched = o.sweepConsumes
    ? { fresh: g, mid: g / 2, older: 0 }
    : { fresh: g, mid: 2 * g, older: 11 * g };
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

  // Metadata runs for coins that turn out listed: at most the triggered ones.
  const meta = estimateMetadata(Math.ceil(triggered));
  const codexRequests = discoveryPasses * pass.requests + sweep.requests + candlesRequests;
  const codexUnits = discoveryPasses * pass.units + sweep.units + candlesUnits;
  const metadataJupiter = meta.jupiter?.requests ?? 0;
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
      requests: Math.round(codexRequests),
      units: Math.round(codexUnits),
    },
    jupiter: {
      watchRequests: watchRequests,
      metadataRequests: metadataJupiter,
      requests: watchRequests + metadataJupiter,
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
  upperBound: LiveLoad;
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
  const load = predictLoad({ graduatesPerDay, sweepConsumes: true });
  return {
    watched,
    cursorAt: cursor ? new Date(cursor.at * 1000) : null,
    latestGraduatedAt: await latestGraduatedAt(db),
    graduatesPerDay,
    graduatesSource:
      o.graduatesPerDay !== undefined ? 'given' : counted > 0 ? 'database' : 'assumed',
    load,
    upperBound: predictLoad({ graduatesPerDay, sweepConsumes: false }),
    maxCodexUnitsPerDay: o.maxCodexUnitsPerDay,
    withinCeiling: load.codex.units <= o.maxCodexUnitsPerDay,
    stateTable,
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
      `candle fetches ${n(l.codex.candlesRequests)} / ${n(l.codex.candlesUnits)}.`,
  );
  lines.push(
    `  Jupiter   ${n(l.jupiter.requests)} requests a day (watch ${n(l.jupiter.watchRequests)}, metadata ${n(l.jupiter.metadataRequests)}); no units.`,
  );
  lines.push(
    `  Helius    ${n(l.helius.requests)} requests, ${n(l.helius.credits)} credits a day (metadata of listed coins, at most).`,
  );
  lines.push(
    `  The ceiling is ${n(p.maxCodexUnitsPerDay)} Codex.io units a UTC day: ` +
      `${p.withinCeiling ? 'the expectation is within it' : 'THE EXPECTATION IS ABOVE IT, so fetches would pause each day'} ` +
      `(${Math.round((l.codex.units / p.maxCodexUnitsPerDay) * 100)}% of it).`,
  );
  const u = p.upperBound;
  lines.push(
    `  If coins stayed watched for all 14 days instead (the sweep not taking them out): ` +
      `Jupiter ${n(u.jupiter.watchRequests)} watch requests a day; Codex.io is unchanged.`,
  );
  lines.push('Add --confirm to run.');
  return lines.join('\n');
}
