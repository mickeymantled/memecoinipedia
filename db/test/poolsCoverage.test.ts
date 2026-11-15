import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { sql } from 'kysely';
import { addCoverage, countCoverageRequests, getCoverage } from '../src/candleCoverage.js';
import { putBars, type CandleBar } from '../src/candles.js';
import { upsertCoin } from '../src/coins.js';
import { recordDataIssue } from '../src/dataIssues.js';
import { getCoinPools, refreshPoolBarStats, upsertPool } from '../src/pools.js';
import { createTestDatabase, type TestDatabase } from '../src/testing.js';
import { adminUrl, describeDb } from './helpers.js';

const bar = (t: number, liq: number | null): CandleBar => ({
  t,
  o: 1,
  h: 2,
  l: 0.5,
  c: 1.5,
  volumeUsd: 10,
  trades: 3,
  traders: 2,
  liquidityUsd: liq,
});

describeDb('pools, coverage and data issues', () => {
  let t: TestDatabase;
  let coinId = 0;
  let n = 0;
  beforeAll(async () => {
    t = await createTestDatabase(adminUrl!);
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    n++;
    coinId = await upsertCoin(t.db, { chain: 'solana', address: `coin${n}` });
  });

  const base = () => ({
    chain: 'solana',
    address: `pool${n}`,
    coinId,
    dex: 'PumpSwap',
    isPrimary: true,
    isGraduationPool: true,
    quoteToken: 'SOL',
    createdAtChain: 1_700_000_000,
    sourcePairId: `pool${n}:1399811149`,
  });
  const row = (id: number) =>
    t.db.selectFrom('pools').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

  it('upserts a pool on chain plus address and leaves the row alone when nothing changed', async () => {
    const id = await upsertPool(t.db, base());
    const before = await row(id);
    expect(before).toMatchObject({
      dex: 'PumpSwap',
      is_primary: true,
      is_graduation_pool: true,
      quote_token: 'SOL',
    });
    expect(before.created_at_chain).toEqual(new Date(1_700_000_000_000));

    // Make updated_at distinguishable, then upsert the same values: not touched.
    await sql`update pools set updated_at = '2020-01-01T00:00:00Z' where id = ${id}`.execute(t.db);
    expect(await upsertPool(t.db, base())).toBe(id);
    expect((await row(id)).updated_at).toEqual(new Date('2020-01-01'));

    // A change updates the row, not a second row.
    expect(await upsertPool(t.db, { ...base(), dex: 'Raydium' })).toBe(id);
    const after = await row(id);
    expect(after.dex).toBe('Raydium');
    expect(after.updated_at.getTime()).toBeGreaterThan(new Date('2020-01-01').getTime());
    expect(await getCoinPools(t.db, coinId)).toHaveLength(1);
  });

  it('refuses to move a pool to another coin', async () => {
    await upsertPool(t.db, base());
    const other = await upsertCoin(t.db, { chain: 'solana', address: `other${n}` });
    await expect(upsertPool(t.db, { ...base(), coinId: other })).rejects.toThrow(/already belongs/);
  });

  it('lists the pools of a coin with their roles', async () => {
    await upsertPool(t.db, base());
    await upsertPool(t.db, {
      ...base(),
      address: `curve${n}`,
      isGraduationPool: false,
      createdAtChain: null,
    });
    await upsertPool(t.db, {
      ...base(),
      address: `side${n}`,
      isPrimary: false,
      isGraduationPool: false,
    });
    const pools = await getCoinPools(t.db, coinId);
    expect(pools.map((p) => [p.isPrimary, p.isGraduationPool])).toEqual([
      [true, true],
      [true, false],
      [false, false],
    ]);
    expect(pools[1]!.createdAtChain).toBeNull();
    expect(pools[0]!.createdAtChain).toBe(1_700_000_000);
  });

  it('sets bar span and peak liquidity from stored candles, and only writes when they change', async () => {
    const id = await upsertPool(t.db, base());
    await refreshPoolBarStats(t.db, id); // no bars: nothing happens
    expect((await row(id)).first_bar_at).toBeNull();

    await putBars(t.db, id, 3600, [bar(3_600_000, 100), bar(3_603_600, 9_000)]);
    await putBars(t.db, id, 86400, [bar(86_400_000, 500)]);
    await refreshPoolBarStats(t.db, id);
    const r = await row(id);
    expect(r.first_bar_at).toEqual(new Date(3_600_000 * 1000));
    expect(r.last_bar_at).toEqual(new Date(86_400_000 * 1000));
    expect(r.peak_liquidity_usd).toBe(9_000);

    await sql`update pools set updated_at = '2020-01-01T00:00:00Z' where id = ${id}`.execute(t.db);
    await refreshPoolBarStats(t.db, id);
    expect((await row(id)).updated_at).toEqual(new Date('2020-01-01'));
  });

  it('records coverage once per range, never merges it, and counts by reason', async () => {
    const id = await upsertPool(t.db, base());
    await addCoverage(t.db, id, 60, { from: 100, to: 200 }, 'peak_refinement');
    await addCoverage(t.db, id, 60, { from: 100, to: 200 }, 'peak_refinement'); // same again
    await addCoverage(t.db, id, 60, { from: 200, to: 300 }, 'peak_refinement');
    await addCoverage(t.db, id, 3600, { from: 0, to: 3600 }, 'hourly_life');
    expect(await getCoverage(t.db, id, 60)).toEqual([
      { from: 100, to: 200 },
      { from: 200, to: 300 },
    ]);
    expect(await getCoverage(t.db, id, 3600)).toEqual([{ from: 0, to: 3600 }]);
    expect(await getCoverage(t.db, id, 86400)).toEqual([]);
    expect(await countCoverageRequests(t.db, coinId, 'peak_refinement')).toBe(2);
    expect(await countCoverageRequests(t.db, coinId, 'hourly_life')).toBe(1);
    await expect(addCoverage(t.db, id, 60, { from: 5, to: 5 }, 'x')).rejects.toThrow(
      /Bad coverage/,
    );
  });

  it('adds a data issue once while it is open, and again after it is resolved', async () => {
    const a = await recordDataIssue(t.db, coinId, 'graduation_pool_not_found', { why: 1 });
    expect(a.created).toBe(true);
    const b = await recordDataIssue(t.db, coinId, 'graduation_pool_not_found', { why: 2 });
    expect(b).toEqual({ id: a.id, created: false });
    const c = await recordDataIssue(t.db, coinId, 'other_kind');
    expect(c.created).toBe(true);
    const rows = await t.db
      .selectFrom('data_issues')
      .selectAll()
      .where('coin_id', '=', coinId)
      .execute();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === a.id)!.detail).toEqual({ why: 1 });

    await t.db
      .updateTable('data_issues')
      .set({ resolved_at: new Date(), resolution: 'fixed' })
      .where('id', '=', a.id)
      .execute();
    const d = await recordDataIssue(t.db, coinId, 'graduation_pool_not_found');
    expect(d.created).toBe(true);
  });
});
