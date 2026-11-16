import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@memecoinipedia/db/testing';
import { formatSeedReport, seedFromCandidateFile } from '../../src/backfill/seed.js';
import { adminUrl, describeDb } from './helpers.js';
import { syntheticMint } from './synthetic.js';

const HEADER =
  'mint,created_at,creator,graduated_at,hours,peak_max_usd,peak_p999_usd,peak_at,last_hour\n';

describeDb('seeding from the candidate file', () => {
  let t: TestDatabase;
  let dir: string;
  let file: string;
  const m = (i: number) => syntheticMint(i, 9);
  const row = (i: number, hours: string, max: string, p999: string) =>
    `${m(i)},1712000000,${m(i + 100)},1712003600,${hours},${max},${p999},1712007200,1714600000\n`;
  beforeAll(async () => {
    t = await createTestDatabase(adminUrl!);
    dir = await mkdtemp(join(tmpdir(), 'seed-'));
    file = join(dir, 'c.csv');
    await writeFile(
      file,
      HEADER +
        row(1, '48', '1.2e+06', '1.5e+06') + // exponent form
        row(2, '<nil>', '<nil>', '<nil>') + // Dune's empty value
        row(3, '48', '40000', '35000') +
        row(4, '48', '9000', '8000') +
        row(3, '48', '40000', '35000'), // the same mint again
    );
  });
  afterAll(async () => {
    await t.drop();
    await rm(dir, { recursive: true, force: true });
  });

  it('a dry run counts the file and writes nothing', async () => {
    const r = await seedFromCandidateFile({ file, confirm: false });
    expect(r.rows).toBe(4);
    expect(r.repeated).toBe(1);
    expect(r.noPrice).toBe(1);
    expect(r.written).toBeNull();
    const n = await sql<{ n: string }>`select count(*)::text as n from coins`.execute(t.db);
    expect(n.rows[0]!.n).toBe('0');
    expect(formatSeedReport(r, false)).toMatch(/Nothing written/);
  });

  it('seeds coins, with <nil> as a null rough ATH and exponent numbers read as numbers', async () => {
    const r = await seedFromCandidateFile({ file, confirm: true, db: t.db });
    expect(r.written).not.toBeNull();
    const rows = await sql<{ address: string; rough: number | null }>`
      select address, rough_ath_market_cap_usd as rough from coins order by address`.execute(t.db);
    expect(rows.rows).toHaveLength(4);
    const by = new Map(rows.rows.map((x) => [x.address, x.rough]));
    expect(by.get(m(2))).toBeNull();
    expect(by.get(m(1))).toBeGreaterThan(1_000_000);
    expect(by.get(m(4))).toBeLessThan(30_000);
  });

  it('seeding again changes nothing', async () => {
    await seedFromCandidateFile({ file, confirm: true, db: t.db });
    const coins = await sql<{ n: string }>`select count(*)::text as n from coins`.execute(t.db);
    expect(coins.rows[0]!.n).toBe('4');
  });
});
