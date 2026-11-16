import { copyFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { sql } from 'kysely';
import { DEFAULT_MIGRATIONS_DIR, migrate } from '../src/migrate.js';
import {
  assertTestDatabaseName,
  createTestDatabase,
  dropDatabase,
  type TestDatabase,
} from '../src/testing.js';
import { adminUrl, describeDb } from './helpers.js';

it('refuses to drop databases outside the mcp_test_ prefix', async () => {
  for (const name of [
    'postgres',
    'phone_farm',
    'mcp_test',
    'MCP_TEST_x',
    'mcp_test_a"; drop',
    '',
  ]) {
    expect(() => assertTestDatabaseName(name)).toThrow(/Refusing/);
    // The name check runs before any connection is attempted.
    await expect(dropDatabase('postgres://invalid.invalid/postgres', name)).rejects.toThrow(
      /Refusing/,
    );
  }
  expect(() => assertTestDatabaseName('mcp_test_abc123')).not.toThrow();
});

describeDb('migrations', () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase(adminUrl!, { migrate: false });
  });
  afterAll(async () => {
    await t.drop();
  });

  it('applies from empty', async () => {
    const result = await migrate(t.url);
    expect(result.applied).toEqual(['0001_init']);
    const { rows } = await sql<{
      n: string;
    }>`select count(*)::text as n from schema_migrations`.execute(t.db);
    expect(rows[0]!.n).toBe('1');
  });

  it('is a no-op the second time', async () => {
    const before = await sql`select * from schema_migrations`.execute(t.db);
    const result = await migrate(t.url);
    expect(result.applied).toEqual([]);
    expect(result.alreadyApplied).toEqual(['0001_init']);
    const after = await sql`select * from schema_migrations`.execute(t.db);
    expect(after.rows).toEqual(before.rows);
  });

  it('rejects an applied file whose checksum changed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-mig-'));
    await copyFile(join(DEFAULT_MIGRATIONS_DIR, '0001_init.sql'), join(dir, '0001_init.sql'));
    await writeFile(join(dir, '0001_init.sql'), '-- edited\n', { flag: 'a' });
    await expect(migrate(t.url, { migrationsDir: dir })).rejects.toThrow(/Checksum mismatch/);
  });

  it('applies a new file once and rolls back a failing one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-mig-'));
    await copyFile(join(DEFAULT_MIGRATIONS_DIR, '0001_init.sql'), join(dir, '0001_init.sql'));
    await writeFile(join(dir, '0002_ok.sql'), 'create table mig_ok (id int);');
    await writeFile(join(dir, '0003_bad.sql'), 'create table mig_half (id int); select 1/0;');
    await expect(migrate(t.url, { migrationsDir: dir })).rejects.toThrow(/0003_bad failed/);
    const { rows } = await sql<{ version: number; half: string | null }>`
      select (select max(version) from schema_migrations) as version,
             to_regclass('mig_half')::text as half`.execute(t.db);
    expect(rows[0]).toEqual({ version: 2, half: null });
  });
});
