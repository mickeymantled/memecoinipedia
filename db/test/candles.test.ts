import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { sql } from 'kysely';
import { chunkSpan, getBars, putBars, type CandleBar } from '../src/candles.js';
import { createTestDatabase, type TestDatabase } from '../src/testing.js';
import { adminUrl, describeDb } from './helpers.js';

const bar = (t: number, price = 1, liq: number | null = 100): CandleBar => ({
  t,
  o: price,
  h: price * 1.1,
  l: price * 0.9,
  c: price,
  volumeUsd: price * 10,
  trades: 3,
  traders: 2,
  liquidityUsd: liq,
});

describeDb('candles', () => {
  let t: TestDatabase;
  let poolId = 0;
  let n = 0;
  beforeAll(async () => {
    t = await createTestDatabase(adminUrl!);
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    n++;
    const coin = await t.db
      .insertInto('coins')
      .values({ chain: 'solana', address: `coin${n}` })
      .returning('id')
      .executeTakeFirstOrThrow();
    const pool = await t.db
      .insertInto('pools')
      .values({ chain: 'solana', address: `pool${n}`, coin_id: coin.id, dex: 'Pump' })
      .returning('id')
      .executeTakeFirstOrThrow();
    poolId = pool.id;
  });

  const chunkRows = () =>
    t.db
      .selectFrom('candle_chunks')
      .selectAll()
      .where('pool_id', '=', poolId)
      .orderBy('chunk_start')
      .execute();

  it('round-trips bars, including null liquidity, sorted by t', async () => {
    const bars = [bar(180, 3, null), bar(60, 1), bar(120, 2, 0)];
    await putBars(t.db, poolId, 60, bars);
    const got = await getBars(t.db, poolId, 60);
    expect(got).toEqual([...bars].sort((a, b) => a.t - b.t));
    expect(got[2]!.liquidityUsd).toBeNull();
  });

  it('keeps exact double values', async () => {
    const b = { ...bar(60), o: 6.38571506854e-5, h: 1 / 3, volumeUsd: 16982.899180329 };
    await putBars(t.db, poolId, 60, [b]);
    expect(await getBars(t.db, poolId, 60)).toEqual([b]);
  });

  it('splits a list that crosses a chunk boundary and reads it back whole', async () => {
    const span = chunkSpan(60); // 86400
    const base = 1_700_000_000 - (1_700_000_000 % span); // a chunk start
    const bars = [base + span - 120, base + span - 60, base + span, base + span + 60].map((x) =>
      bar(x),
    );
    await putBars(t.db, poolId, 60, bars);
    const rows = await chunkRows();
    expect(rows.map((r) => r.bar_count)).toEqual([2, 2]);
    expect(rows[0]!.chunk_start.getTime() / 1000).toBe(base);
    expect(rows[1]!.first_t).toBe(base + span);
    expect(await getBars(t.db, poolId, 60)).toEqual(bars);
  });

  it('merges into an existing chunk and keeps order', async () => {
    await putBars(t.db, poolId, 60, [bar(60), bar(240)]);
    await putBars(t.db, poolId, 60, [bar(120), bar(180), bar(300)]);
    expect((await getBars(t.db, poolId, 60)).map((b) => b.t)).toEqual([60, 120, 180, 240, 300]);
    expect(await chunkRows()).toHaveLength(1);
  });

  it('lets the new bar win on overwrite, and the last one within one call', async () => {
    await putBars(t.db, poolId, 60, [bar(60, 1), bar(120, 2)]);
    await putBars(t.db, poolId, 60, [bar(120, 9, null), bar(120, 7, 5)]);
    const got = await getBars(t.db, poolId, 60);
    expect(got).toEqual([bar(60, 1), bar(120, 7, 5)]);
  });

  it('is idempotent', async () => {
    const bars = [bar(60), bar(120), bar(86400 + 60)];
    await putBars(t.db, poolId, 60, bars);
    const snap = async () =>
      (
        await sql`select * from candle_chunks where pool_id = ${poolId} order by chunk_start`.execute(
          t.db,
        )
      ).rows;
    const first = await snap();
    await putBars(t.db, poolId, 60, bars);
    await putBars(t.db, poolId, 60, bars);
    expect(await snap()).toEqual(first);
    expect(await getBars(t.db, poolId, 60)).toEqual(bars);
  });

  it('keeps resolutions apart and honours ranges (from inclusive, to exclusive)', async () => {
    await putBars(t.db, poolId, 60, [bar(60), bar(120), bar(180)]);
    await putBars(t.db, poolId, 3600, [bar(3600)]);
    expect((await getBars(t.db, poolId, 3600)).map((b) => b.t)).toEqual([3600]);
    expect((await getBars(t.db, poolId, 60, { from: 120, to: 180 })).map((b) => b.t)).toEqual([
      120,
    ]);
    expect((await getBars(t.db, poolId, 60, { from: 121 })).map((b) => b.t)).toEqual([180]);
    expect(await getBars(t.db, poolId, 60, { from: 10_000 })).toEqual([]);
  });

  it('returns nothing for a pool without bars and ignores an empty write', async () => {
    await putBars(t.db, poolId, 60, []);
    expect(await getBars(t.db, poolId, 60)).toEqual([]);
  });

  it('survives concurrent writers into the same chunk', async () => {
    await Promise.all(
      [0, 1, 2, 3, 4, 5].map((i) => putBars(t.db, poolId, 60, [bar(60 * (i + 1), i + 1)])),
    );
    expect((await getBars(t.db, poolId, 60)).map((b) => b.t)).toEqual([
      60, 120, 180, 240, 300, 360,
    ]);
  });

  it('rejects a non-integer t', async () => {
    await expect(putBars(t.db, poolId, 60, [bar(60.5)])).rejects.toThrow(/integer/);
  });
});
