/**
 * Discovery: find coins that graduated since the last look and store the ones not yet in `coins`.
 *
 * `discoverOnce` reads from the cursor less the overlap to now, in windows of
 * `DISCOVERY_WINDOW_SECONDS`, oldest first. After each window's rows are stored the cursor moves
 * to the end of that window and not before, so a failed request loses nothing: the next pass
 * starts from the last stored window and the overlap makes it read the same rows again, which are
 * already there and are skipped by (chain, address). After a long stop the same walk covers the
 * gap window by window, so no query asks for more than a window's rows.
 *
 * A first start, with no cursor, begins at the latest graduation in `coins`, or at now when there
 * are no coins.
 */
import {
  getLiveState,
  insertLiveGraduates,
  latestGraduatedAt,
  setLiveState,
  type LiveGraduate,
} from '@memecoinipedia/db';
import type { DiscoveredToken } from '../sources/codex/client.js';
import {
  DISCOVERY_OVERLAP_SECONDS,
  DISCOVERY_PAGE_SIZE,
  DISCOVERY_WINDOW_SECONDS,
  LIVE_CHAIN,
  LIVE_DISCOVERY_SOURCE,
  LIVE_LAUNCHPAD,
  STATE_DISCOVERY_CURSOR,
  STATE_LAST_DISCOVERY,
  dayKey,
} from './constants.js';
import type { LiveDeps } from './deps.js';
import { safeText } from './util.js';

export interface DiscoveryPass {
  /** `paused`: the day's unit ceiling stopped it. `error`: a request failed (what was stored is kept). */
  status: 'ok' | 'paused' | 'error';
  /** The range asked for, unix seconds. */
  from: number;
  to: number;
  /** Windows read and stored. */
  windows: number;
  /** Graduates the provider listed, and how many were new. */
  seen: number;
  found: number;
  /** The cursor after the pass, unix seconds. */
  cursor: number | null;
  error?: string;
}

export interface Cursor {
  /** Every graduate with a migration time at or before this has been stored. Unix seconds. */
  at: number;
}

const toGraduate = (t: DiscoveredToken): LiveGraduate => ({
  address: t.mint,
  ticker: t.symbol,
  name: t.name,
  launchpad: LIVE_LAUNCHPAD,
  launchedAt: t.createdAt === null ? null : new Date(t.createdAt * 1000),
  creatorWallet: t.creator,
  graduatedAt: new Date((t.migratedAt as number) * 1000),
});

/**
 * Reads `[from, to]` (unix seconds) window by window and stores what is new. With `moveCursor`,
 * moves the cursor to the end of each window once that window is stored.
 */
export async function readGraduates(
  deps: LiveDeps,
  range: { from: number; to: number },
  o: { moveCursor: boolean },
): Promise<DiscoveryPass> {
  const pass: DiscoveryPass = {
    status: 'ok',
    from: range.from,
    to: range.to,
    windows: 0,
    seen: 0,
    found: 0,
    cursor: null,
  };
  let start = range.from;
  while (start <= range.to) {
    if (!deps.gate.admit()) {
      pass.status = 'paused';
      break;
    }
    const end = Math.min(start + DISCOVERY_WINDOW_SECONDS - 1, range.to);
    const rows: LiveGraduate[] = [];
    try {
      for await (const t of deps.codex.discoverGraduated(
        { from: start, to: end },
        { windowSeconds: DISCOVERY_WINDOW_SECONDS, pageSize: DISCOVERY_PAGE_SIZE },
      )) {
        if (t.migratedAt !== null) rows.push(toGraduate(t));
      }
    } catch (err) {
      pass.status = 'error';
      pass.error = safeText(err);
      break;
    }
    const now = deps.now();
    const stored = await insertLiveGraduates(deps.db, rows, {
      chain: LIVE_CHAIN,
      discoverySource: LIVE_DISCOVERY_SOURCE,
      now,
      dayKey: dayKey(now),
    });
    pass.windows++;
    pass.seen += stored.seen;
    pass.found += stored.inserted;
    if (o.moveCursor) {
      const before = await getLiveState<Cursor>(deps.db, STATE_DISCOVERY_CURSOR);
      const at = Math.max(before?.at ?? 0, end);
      await setLiveState(deps.db, STATE_DISCOVERY_CURSOR, { at }, now);
      pass.cursor = at;
    }
    start = end + 1;
  }
  return pass;
}

export async function discoverOnce(deps: LiveDeps): Promise<DiscoveryPass> {
  const now = deps.now();
  const to = Math.floor(now.getTime() / 1000);
  const cursor = await getLiveState<Cursor>(deps.db, STATE_DISCOVERY_CURSOR);
  let base = cursor?.at;
  if (base === undefined) {
    const latest = await latestGraduatedAt(deps.db);
    base = latest ? Math.floor(latest.getTime() / 1000) : to;
    deps.log.info(
      latest
        ? 'discovery: no cursor, starting at the latest graduation in the database'
        : 'discovery: no cursor and no coins, starting now',
      { startsAt: new Date(base * 1000).toISOString() },
    );
  }
  const pass = await readGraduates(
    deps,
    { from: base - DISCOVERY_OVERLAP_SECONDS, to },
    { moveCursor: true },
  );
  pass.cursor ??= cursor?.at ?? null;
  await setLiveState(
    deps.db,
    STATE_LAST_DISCOVERY,
    {
      at: now.toISOString(),
      status: pass.status,
      windows: pass.windows,
      seen: pass.seen,
      found: pass.found,
      ...(pass.error ? { error: pass.error } : {}),
    },
    now,
  );
  if (pass.status === 'error') {
    deps.log.warn(`discovery failed after ${pass.windows} windows: ${pass.error}; will retry`);
  } else if (pass.found > 0) {
    deps.log.info(`discovery: ${pass.found} new graduates`, { windows: pass.windows });
  }
  return pass;
}
