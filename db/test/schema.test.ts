import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createTestDatabase, type TestDatabase } from '../src/testing.js';
import { databaseShape } from '../src/types.js';
import { adminUrl, describeDb } from './helpers.js';

const TAXONOMY = [
  'AI',
  'tech',
  'animal',
  'celebrity',
  'political',
  'news event',
  'culture/meme',
  'gaming',
  'derivative',
  'utility',
  'other',
];

describeDb('schema', () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase(adminUrl!);
  });
  afterAll(async () => {
    await t.drop();
  });

  const addCoin = (address = 'A1', chain = 'solana') =>
    t.db.insertInto('coins').values({ chain, address }).returning('id').executeTakeFirstOrThrow();

  it('seeds the 11 narratives with the exact taxonomy labels, in order', async () => {
    const rows = await t.db.selectFrom('narratives').selectAll().orderBy('sort_order').execute();
    expect(rows.map((r) => r.label)).toEqual(TAXONOMY);
    expect(rows.map((r) => r.slug)).toEqual([
      'ai',
      'tech',
      'animal',
      'celebrity',
      'political',
      'news_event',
      'culture_meme',
      'gaming',
      'derivative',
      'utility',
      'other',
    ]);
  });

  it('keeps the labels in step with the taxonomy in AGENTS.md', async () => {
    const agents = await readFile(new URL('../../AGENTS.md', import.meta.url), 'utf8');
    const section = agents.split('## Narrative taxonomy')[1]!.split('\n## ')[0]!;
    const labels = section.replace(/\s+/g, ' ').trim().replace(/\.$/, '').split(', ');
    expect(labels).toEqual(TAXONOMY);
  });

  it('enforces unique (chain, address) on coins and pools', async () => {
    const { id } = await addCoin('U1');
    await expect(addCoin('U1')).rejects.toThrow(/coins_chain_address_key/);
    await expect(addCoin('U1', 'base')).resolves.toBeDefined();
    const pool = { chain: 'solana', address: 'P1', coin_id: id, dex: 'Raydium' };
    await t.db.insertInto('pools').values(pool).execute();
    await expect(t.db.insertInto('pools').values(pool).execute()).rejects.toThrow(
      /pools_chain_address_key/,
    );
  });

  it('rejects more than 3 secondary narratives, a bad status and bad confidence', async () => {
    const insert = (v: Record<string, unknown>) =>
      t.db
        .insertInto('coins')
        .values({ chain: 'solana', ...v } as never)
        .execute();
    await expect(
      insert({ address: 'S1', secondary_narratives: ['ai', 'tech', 'animal', 'gaming'] }),
    ).rejects.toThrow(/secondary_narratives/);
    await expect(insert({ address: 'S2', status: 'zombie' })).rejects.toThrow(/status/);
    await expect(insert({ address: 'S3', narrative_confidence: 1.5 })).rejects.toThrow(
      /narrative_confidence/,
    );
    await expect(insert({ address: 'S4', primary_narrative: 'nope' })).rejects.toThrow(
      /foreign key/,
    );
    await expect(
      insert({ address: 'S5', secondary_narratives: ['ai', 'tech', 'animal'] }),
    ).resolves.toBeDefined();
  });

  it('rejects candle chunks whose arrays disagree with bar_count', async () => {
    const { id } = await addCoin('C1');
    const pool = await t.db
      .insertInto('pools')
      .values({ chain: 'solana', address: 'CP1', coin_id: id, dex: 'Pump' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const row = {
      pool_id: pool.id,
      resolution_sec: 60 as const,
      chunk_start: new Date(0),
      bar_count: 2,
      first_t: 0,
      last_t: 60,
      t: [0, 60],
      o: [1, 1],
      h: [1, 1],
      l: [1, 1],
      c: [1, 1],
      volume_usd: [1, 1],
      trades: [1, 1],
      traders: [1, 1],
      liquidity_usd: [1, null],
    };
    await expect(
      t.db
        .insertInto('candle_chunks')
        .values({ ...row, o: [1] })
        .execute(),
    ).rejects.toThrow(/candle_chunks_equal_lengths/);
    await expect(
      t.db
        .insertInto('candle_chunks')
        .values({ ...row, resolution_sec: 120 as never })
        .execute(),
    ).rejects.toThrow(/resolution_sec/);
    await expect(t.db.insertInto('candle_chunks').values(row).execute()).resolves.toBeDefined();
  });

  it('applies the stage and run status checks', async () => {
    const { id } = await addCoin('ST1');
    await expect(
      t.db
        .insertInto('coin_stages')
        .values({ coin_id: id, stage: 'nonsense' as never })
        .execute(),
    ).rejects.toThrow(/stage/);
    await expect(
      t.db
        .insertInto('coin_stages')
        .values({ coin_id: id, stage: 'metadata', status: 'x' as never })
        .execute(),
    ).rejects.toThrow(/status/);
    await expect(
      t.db
        .insertInto('ingest_runs')
        .values({ kind: 'k', status: 'x' as never })
        .execute(),
    ).rejects.toThrow(/status/);
  });

  it('keeps types.ts in step with the live schema (table and column names)', async () => {
    const { rows } = await sql<{ table_name: string; column_name: string }>`
      select table_name, column_name from information_schema.columns
      where table_schema = 'public' and table_name <> 'schema_migrations'`.execute(t.db);
    const live: Record<string, string[]> = {};
    for (const r of rows) (live[r.table_name] ??= []).push(r.column_name);
    for (const cols of Object.values(live)) cols.sort();
    const declared = Object.fromEntries(
      Object.entries(databaseShape).map(([table, cols]) => [table, Object.keys(cols).sort()]),
    );
    expect(declared).toEqual(live);
  });
});
