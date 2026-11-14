import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

/** Arbitrary constant; the second key of the two-int advisory lock form. */
const LOCK_KEY_1 = 0x6d63_7031; // "mcp1"
const LOCK_KEY_2 = 1;

export interface MigrateOptions {
  migrationsDir?: string;
  log?: (message: string) => void;
}

export interface MigrateResult {
  applied: string[];
  alreadyApplied: string[];
}

interface MigrationFile {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

const FILE_PATTERN = /^(\d+)_([a-z0-9_]+)\.sql$/;

async function loadMigrations(dir: string): Promise<MigrationFile[]> {
  const entries = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const files: MigrationFile[] = [];
  for (const entry of entries) {
    const match = FILE_PATTERN.exec(entry);
    if (!match) throw new Error(`Migration file name must look like 0001_name.sql: ${entry}`);
    const sql = await readFile(`${dir}/${entry}`, 'utf8');
    files.push({
      version: Number(match[1]),
      name: entry.replace(/\.sql$/, ''),
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    });
  }
  for (let i = 1; i < files.length; i++) {
    if (files[i]!.version === files[i - 1]!.version) {
      throw new Error(`Duplicate migration version ${files[i]!.version}`);
    }
  }
  return files;
}

/**
 * Applies pending migrations in order, each in its own transaction, under a
 * Postgres advisory lock so concurrent runners queue up. Forward-only: an
 * already-applied file whose checksum changed is an error.
 */
export async function migrate(
  connectionString: string,
  options: MigrateOptions = {},
): Promise<MigrateResult> {
  const log = options.log ?? (() => {});
  const files = await loadMigrations(options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR);
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1, $2)', [LOCK_KEY_1, LOCK_KEY_2]);
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version    int PRIMARY KEY,
          name       text NOT NULL,
          checksum   text NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT now()
        )`);
      const { rows } = await client.query<{ version: number; name: string; checksum: string }>(
        'SELECT version, name, checksum FROM schema_migrations ORDER BY version',
      );
      const done = new Map(rows.map((r) => [r.version, r]));
      const result: MigrateResult = { applied: [], alreadyApplied: [] };

      // Verify every applied file first, so a tampered history fails before anything runs.
      for (const file of files) {
        const prior = done.get(file.version);
        if (prior && prior.checksum !== file.checksum) {
          throw new Error(
            `Checksum mismatch for applied migration ${file.name}: the file changed after it was applied`,
          );
        }
      }
      for (const row of rows) {
        if (!files.some((f) => f.version === row.version)) {
          throw new Error(`Applied migration ${row.name} has no file on disk`);
        }
      }

      for (const file of files) {
        if (done.has(file.version)) {
          result.alreadyApplied.push(file.name);
          continue;
        }
        log(`applying ${file.name}`);
        try {
          await client.query('BEGIN');
          await client.query(file.sql);
          await client.query(
            'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
            [file.version, file.name, file.checksum],
          );
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw new Error(`Migration ${file.name} failed: ${(err as Error).message}`, {
            cause: err,
          });
        }
        result.applied.push(file.name);
      }
      return result;
    } finally {
      await client.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_KEY_1, LOCK_KEY_2]);
    }
  } finally {
    await client.end();
  }
}
