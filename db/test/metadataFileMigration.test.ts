import { copyFile, mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { sql } from 'kysely';
import { DEFAULT_MIGRATIONS_DIR, migrate } from '../src/migrate.js';
import { createTestDatabase, type TestDatabase } from '../src/testing.js';
import { adminUrl, describeDb } from './helpers.js';

describeDb('migration 0014 (metadata_file stage)', () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase(adminUrl!, { migrate: false });
  });
  afterAll(async () => {
    await t.drop();
  });

  it('marks metadata_file done for coins with raw JSON, moves their metadata to version 2, and leaves the rest', async () => {
    // Everything before 0014.
    const dir = await mkdtemp(join(tmpdir(), 'mcp-mig-'));
    const before = (await readdir(DEFAULT_MIGRATIONS_DIR))
      .filter((f) => f.endsWith('.sql') && f < '0014')
      .sort();
    for (const f of before) await copyFile(join(DEFAULT_MIGRATIONS_DIR, f), join(dir, f));
    await migrate(t.url, { migrationsDir: dir });

    const coin = async (addr: string, raw: object | null) =>
      Number(
        (
          await sql<{ id: string }>`
            insert into coins (chain, address, metadata_raw)
            values ('solana', ${addr}, ${raw === null ? null : JSON.stringify(raw)}::jsonb)
            returning id::text as id`.execute(t.db)
        ).rows[0]!.id,
      );
    const stage = (id: number, status: string, version: number) =>
      sql`insert into coin_stages (coin_id, stage, status, version, attempts)
          values (${id}, 'metadata', ${status}, ${version}, 1)`.execute(t.db);

    const withRaw = await coin('A', { name: 'x' });
    const noRaw = await coin('B', null);
    const rawFailed = await coin('C', { name: 'y' });
    await stage(withRaw, 'done', 1);
    await stage(noRaw, 'done', 1);
    await stage(rawFailed, 'failed', 1);

    const result = await migrate(t.url);
    expect(result.applied[0]).toBe('0014_metadata_file_stage');

    const rows = (
      await sql<{ coin_id: string; stage: string; status: string; version: number }>`
        select coin_id::text, stage, status, version from coin_stages order by coin_id, stage`.execute(
        t.db,
      )
    ).rows.map((r) => `${r.coin_id}:${r.stage}:${r.status}:${r.version}`);
    expect(rows).toEqual([
      `${withRaw}:metadata:done:2`,
      `${withRaw}:metadata_file:done:1`,
      `${noRaw}:metadata:done:1`,
      `${rawFailed}:metadata:failed:1`,
      `${rawFailed}:metadata_file:done:1`,
    ]);

    // The constraint accepts the new name and still refuses others.
    await expect(
      sql`insert into coin_stages (coin_id, stage) values (${noRaw}, 'metadata_file')`.execute(
        t.db,
      ),
    ).resolves.toBeDefined();
    await expect(
      sql`insert into coin_stages (coin_id, stage) values (${noRaw}, 'nope')`.execute(t.db),
    ).rejects.toThrow();
  });
});
