import { sql, type Kysely } from 'kysely';
import type { Database } from './types.js';
import type { Resolution } from './candles.js';

/** A requested time range, unix seconds, `to` exclusive. */
export interface CoverageInterval {
  from: number;
  to: number;
}

/**
 * Records that bars for `[from, to)` were requested for a pool, whether or not
 * any came back. Recording the same range twice changes nothing.
 */
export async function addCoverage(
  db: Kysely<Database>,
  poolId: number,
  resolutionSec: Resolution,
  range: CoverageInterval,
  reason: string,
): Promise<void> {
  if (!Number.isInteger(range.from) || !Number.isInteger(range.to) || range.to <= range.from) {
    throw new Error(`Bad coverage range ${range.from}..${range.to}`);
  }
  await db
    .insertInto('candle_coverage')
    .values({
      pool_id: poolId,
      resolution_sec: resolutionSec,
      from_t: range.from,
      to_t: range.to,
      reason,
    })
    .onConflict((oc) => oc.doNothing())
    .execute();
}

/** Every recorded range of one pool and resolution, sorted by `from`. Not merged. */
export async function getCoverage(
  db: Kysely<Database>,
  poolId: number,
  resolutionSec: Resolution,
): Promise<CoverageInterval[]> {
  const rows = await db
    .selectFrom('candle_coverage')
    .select(['from_t', 'to_t'])
    .where('pool_id', '=', poolId)
    .where('resolution_sec', '=', resolutionSec)
    .orderBy('from_t')
    .orderBy('to_t')
    .execute();
  return rows.map((r) => ({ from: r.from_t, to: r.to_t }));
}

/** Number of recorded requests with this reason across all pools of a coin. */
export async function countCoverageRequests(
  db: Kysely<Database>,
  coinId: number,
  reason: string,
): Promise<number> {
  const { rows } = await sql<{ n: number }>`
    select count(*)::int as n
    from candle_coverage cc join pools p on p.id = cc.pool_id
    where p.coin_id = ${coinId} and cc.reason = ${reason}`.execute(db);
  return rows[0]?.n ?? 0;
}
