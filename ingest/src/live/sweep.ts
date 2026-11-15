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
 * The sweep is done for the UTC day when both parts finished. If discovery failed or was paused,
 * the candles are still queued (the stage's own gate holds them while the ceiling is reached, and
 * they are queued again when it lifts), but the sweep is not recorded, and is tried again after
 * `SWEEP_RETRY_SECONDS`.
 */
import {
  getLiveState,
  listWatchedOlderThan,
  setLiveState,
  triggerCandles,
} from '@memecoinipedia/db';
import {
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
      ? `sweep done: ${discovery.found} new graduates, ${queued} coins queued for candles`
      : `sweep incomplete (discovery ${discovery.status}): ${queued} coins queued for candles; will try again later`,
  );
  return { discovery, queued, newlySwept, complete };
}
