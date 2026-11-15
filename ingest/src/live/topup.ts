/**
 * The candle top-up: after the day's refresh has finished, reopen candles and metrics (the same
 * `reopenStages` a later trigger uses) for listed coins that are still alive and still trading, and
 * queue them. What selects a coin is one predicate in `db/src/refresh.ts` (`topUpWhere`): listed,
 * status alive, and either the current market cap is at least half the stored ATH or the newest
 * stored bar is more than 7 days old. Dead and rugged coins are never selected, and a coin whose
 * candles have not finished since it was reopened is not selected again.
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
import { countListedInFlight, listTopUp, reopenForFetch } from '@memecoinipedia/db';
import {
  REFRESH_LISTED_USD,
  TOPUP_ATH_SHARE,
  TOPUP_BATCH,
  TOPUP_MAX_IN_FLIGHT,
  TOPUP_STALE_BAR_SECONDS,
  TOPUP_STOP_SHARE,
  dayKey,
} from './constants.js';
import type { LiveDeps } from './deps.js';
import { refreshDoneToday } from './refresh.js';
import { startOfUtcDay } from './util.js';

export interface TopUpPass {
  status: 'waiting_for_refresh' | 'paused' | 'full' | 'ran';
  /** Coins reopened and queued this pass. */
  queued: number;
}

export const topUpSpec = (now: Date, refreshedSince: Date | null) => ({
  now,
  dayStart: startOfUtcDay(now),
  refreshedSince,
  listedUsd: REFRESH_LISTED_USD,
  athShare: TOPUP_ATH_SHARE,
  staleBarSeconds: TOPUP_STALE_BAR_SECONDS,
});

export async function topUpOnce(deps: LiveDeps): Promise<TopUpPass> {
  if (!(await refreshDoneToday(deps))) return { status: 'waiting_for_refresh', queued: 0 };
  const snap = deps.gate.snapshot();
  if (!snap.open || snap.usedToday >= snap.ceiling * TOPUP_STOP_SHARE) {
    return { status: 'paused', queued: 0 };
  }
  const room = TOPUP_MAX_IN_FLIGHT - (await countListedInFlight(deps.db, REFRESH_LISTED_USD));
  if (room <= 0) return { status: 'full', queued: 0 };
  const now = deps.now();
  const spec = topUpSpec(now, startOfUtcDay(now));
  const ids = await listTopUp(deps.db, spec, { afterId: 0, limit: Math.min(room, TOPUP_BATCH) });
  if (ids.length === 0) return { status: 'ran', queued: 0 };
  const reopened = await reopenForFetch(deps.db, ids, {
    now,
    dayKey: dayKey(now),
    counter: 'topup',
  });
  if (reopened.length > 0) {
    await deps.enqueue('candles', reopened);
    deps.log.info(`top-up: ${reopened.length} listed coins still trading queued for new bars`);
  }
  return { status: 'ran', queued: reopened.length };
}
