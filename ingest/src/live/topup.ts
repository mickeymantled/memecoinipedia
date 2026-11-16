/**
 * The candle top-up: after the day's refresh has finished, reopen candles and metrics (the same
 * `reopenStages` a later trigger uses) for listed coins that are still alive and still trading, and
 * queue them. What selects a coin is one predicate in `db/src/refresh.ts` (`topUpWhere`): listed,
 * status alive, and either the current market cap is at least half the stored ATH or the newest
 * stored bar is more than 7 days old. Dead and rugged coins are never selected, and a coin whose
 * candles have not finished since it was reopened is not selected again.
 *
 * The pool list. A coin whose list was last read more than `TOPUP_POOL_LIST_MAX_AGE_DAYS` ago (the
 * stored `pools_listed_at`, else the age of its newest pool: `poolListReadAt` in `db/src/refresh.ts`)
 * is handed to the candles stage as a list read (`PoolListQueue`): the stage then lists the pools
 * again through the refresh path of the backfill, stores new pools under the current rules, and
 * fetches their bars with the others' up to the clock. The graduation role is never moved by it
 * (the data issue `graduation_pool_differs` is recorded instead). Each read is one more Codex.io
 * request, counted by the client like any other; the stage takes the coin only while the day's
 * gate is open, and the top-up hands out at most `topUpListsPerDay` reads a UTC day.
 *
 * The fetch itself asks only for bars after what is held: the candles stage plans from the stored
 * coverage (`candle_coverage`), so a coin with bars costs the new part only (tested by counting
 * requests and units).
 *
 * Spending. Top-ups come last: a pass queues none once the day's Codex.io units reach
 * `TOPUP_STOP_SHARE` of the ceiling or the gate is closed, and keeps at most `TOPUP_MAX_IN_FLIGHT`
 * listed coins waiting or running, feeding the queue a little at a time. The refresh, which costs
 * no units, is not affected by any of this.
 */
import {
  bumpLiveCounters,
  countListedInFlight,
  getLiveState,
  listPoolListDue,
  listTopUp,
  reopenForFetch,
} from '@memecoinipedia/db';
import {
  COUNTER_TOPUP_LISTS,
  REFRESH_LISTED_USD,
  TOPUP_ATH_SHARE,
  TOPUP_BATCH,
  TOPUP_MAX_IN_FLIGHT,
  TOPUP_POOL_LIST_MAX_AGE_SECONDS,
  TOPUP_STALE_BAR_SECONDS,
  TOPUP_STOP_SHARE,
  dayKey,
  topUpListsPerDay,
} from './constants.js';
import type { LiveDeps } from './deps.js';
import type { SpendGate } from './gate.js';
import { refreshDoneToday } from './refresh.js';
import { startOfUtcDay } from './util.js';

export interface TopUpPass {
  status: 'waiting_for_refresh' | 'paused' | 'full' | 'ran';
  /** Coins reopened and queued this pass. */
  queued: number;
  /** Of those, coins handed a pool list read. */
  lists: number;
}

/**
 * The coins whose next candles run reads the pool list again. The top-up adds to it; the candles
 * stage asks `take` as it takes a coin, which says yes once, and only while the day's gate is
 * open, so no list request is made at the ceiling (the mark stays for the next day). It is in
 * memory: a restart drops it, and the coin, still due, is handed a read by a later top-up.
 */
export interface PoolListQueue {
  add(coinIds: readonly number[]): void;
  take(coinId: number): boolean;
  readonly size: number;
}

export function createPoolListQueue(gate: Pick<SpendGate, 'admit'>): PoolListQueue {
  const marked = new Set<number>();
  return {
    add: (ids) => ids.forEach((id) => marked.add(id)),
    take(id) {
      if (!marked.has(id) || !gate.admit()) return false;
      marked.delete(id);
      return true;
    },
    get size() {
      return marked.size;
    },
  };
}

export const topUpSpec = (now: Date, refreshedSince: Date | null) => ({
  now,
  dayStart: startOfUtcDay(now),
  refreshedSince,
  listedUsd: REFRESH_LISTED_USD,
  athShare: TOPUP_ATH_SHARE,
  staleBarSeconds: TOPUP_STALE_BAR_SECONDS,
  poolListMaxAgeSeconds: TOPUP_POOL_LIST_MAX_AGE_SECONDS,
});

export async function topUpOnce(deps: LiveDeps): Promise<TopUpPass> {
  if (!(await refreshDoneToday(deps)))
    return { status: 'waiting_for_refresh', queued: 0, lists: 0 };
  const snap = deps.gate.snapshot();
  if (!snap.open || snap.usedToday >= snap.ceiling * TOPUP_STOP_SHARE) {
    return { status: 'paused', queued: 0, lists: 0 };
  }
  const room = TOPUP_MAX_IN_FLIGHT - (await countListedInFlight(deps.db, REFRESH_LISTED_USD));
  if (room <= 0) return { status: 'full', queued: 0, lists: 0 };
  const now = deps.now();
  const spec = topUpSpec(now, startOfUtcDay(now));
  const ids = await listTopUp(deps.db, spec, { afterId: 0, limit: Math.min(room, TOPUP_BATCH) });
  if (ids.length === 0) return { status: 'ran', queued: 0, lists: 0 };
  // Read before the stages are reopened: reopening clears the candles stage's finish time, which
  // is what a coin with neither a stored time nor a pool is aged by.
  const due = deps.poolLists
    ? await listPoolListDue(deps.db, ids, {
        now,
        maxAgeSeconds: TOPUP_POOL_LIST_MAX_AGE_SECONDS,
      })
    : [];
  const reopened = await reopenForFetch(deps.db, ids, {
    now,
    dayKey: dayKey(now),
    counter: 'topup',
  });
  let lists = 0;
  if (reopened.length > 0) {
    // Marked before the coins are queued: a worker may take one at once.
    lists = await handOutListReads(
      deps,
      due.filter((id) => reopened.includes(id)),
      snap.ceiling,
    );
    await deps.enqueue('candles', reopened);
    deps.log.info(
      `top-up: ${reopened.length} listed coins still trading queued for new bars` +
        (lists > 0 ? `, ${lists} of them to read the pool list again` : ''),
    );
  }
  return { status: 'ran', queued: reopened.length, lists };
}

/** Marks the reopened coins whose pool list is old (`due`), up to the day's share of the ceiling. */
async function handOutListReads(
  deps: LiveDeps,
  due: readonly number[],
  ceiling: number,
): Promise<number> {
  if (!deps.poolLists) return 0;
  const now = deps.now();
  const key = dayKey(now);
  const used =
    (await getLiveState<Record<string, number>>(deps.db, key))?.[COUNTER_TOPUP_LISTS] ?? 0;
  const room = topUpListsPerDay(ceiling) - used;
  if (room <= 0) return 0;
  const chosen = due.slice(0, room);
  if (chosen.length === 0) return 0;
  deps.poolLists.add(chosen);
  await bumpLiveCounters(deps.db, key, { [COUNTER_TOPUP_LISTS]: chosen.length }, now);
  return chosen.length;
}
