import { afterAll, beforeAll, expect, it } from 'vitest';
import { upsertCoin } from '../src/coins.js';
import { seed } from '../src/seed.js';
import { createTestDatabase, type TestDatabase } from '../src/testing.js';
import { adminUrl, describeDb } from './helpers.js';

describeDb('seed', () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase(adminUrl!);
  });
  afterAll(async () => {
    await t.drop();
  });

  const ids = async () =>
    (await t.db.selectFrom('coins').select('id').orderBy('id').execute()).map((r) => r.id);

  it('loads 20 coins and leaves the same 20 after a second run', async () => {
    expect(await seed(t.db)).toBe(20);
    const first = await ids();
    expect(first).toHaveLength(20);
    await seed(t.db);
    expect(await ids()).toEqual(first);
    const row = await t.db
      .selectFrom('coins')
      .selectAll()
      .where('ticker', '=', 'FARTCOIN')
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      chain: 'solana',
      launchpad: 'pump.fun',
      name: 'Fartcoin',
      status: 'unknown',
    });
  });

  it('upsertCoin leaves fields it was not given alone', async () => {
    const id = await upsertCoin(t.db, { chain: 'solana', address: 'X1', ticker: 'X', name: 'Ex' });
    expect(await upsertCoin(t.db, { chain: 'solana', address: 'X1', name: 'Why' })).toBe(id);
    const row = await t.db
      .selectFrom('coins')
      .select(['ticker', 'name'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ ticker: 'X', name: 'Why' });
  });
});
