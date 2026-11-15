import { afterAll, beforeAll, expect, it } from 'vitest';
import { sql } from 'kysely';
import { insertSyntheticCoins, syntheticCoins } from '../src/synthetic.js';
import { createTestDatabase, type TestDatabase } from '../src/testing.js';
import { adminUrl, describeDb } from './helpers.js';

it('generates the same coins for the same seed, with unique base58 addresses', () => {
  const a = [...syntheticCoins(500, 3)];
  const b = [...syntheticCoins(500, 3)];
  expect(a).toEqual(b);
  expect([...syntheticCoins(5, 4)]).not.toEqual(a.slice(0, 5));
  expect(new Set(a.map((c) => c.address)).size).toBe(500);
  for (const c of a) expect(c.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{44}$/);
  const listed = a.filter((c) => c.ath !== null && c.ath >= 100_000).length;
  expect(listed).toBeGreaterThan(350);
  expect(listed).toBeLessThan(480);
});

describeDb('insertSyntheticCoins', () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase(adminUrl!);
  });
  afterAll(async () => {
    await t.drop();
  });

  it('loads coins that satisfy the schema, in batches', async () => {
    const n = await insertSyntheticCoins(t.db, { count: 1200, seed: 5, batchSize: 500 });
    expect(n).toBe(1200);
    const { rows } = await sql<{
      total: number;
      listed: number;
      unclassified: number;
      no_launch: number;
    }>`select count(*)::int as total,
              count(*) filter (where ath_market_cap_usd >= 100000)::int as listed,
              count(*) filter (where primary_narrative is null)::int as unclassified,
              count(*) filter (where launched_at is null)::int as no_launch
       from coins`.execute(t.db);
    expect(rows[0]!.total).toBe(1200);
    expect(rows[0]!.listed).toBeGreaterThan(900);
    expect(rows[0]!.unclassified).toBeGreaterThan(0);
    expect(rows[0]!.no_launch).toBeGreaterThan(0);
  });
});
