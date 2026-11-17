import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { upsertCoin } from '@memecoinipedia/db';
import { createTestDatabase, type TestDatabase } from '@memecoinipedia/db/testing';
import { formatMayhemReport, loadMayhemFlags } from '../../src/backfill/mayhem.js';
import { adminUrl, describeDb } from './helpers.js';
import { syntheticMint } from './synthetic.js';

describeDb('loading the mayhem flag of graduates', () => {
  let t: TestDatabase;
  let dir: string;
  let file: string;
  const m = (i: number) => syntheticMint(i, 11);
  const flagOf = async (i: number) =>
    (
      await t.db
        .selectFrom('coins')
        .select('is_mayhem_mode')
        .where('address', '=', m(i))
        .executeTakeFirstOrThrow()
    ).is_mayhem_mode;

  beforeAll(async () => {
    t = await createTestDatabase(adminUrl!);
    dir = await mkdtemp(join(tmpdir(), 'mayhem-'));
    file = join(dir, 'm.csv');
    const add = async (i: number, flag: boolean | null) => {
      await upsertCoin(t.db, { chain: 'solana', address: m(i), launchpad: 'pump.fun' });
      if (flag !== null)
        await t.db
          .updateTable('coins')
          .set({ is_mayhem_mode: flag })
          .where('address', '=', m(i))
          .execute();
    };
    await add(1, null); // file true -> true
    await add(2, null); // file false -> false
    await add(3, false); // file true -> true
    await add(4, true); // file false -> stays true
    await add(5, true); // file true -> unchanged
    // m(6) is not in the database.
    await writeFile(
      file,
      'mint,is_mayhem_mode\n' +
        `${m(1)},true\n${m(2)},false\n${m(3)},true\n${m(4)},false\n${m(5)},true\n${m(6)},true\n` +
        `${m(1)},false\n` + // a repeated mint: the true wins
        'not-a-mint,true\n' +
        `${m(2)},maybe\n`,
    );
  });
  afterAll(async () => {
    await t.drop();
    await rm(dir, { recursive: true, force: true });
  });

  it('a dry run counts and writes nothing', async () => {
    const r = await loadMayhemFlags({ file, confirm: false, db: t.db });
    expect(r).toMatchObject({
      records: 9,
      rejected: 2,
      given: 6,
      givenTrue: 4,
      givenFalse: 2,
      notFound: 1,
      setTrue: 2,
      setFalse: 1,
      keptTrue: 1,
      unchanged: 1,
    });
    expect(await flagOf(1)).toBeNull();
    expect(await flagOf(3)).toBe(false);
    expect(formatMayhemReport(r)).toContain('Dry run: no write.');
  });

  it('with confirm a true stays true, a false only fills an empty flag, no coin is inserted', async () => {
    const r = await loadMayhemFlags({ file, confirm: true, db: t.db });
    expect(r.setTrue).toBe(2);
    expect(await flagOf(1)).toBe(true);
    expect(await flagOf(2)).toBe(false);
    expect(await flagOf(3)).toBe(true);
    expect(await flagOf(4)).toBe(true);
    expect(await flagOf(5)).toBe(true);
    const n = await t.db.selectFrom('coins').select('id').execute();
    expect(n).toHaveLength(5);
    // Loading again changes nothing.
    const again = await loadMayhemFlags({ file, confirm: true, db: t.db });
    expect(again.setTrue + again.setFalse).toBe(0);
  });

  it('refuses a file with another header', async () => {
    const bad = join(dir, 'bad.csv');
    await writeFile(bad, 'mint,flag\n');
    await expect(loadMayhemFlags({ file: bad, confirm: false, db: t.db })).rejects.toThrow(
      /header/,
    );
  });
});
