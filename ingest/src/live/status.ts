/**
 * `live status`: read-only, from the database alone (the process need not be running, and its
 * state is not asked for). Cursor and its lag, the watched coins by age, today's figures (UTC day:
 * coins found, triggered, fetched, listed, and the units used), and the time of the last sweep.
 */
import {
  PIPELINE_LOCK_STATE_KEY,
  countWatchedByAge,
  getLiveState,
  liveFetchedSince,
  usageTotalSince,
  type Database,
  type PipelineLockHolder,
  type WatchedCounts,
} from '@memecoinipedia/db';
import type { Kysely } from 'kysely';
import { LISTED_ATH_USD } from '../worker/stage.js';
import { CODEX_PROVIDER } from '../sources/codex/index.js';
import {
  STATE_DISCOVERY_CURSOR,
  STATE_LAST_DISCOVERY,
  STATE_LAST_SWEEP,
  STATE_SETTINGS,
  WATCH_FRESH_UNDER_SECONDS,
  WATCH_MID_UNDER_SECONDS,
  dayKey,
} from './constants.js';
import type { Cursor } from './discover.js';
import type { LastSweep } from './sweep.js';
import { startOfUtcDay, watchSpec } from './util.js';

export interface LiveStatus {
  now: Date;
  /** Every graduate up to this time has been stored; null before the first window is stored. */
  cursorAt: Date | null;
  /** Seconds from the cursor to now. */
  lagSeconds: number | null;
  lastDiscovery: { at: Date; status: string; found: number; error?: string } | null;
  watched: WatchedCounts;
  today: {
    day: string;
    found: number;
    triggered: number;
    /** Coins queued by the sweep that had no candles row yet. */
    swept: number;
    fetched: number;
    listed: number;
    codexUnits: number;
    codexRequests: number;
    jupiterRequests: number;
  };
  /** The ceiling the running (or last) process was started with. */
  maxCodexUnitsPerDay: number | null;
  lastSweep: Date | null;
  /** A pipeline process that appears to hold the lock now, from the hint row. */
  holder: PipelineLockHolder | null;
}

interface DayCounters {
  found?: number;
  triggered?: number;
  swept?: number;
}

export async function collectLiveStatus(
  db: Kysely<Database>,
  now: Date = new Date(),
): Promise<LiveStatus> {
  const dayStart = startOfUtcDay(now);
  const cursor = await getLiveState<Cursor>(db, STATE_DISCOVERY_CURSOR);
  const last = await getLiveState<{
    at: string;
    status: string;
    found: number;
    error?: string;
  }>(db, STATE_LAST_DISCOVERY);
  const sweep = await getLiveState<LastSweep>(db, STATE_LAST_SWEEP);
  const settings = await getLiveState<{ maxCodexUnitsPerDay?: number }>(db, STATE_SETTINGS);
  const counters = (await getLiveState<DayCounters>(db, dayKey(now))) ?? {};
  const holder = await getLiveState<PipelineLockHolder>(db, PIPELINE_LOCK_STATE_KEY);
  const fetched = await liveFetchedSince(db, dayStart, now, LISTED_ATH_USD);
  const codex = await usageTotalSince(db, CODEX_PROVIDER, dayStart, now);
  const jupiter = await usageTotalSince(db, 'jupiter', dayStart, now);
  return {
    now,
    cursorAt: cursor ? new Date(cursor.at * 1000) : null,
    lagSeconds: cursor ? Math.max(0, now.getTime() / 1000 - cursor.at) : null,
    lastDiscovery: last
      ? {
          at: new Date(last.at),
          status: last.status,
          found: last.found,
          ...(last.error ? { error: last.error } : {}),
        }
      : null,
    watched: await countWatchedByAge(db, watchSpec(now), {
      freshUnderSeconds: WATCH_FRESH_UNDER_SECONDS,
      midUnderSeconds: WATCH_MID_UNDER_SECONDS,
    }),
    today: {
      day: dayStart.toISOString().slice(0, 10),
      found: counters.found ?? 0,
      triggered: counters.triggered ?? 0,
      swept: counters.swept ?? 0,
      fetched: fetched.fetched,
      listed: fetched.listed,
      codexUnits: codex.units,
      codexRequests: codex.requests,
      jupiterRequests: jupiter.requests,
    },
    maxCodexUnitsPerDay: settings?.maxCodexUnitsPerDay ?? null,
    lastSweep: sweep ? new Date(sweep.at) : null,
    holder: holder ?? null,
  };
}

const n = (x: number) => Math.round(x).toLocaleString('en-US');

function duration(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)} s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  if (seconds < 172_800) return `${(seconds / 3600).toFixed(1)} hours`;
  return `${(seconds / 86_400).toFixed(1)} days`;
}

export function formatLiveStatus(s: LiveStatus): string {
  const lines: string[] = [];
  lines.push(`Live status at ${s.now.toISOString()}`);
  lines.push(
    s.holder
      ? `Process: a ${s.holder.kind} run appears to be running (pid ${s.holder.pid ?? 'unknown'}, since ${s.holder.since ?? 'unknown'}).`
      : 'Process: none appears to be running.',
  );
  lines.push(
    s.cursorAt
      ? `Discovery cursor: ${s.cursorAt.toISOString()}, ${duration(s.lagSeconds ?? 0)} behind.`
      : 'Discovery cursor: none yet.',
  );
  if (s.lastDiscovery) {
    lines.push(
      `Last discovery pass: ${s.lastDiscovery.at.toISOString()}, ${s.lastDiscovery.status}, ${n(s.lastDiscovery.found)} new` +
        `${s.lastDiscovery.error ? ` (${s.lastDiscovery.error})` : ''}.`,
    );
  }
  lines.push(
    `Watched coins: ${n(s.watched.total)} (under 24 hours ${n(s.watched.fresh)}, 1 to 3 days ${n(s.watched.mid)}, ` +
      `3 to 14 days ${n(s.watched.older)}); ${n(s.watched.triggeredWaiting)} triggered and waiting for a worker.`,
  );
  const t = s.today;
  lines.push(`Today (UTC ${t.day}):`);
  lines.push(
    `  coins found ${n(t.found)}, triggered ${n(t.triggered)}, queued by the sweep ${n(t.swept)}, ` +
      `fetched ${n(t.fetched)}, listed ${n(t.listed)} (ATH of $${n(LISTED_ATH_USD)} or more).`,
  );
  lines.push(
    `  Codex.io ${n(t.codexUnits)} units in ${n(t.codexRequests)} requests` +
      `${s.maxCodexUnitsPerDay ? ` of ${n(s.maxCodexUnitsPerDay)} allowed (${Math.round((t.codexUnits / s.maxCodexUnitsPerDay) * 100)}%)` : ''}; ` +
      `Jupiter ${n(t.jupiterRequests)} requests.`,
  );
  lines.push(
    s.lastSweep ? `Last sweep: ${s.lastSweep.toISOString()}.` : 'Last sweep: none recorded.',
  );
  return lines.join('\n');
}
