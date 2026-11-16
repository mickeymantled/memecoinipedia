import { Kysely, PostgresDialect, type KyselyConfig } from 'kysely';
import pg from 'pg';
import type { Database } from './types.js';

const INT8 = 20;
const INT8_ARRAY = 1016;

/**
 * bigint columns come back as JS numbers (ids, unix seconds and second counts
 * all stay far below 2^53). numeric stays a string.
 */
const types = {
  getTypeParser(oid: number, format?: 'text' | 'binary') {
    if (oid === INT8) return (v: string) => Number(v);
    if (oid === INT8_ARRAY) {
      return (v: string) => {
        const inner = v.slice(1, -1);
        return inner === '' ? [] : inner.split(',').map(Number);
      };
    }
    return pg.types.getTypeParser(oid, format as 'text');
  },
};

/**
 * Creates a Kysely instance with its own pool. Call `db.destroy()` when done.
 * `log` is Kysely's query log hook (used by the API's EXPLAIN tooling).
 */
export function createDb(connectionString: string, log?: KyselyConfig['log']): Kysely<Database> {
  return new Kysely<Database>({
    log,
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString, types: types as pg.CustomTypesConfig }),
    }),
  });
}
