import { getLiveState, setLiveState, type Database } from '@memecoinipedia/db';
import type { Kysely } from 'kysely';
import { STATE_LAST_WATCH } from './constants.js';

/**
 * What the watch loop stores about itself, in `live_state` under `last_watch`: when its last pass
 * ended, and when the last pass ended without a failed price request and without ending paused for a Jupiter rate limit. A pass with nothing due
 * still writes it. `live health` reads it to tell "the loop is not running" (`endedAt` is old)
 * from "Jupiter is not answering" (`okAt` is old while `endedAt` is recent).
 */
export interface WatchRecord {
  endedAt: string;
  /** null until a pass has ended without a failed price request and without ending paused. */
  okAt: string | null;
}

/** Writes the record for a pass that ended at `endedAt`; `ok` is false when a price request failed or the pass ended paused. */
export async function recordWatchPass(
  db: Kysely<Database>,
  endedAt: Date,
  ok: boolean,
): Promise<void> {
  let okAt: string | null = ok ? endedAt.toISOString() : null;
  if (!ok) {
    const before = await getLiveState<Partial<WatchRecord>>(db, STATE_LAST_WATCH);
    okAt = typeof before?.okAt === 'string' ? before.okAt : null;
  }
  const record: WatchRecord = { endedAt: endedAt.toISOString(), okAt };
  await setLiveState(db, STATE_LAST_WATCH, record, endedAt);
}
