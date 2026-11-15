import { copyFile, mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { sql } from 'kysely';
import { DEFAULT_MIGRATIONS_DIR, migrate } from '../src/migrate.js';
import { createTestDatabase, type TestDatabase } from '../src/testing.js';
import { adminUrl, describeDb } from './helpers.js';

describeDb('migration 0019 (socials_source)', () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase(adminUrl!, { migrate: false });
  });
  afterAll(async () => {
    await t.drop();
  });

  it('marks metadata_file for coins whose file stage is done, whatever their links, and leaves the rest null', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-mig-'));
    const before = (await readdir(DEFAULT_MIGRATIONS_DIR))
      .filter((f) => f.endsWith('.sql') && f < '0019')
      .sort();
    for (const f of before) await copyFile(join(DEFAULT_MIGRATIONS_DIR, f), join(dir, f));
    await migrate(t.url, { migrationsDir: dir });

    const coin = async (addr: string, socials: object) =>
      Number(
        (
          await sql<{ id: string }>`
            insert into coins (chain, address, socials)
            values ('solana', ${addr}, ${JSON.stringify(socials)}::jsonb)
            returning id::text as id`.execute(t.db)
        ).rows[0]!.id,
      );
    const stage = (id: number, status: string) =>
      sql`insert into coin_stages (coin_id, stage, status, attempts)
          values (${id}, 'metadata_file', ${status}, 1)`.execute(t.db);

    const withLinks = await coin('A', { twitter: 'https://x.com/a' });
    const noLinks = await coin('B', {});
    const failed = await coin('C', {});
    const skipped = await coin('D', {});
    const noStage = await coin('E', {});
    await stage(withLinks, 'done');
    await stage(noLinks, 'done');
    await stage(failed, 'failed');
    await stage(skipped, 'skipped');

    const result = await migrate(t.url);
    expect(result.applied).toEqual(['0019_socials_source']);

    const rows = (
      await sql<{ id: string; socials_source: string | null }>`
        select id::text, socials_source from coins order by id`.execute(t.db)
    ).rows.map((r) => `${r.id}:${r.socials_source}`);
    expect(rows).toEqual([
      `${withLinks}:metadata_file`,
      `${noLinks}:metadata_file`,
      `${failed}:null`,
      `${skipped}:null`,
      `${noStage}:null`,
    ]);
    // Only the two names are accepted.
    await expect(
      sql`update coins set socials_source = 'jupiter' where id = ${failed}`.execute(t.db),
    ).resolves.toBeDefined();
    await expect(
      sql`update coins set socials_source = 'guess' where id = ${failed}`.execute(t.db),
    ).rejects.toThrow();
  });
});
