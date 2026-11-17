import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@memecoinipedia/db/testing';
import {
  checkSeedSource,
  formatSeedReport,
  seedFromCandidateFile,
} from '../../src/backfill/seed.js';
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

  it('a graduates seed stores the same columns as before and no mayhem flag', async () => {
    const rows = await sql<{ source: string; grad: Date | null; mayhem: boolean | null }>`
      select discovery_source as source, graduated_at as grad, is_mayhem_mode as mayhem
      from coins`.execute(t.db);
    expect(rows.rows).toHaveLength(4);
    for (const r of rows.rows) {
      expect(r.source).toBe('dune-graduates');
      expect(r.grad).toBeInstanceOf(Date);
      expect(r.mayhem).toBeNull();
    }
  });
});

describeDb('seeding the curve-only list', () => {
  let t: TestDatabase;
  let dir: string;
  const m = (i: number) => syntheticMint(i, 21);
  const CHEAD =
    'mint,created_at,creator,graduated_at,hours,peak_max_usd,peak_p999_usd,peak_at,last_hour,is_mayhem_mode\n';
  const crow = (i: number, grad: string, flag: string) =>
    `${m(i)},1.764e+09,${m(i + 100)},${grad},40,209739,209739,1.765e+09,1.766e+09,${flag}\n`;
  beforeAll(async () => {
    t = await createTestDatabase(adminUrl!);
    dir = await mkdtemp(join(tmpdir(), 'seed-curve-'));
  });
  afterAll(async () => {
    await t.drop();
    await rm(dir, { recursive: true, force: true });
  });

  it('seeds coins with no graduation time, the source dune-curve-only and the flag', async () => {
    const file = join(dir, 'curve.csv');
    await writeFile(
      file,
      CHEAD + crow(1, '<nil>', 'true') + crow(2, '<nil>', 'false') + crow(3, '<nil>', '<nil>'),
    );
    const dry = await seedFromCandidateFile({ file, list: 'curve-only', confirm: false });
    expect(dry).toMatchObject({ rows: 3, badRows: 0, mayhem: { yes: 1, no: 1, unknown: 1 } });
    expect(formatSeedReport(dry, false)).toMatch(
      /Mayhem flag in the file: true 1, false 1, empty 1/,
    );
    await seedFromCandidateFile({ file, list: 'curve-only', confirm: true, db: t.db });
    const rows = await sql<{
      address: string;
      source: string;
      grad: Date | null;
      mayhem: boolean | null;
    }>`
      select address, discovery_source as source, graduated_at as grad, is_mayhem_mode as mayhem
      from coins order by address`.execute(t.db);
    const by = new Map(rows.rows.map((r) => [r.address, [r.source, r.grad, r.mayhem]]));
    expect(by.get(m(1))).toEqual(['dune-curve-only', null, true]);
    expect(by.get(m(2))).toEqual(['dune-curve-only', null, false]);
    expect(by.get(m(3))).toEqual(['dune-curve-only', null, null]);
    expect(by.size).toBe(3);
    // Again: nothing changes.
    const again = await seedFromCandidateFile({
      file,
      list: 'curve-only',
      confirm: true,
      db: t.db,
    });
    expect(again.written).toMatchObject({ inserted: 0, updated: 0, unchanged: 3 });
  });

  it('neither file can be seeded as the other', async () => {
    const curve = join(dir, 'curve2.csv');
    await writeFile(curve, CHEAD + crow(7, '<nil>', 'true'));
    const asGraduates = await seedFromCandidateFile({ file: curve, confirm: false });
    expect(asGraduates).toMatchObject({ rows: 0, badRows: 1 });
    const grad = join(dir, 'grad.csv');
    await writeFile(grad, CHEAD + crow(8, '1764000000', 'true'));
    const asCurve = await seedFromCandidateFile({ file: grad, list: 'curve-only', confirm: false });
    expect(asCurve).toMatchObject({ rows: 0, badRows: 1 });
  });
});

describe('the source name of a seed (issue #102)', () => {
  it('a curve-only file takes no other source name, and no other list takes dune-curve-only', async () => {
    const file = 'unused.csv';
    // The guard runs before the file is opened.
    await expect(
      seedFromCandidateFile({
        file,
        list: 'curve-only',
        discoverySource: 'my-name',
        confirm: false,
      }),
    ).rejects.toThrow(/always seeded as dune-curve-only/);
    await expect(
      seedFromCandidateFile({
        file,
        list: 'graduates',
        discoverySource: 'dune-curve-only',
        confirm: false,
      }),
    ).rejects.toThrow(/source of the curve-only list only/);
    await expect(
      seedFromCandidateFile({ file, discoverySource: 'dune-curve-only', confirm: false }),
    ).rejects.toThrow(/source of the curve-only list only/);
    // The accepted combinations raise nothing in the guard.
    expect(() => checkSeedSource('curve-only', undefined)).not.toThrow();
    expect(() => checkSeedSource('curve-only', 'dune-curve-only')).not.toThrow();
    expect(() => checkSeedSource('graduates', 'my-name')).not.toThrow();
    expect(() => checkSeedSource('graduates', undefined)).not.toThrow();
  });

  const script = fileURLToPath(new URL('../../scripts/backfill.ts', import.meta.url));
  const cwd = fileURLToPath(new URL('../..', import.meta.url));
  const runScript = (args: string[]) =>
    new Promise<{ code: number | null; stderr: string }>((resolve) => {
      execFile(
        'node',
        ['--import', 'tsx', script, 'seed', '--file', 'unused.csv', ...args],
        { cwd, env: { PATH: process.env['PATH'] ?? '' } },
        (err, _out, stderr) =>
          resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stderr }),
      );
    });

  it('the seed command refuses --source with --list curve-only, and dune-curve-only with graduates', async () => {
    const a = await runScript(['--list', 'curve-only', '--source', 'my-name']);
    expect(a.code).toBe(2);
    expect(a.stderr).toContain('--source cannot be given with --list curve-only');
    const b = await runScript(['--list', 'graduates', '--source', 'dune-curve-only']);
    expect(b.code).toBe(2);
    expect(b.stderr).toContain('source of the curve-only list only');
    const c = await runScript(['--source', 'dune-curve-only']);
    expect(c.code).toBe(2);
  }, 60_000);
});
