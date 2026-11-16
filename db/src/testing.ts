import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createDb } from './client.js';
import { migrate } from './migrate.js';
import type { Database } from './types.js';
import type { Kysely } from 'kysely';

/**
 * Throwaway databases for tests and scripts.
 *
 * Safety: the admin connection is used only to CREATE and DROP databases whose
 * names start with `mcp_test_`. `dropDatabase` refuses anything else.
 */
export const TEST_DB_PREFIX = 'mcp_test_';
const TEST_DB_NAME = /^mcp_test_[a-z0-9_]+$/;

export function assertTestDatabaseName(name: string): void {
  if (!TEST_DB_NAME.test(name)) {
    throw new Error(`Refusing to touch database "${name}": name must match ${TEST_DB_NAME}`);
  }
}

async function withAdmin<T>(adminUrl: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function createDatabase(adminUrl: string, name: string): Promise<void> {
  assertTestDatabaseName(name);
  await withAdmin(adminUrl, (c) => c.query(`CREATE DATABASE "${name}"`));
}

export async function dropDatabase(adminUrl: string, name: string): Promise<void> {
  assertTestDatabaseName(name);
  await withAdmin(adminUrl, (c) => c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
}

export function urlForDatabase(adminUrl: string, name: string): string {
  assertTestDatabaseName(name);
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  return u.toString();
}

export interface TestDatabase {
  name: string;
  url: string;
  db: Kysely<Database>;
  drop: () => Promise<void>;
}

/** Creates `mcp_test_<random>`, migrates it and returns a client plus a `drop` function. */
export async function createTestDatabase(
  adminUrl: string,
  options: { migrate?: boolean } = {},
): Promise<TestDatabase> {
  const name = `${TEST_DB_PREFIX}${randomBytes(6).toString('hex')}`;
  await createDatabase(adminUrl, name);
  const url = urlForDatabase(adminUrl, name);
  try {
    if (options.migrate !== false) await migrate(url);
  } catch (err) {
    await dropDatabase(adminUrl, name);
    throw err;
  }
  const db = createDb(url);
  return {
    name,
    url,
    db,
    drop: async () => {
      await db.destroy();
      await dropDatabase(adminUrl, name);
    },
  };
}

/**
 * Reads TEST_DATABASE_ADMIN_URL. When unset: throws if CI is set, otherwise
 * returns undefined so callers can skip database tests.
 */
export function getTestAdminUrl(): string | undefined {
  const url = process.env.TEST_DATABASE_ADMIN_URL;
  if (url) return url;
  if (process.env.CI) {
    throw new Error('TEST_DATABASE_ADMIN_URL must be set in CI; database tests cannot be skipped');
  }
  return undefined;
}
