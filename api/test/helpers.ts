import { describe } from 'vitest';
import { sql, type Kysely } from 'kysely';
import type { Database } from '@memecoinipedia/db';
import { getTestAdminUrl } from '@memecoinipedia/db/testing';

export const adminUrl = getTestAdminUrl();

if (!adminUrl) {
  process.stderr.write(
    '\n*** TEST_DATABASE_ADMIN_URL is not set: API database tests are SKIPPED. ' +
      'Set it to a Postgres admin URL to run them. ***\n\n',
  );
}

/** `describe` that skips when no test database server is configured. */
export const describeDb = describe.skipIf(!adminUrl);

/**
 * A 44-character base58 address for a short tag. The tag must use base58
 * characters only (no 0, O, I or l).
 */
export const addr = (tag: string): string => {
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(tag) || tag.length > 40) throw new Error(`bad tag ${tag}`);
  return `${tag}${'x'.repeat(40 - tag.length)}pump`;
};

export interface Fixture {
  tag: string;
  ticker?: string | null;
  name?: string | null;
  ath?: number | null;
  launchedAt?: string | null;
  athAt?: string | null;
  status?: 'alive' | 'dead' | 'rugged' | 'unknown';
  primary?: string | null;
  secondary?: string[];
  chain?: string;
}

/** A timestamptz value that keeps microseconds (a JS Date would drop them). */
const time = (iso: string | null) => (iso === null ? null : sql<Date>`${iso}::timestamptz`);

/** Inserts one coin. Defaults to a listed coin ($150k ATH). */
export async function insertCoin(db: Kysely<Database>, f: Fixture): Promise<number> {
  const ath = f.ath === undefined ? 150_000 : f.ath;
  const row = await db
    .insertInto('coins')
    .values({
      chain: f.chain ?? 'solana',
      address: addr(f.tag),
      ticker: f.ticker === undefined ? f.tag.toUpperCase() : f.ticker,
      name: f.name === undefined ? `${f.tag} coin` : f.name,
      launched_at: time(f.launchedAt === undefined ? '2025-03-01T00:00:00Z' : f.launchedAt),
      ath_market_cap_usd: ath,
      ath_at: ath === null ? null : time(f.athAt ?? '2025-03-02T00:00:00Z'),
      status: f.status ?? 'dead',
      primary_narrative: f.primary ?? null,
      secondary_narratives: f.secondary ?? [],
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/** Inserts `n` coins with one statement, for volume tests. */
export async function insertMany(
  db: Kysely<Database>,
  n: number,
  make: (i: number) => Fixture,
): Promise<void> {
  const rows = Array.from({ length: n }, (_, i) => make(i));
  await sql`
    insert into coins (chain, address, ticker, name, launched_at, ath_market_cap_usd, ath_at, status)
    select 'solana', a, t, nm, '2025-03-01T00:00:00Z'::timestamptz, h, '2025-03-02T00:00:00Z'::timestamptz, 'dead'
    from unnest(
      ${rows.map((r) => addr(r.tag))}::text[],
      ${rows.map((r) => r.ticker ?? r.tag.toUpperCase())}::text[],
      ${rows.map((r) => r.name ?? `${r.tag} coin`)}::text[],
      ${rows.map((r) => r.ath ?? 150_000)}::double precision[]
    ) as u(a, t, nm, h)`.execute(db);
}
