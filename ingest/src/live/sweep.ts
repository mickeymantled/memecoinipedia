/**
 * The daily sweep, in two parts:
 *
 * 1. Read discovery again for the last 48 hours (the cursor is not touched).
 * 2. Queue the candle stage for every watched coin that is 24 hours old or more and was never
 *    fetched. That covers the coins that passed 24 hours that day, and the ones that leave the
 *    14-day window before the next sweep: both are among the watched coins at least a day old.
 *    The staged fetch screens such a coin with daily bars and stops cheaply when it cannot have
 *    reached $100,000; a coin that spiked and fell back between two polls has a daily bar that
 *    shows it, and gets the full fetch.
 *
 * 3. The last look: a watched coin 13 days old or more, listed or not, whose candles last finished
 *    before it was 13 days old, is fetched once more (its candles and metrics reopened). With fresh
 *    daily bars the staged fetch screens it cheaply; a spike that the hourly polls of days 3 to 14
 *    missed shows in a daily bar. The fetch finishes after the 13th day, so the coin is not
 *    found again.
 * 4. A watched coin whose candles stage is `failed`, or whose metrics stage is `failed`, is retried (the same requeue as
 *    `backfill run --retry-failed`), once a day.
 *
 * The sweep is done for the UTC day when both parts finished. If discovery failed or was paused,
 * the candles are still queued (the stage's own gate holds them while the ceiling is reached, and
 * they are queued again when it lifts), but the sweep is not recorded, and is tried again after
 * `SWEEP_RETRY_SECONDS`.
 */
import {
  bumpLiveCounters,
  getLiveState,
  listLastLook,
  listWatchedFailures,
  listWatchedOlderThan,
  reopenForFetch,
  requeueFailed,
  setLiveState,
  triggerCandles,
} from '@memecoinipedia/db';
import {
  LAST_LOOK_AGE_SECONDS,
  STATE_LAST_SWEEP,
  SWEEP_AFTER_UTC_SECONDS,
  SWEEP_MIN_AGE_SECONDS,
  SWEEP_PAGE,
  SWEEP_REREAD_SECONDS,
  dayKey,
} from './constants.js';
import type { LiveDeps } from './deps.js';
import { readGraduates, type DiscoveryPass } from './discover.js';
import { startOfUtcDay, watchSpec } from './util.js';

export interface LastSweep {
  /** When the sweep finished (ISO 8601). */
  at: string;
  found: number;
  queued: number;
}

export interface SweepPass {
  discovery: DiscoveryPass;
  /** Watched coins at least a day old that were queued for candles. */
  queued: number;
  /** Of those, the ones that had no candles row yet. */
  newlySwept: number;
  /** Coins fetched once more by the last look. */
  lastLook: number;
  /** Watched coins whose failed candles were retried. */
  retried: number;
  /** True when both parts finished and the sweep was recorded. */
  complete: boolean;
}

/** True when no sweep has finished yet on this UTC day and the day is `SWEEP_AFTER_UTC_SECONDS` old. */
export async function sweepDue(deps: LiveDeps): Promise<boolean> {
  const now = deps.now();
  const last = await getLiveState<LastSweep>(deps.db, STATE_LAST_SWEEP);
  const today = startOfUtcDay(now);
  if (last && new Date(last.at) >= today) return false;
  return now.getTime() - today.getTime() >= SWEEP_AFTER_UTC_SECONDS * 1000;
}

export async function sweepOnce(deps: LiveDeps): Promise<SweepPass> {
  const now = deps.now();
  const to = Math.floor(now.getTime() / 1000);
  const discovery = await readGraduates(
    deps,
    { from: to - SWEEP_REREAD_SECONDS, to },
    { moveCursor: false },
  );

  // Read the watched set as of the moment the sweep began, after discovery stored what it found.
  const at = deps.now();
  let queued = 0;
  let newlySwept = 0;
  for (let afterId = 0; ;) {
    const ids = await listWatchedOlderThan(deps.db, watchSpec(at), SWEEP_MIN_AGE_SECONDS, {
      afterId,
      limit: SWEEP_PAGE,
    });
    if (ids.length === 0) break;
    const fresh = await triggerCandles(deps.db, ids, {
      now: at,
      dayKey: dayKey(at),
      counter: 'swept',
    });
    newlySwept += fresh.length;
    await deps.enqueue('candles', ids);
    queued += ids.length;
    afterId = ids[ids.length - 1]!;
    if (ids.length < SWEEP_PAGE) break;
  }

  let lastLook = 0;
  for (let afterId = 0; ;) {
    const ids = await listLastLook(
      deps.db,
      { ...watchSpec(at), minAgeSeconds: LAST_LOOK_AGE_SECONDS },
      { afterId, limit: SWEEP_PAGE },
    );
    if (ids.length === 0) break;
    const reopened = await reopenForFetch(deps.db, ids, {
      now: at,
      dayKey: dayKey(at),
      counter: 'lastlook',
    });
    if (reopened.length > 0) await deps.enqueue('candles', reopened);
    lastLook += reopened.length;
    afterId = ids[ids.length - 1]!;
    if (ids.length < SWEEP_PAGE) break;
  }

  let retried = 0;
  for (let afterId = 0; ;) {
    const rows = await listWatchedFailures(deps.db, watchSpec(at), { afterId, limit: SWEEP_PAGE });
    if (rows.length === 0) break;
    for (const [stage, which] of [
      ['candles', rows.filter((r) => r.candlesFailed)],
      ['metrics', rows.filter((r) => r.metricsFailed)],
    ] as const) {
      if (which.length === 0) continue;
      const n = await requeueFailed(deps.db, [stage], {
        addresses: which.map((r) => r.address),
        now: at,
      });
      if (n > 0) {
        await bumpLiveCounters(deps.db, dayKey(at), { retried: n }, at);
        await deps.enqueue(
          stage,
          which.map((r) => r.id),
        );
      }
      retried += n;
    }
    afterId = rows[rows.length - 1]!.id;
    if (rows.length < SWEEP_PAGE) break;
  }

  const complete = discovery.status === 'ok';
  if (complete) {
    await setLiveState(
      deps.db,
      STATE_LAST_SWEEP,
      { at: at.toISOString(), found: discovery.found, queued } satisfies LastSweep,
      at,
    );
  }
  deps.log.info(
    complete
      ? `sweep done: ${discovery.found} new graduates, ${queued} coins queued for candles, ${lastLook} last looks, ${retried} failed retried`
      : `sweep incomplete (discovery ${discovery.status}): ${queued} coins queued for candles; will try again later`,
  );
  return { discovery, queued, newlySwept, lastLook, retried, complete };
}
