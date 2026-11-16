import { sql, type Kysely } from 'kysely';
import type { Database } from './types.js';

/**
 * One OHLCV bucket. Same fields as `Bar` in ingest/src/metrics/types.ts; the
 * type is repeated here because /db must not import from /ingest.
 */
export interface CandleBar {
  /** Start of the bucket, unix seconds, UTC. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  volumeUsd: number;
  trades: number;
  traders: number;
  liquidityUsd: number | null;
}

export type Resolution = 60 | 3600 | 86400;

export const CHUNK_BARS = 1440;

export interface BarRange {
  /** Inclusive, unix seconds. */
  from?: number;
  /** Exclusive, unix seconds. */
  to?: number;
}

/** Seconds covered by one chunk. */
export function chunkSpan(resolutionSec: number): number {
  return resolutionSec * CHUNK_BARS;
}

/** `t` rounded down to the chunk span. */
export function chunkStartOf(t: number, resolutionSec: number): number {
  const span = chunkSpan(resolutionSec);
  return Math.floor(t / span) * span;
}

type ChunkRow = {
  t: number[];
  o: number[];
  h: number[];
  l: number[];
  c: number[];
  volume_usd: number[];
  trades: number[];
  traders: number[];
  liquidity_usd: (number | null)[];
};

function rowToBars(row: ChunkRow): CandleBar[] {
  return row.t.map((t, i) => ({
    t,
    o: row.o[i]!,
    h: row.h[i]!,
    l: row.l[i]!,
    c: row.c[i]!,
    volumeUsd: row.volume_usd[i]!,
    trades: row.trades[i]!,
    traders: row.traders[i]!,
    liquidityUsd: row.liquidity_usd[i] ?? null,
  }));
}

function barsToRow(bars: CandleBar[]): ChunkRow & {
  bar_count: number;
  first_t: number;
  last_t: number;
} {
  return {
    bar_count: bars.length,
    first_t: bars[0]!.t,
    last_t: bars[bars.length - 1]!.t,
    t: bars.map((b) => b.t),
    o: bars.map((b) => b.o),
    h: bars.map((b) => b.h),
    l: bars.map((b) => b.l),
    c: bars.map((b) => b.c),
    volume_usd: bars.map((b) => b.volumeUsd),
    trades: bars.map((b) => b.trades),
    traders: bars.map((b) => b.traders),
    liquidity_usd: bars.map((b) => b.liquidityUsd),
  };
}

/**
 * Merges bars into the pool's chunks inside one transaction. Bars with the same
 * `t` are de-duplicated and the new bar wins (the last one wins within the
 * input). Arrays stay sorted by `t`. Writing the same bars again changes
 * nothing.
 */
export async function putBars(
  db: Kysely<Database>,
  poolId: number,
  resolutionSec: Resolution,
  bars: readonly CandleBar[],
): Promise<void> {
  if (bars.length === 0) return;
  const byChunk = new Map<number, Map<number, CandleBar>>();
  for (const bar of bars) {
    if (!Number.isInteger(bar.t)) throw new Error(`Bar t must be an integer, got ${bar.t}`);
    const start = chunkStartOf(bar.t, resolutionSec);
    let chunk = byChunk.get(start);
    if (!chunk) byChunk.set(start, (chunk = new Map()));
    chunk.set(bar.t, bar);
  }

  await db.transaction().execute(async (trx) => {
    // Serialises writers per pool so two merges into one chunk cannot lose bars.
    await sql`select pg_advisory_xact_lock(hashtext('candle_chunks'), (${poolId}::bigint % 2147483647)::int)`.execute(
      trx,
    );
    const starts = [...byChunk.keys()].sort((a, b) => a - b);
    const existing = await trx
      .selectFrom('candle_chunks')
      .selectAll()
      .where('pool_id', '=', poolId)
      .where('resolution_sec', '=', resolutionSec)
      .where(
        'chunk_start',
        'in',
        starts.map((s) => new Date(s * 1000)),
      )
      .forUpdate()
      .execute();
    const existingByStart = new Map(existing.map((r) => [r.chunk_start.getTime() / 1000, r]));

    for (const start of starts) {
      const merged = new Map<number, CandleBar>();
      const prior = existingByStart.get(start);
      if (prior) for (const b of rowToBars(prior)) merged.set(b.t, b);
      for (const [t, b] of byChunk.get(start)!) merged.set(t, b);
      const sorted = [...merged.values()].sort((a, b) => a.t - b.t);
      const row = barsToRow(sorted);
      await trx
        .insertInto('candle_chunks')
        .values({
          pool_id: poolId,
          resolution_sec: resolutionSec,
          chunk_start: new Date(start * 1000),
          ...row,
        })
        .onConflict((oc) =>
          oc.columns(['pool_id', 'resolution_sec', 'chunk_start']).doUpdateSet(row),
        )
        .execute();
    }
  });
}

/** Bars of one pool and resolution, sorted by `t`. `range.from` is inclusive, `range.to` exclusive. */
export async function getBars(
  db: Kysely<Database>,
  poolId: number,
  resolutionSec: Resolution,
  range: BarRange = {},
): Promise<CandleBar[]> {
  let q = db
    .selectFrom('candle_chunks')
    .selectAll()
    .where('pool_id', '=', poolId)
    .where('resolution_sec', '=', resolutionSec)
    .orderBy('chunk_start');
  if (range.from !== undefined) q = q.where('last_t', '>=', range.from);
  if (range.to !== undefined) q = q.where('first_t', '<', range.to);
  const rows = await q.execute();
  const out: CandleBar[] = [];
  for (const row of rows) {
    for (const bar of rowToBars(row)) {
      if (range.from !== undefined && bar.t < range.from) continue;
      if (range.to !== undefined && bar.t >= range.to) continue;
      out.push(bar);
    }
  }
  return out;
}
