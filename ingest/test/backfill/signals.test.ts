import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { sql } from 'kysely';
import { countRunningStages } from '../../src/backfill/run.js';
import { describeDb, seededDatabase, type Fixture } from './helpers.js';

const INGEST_DIR = fileURLToPath(new URL('../..', import.meta.url));
const CHILD = fileURLToPath(new URL('./stop-child.ts', import.meta.url));

describeDb('backfill stop signal', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await seededDatabase(500, 3);
  });
  afterAll(async () => {
    await f.cleanup();
  });

  it('SIGTERM finishes what is in flight, exits 0, and leaves nothing running', async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', CHILD], {
      cwd: INGEST_DIR,
      env: { ...process.env, CHILD_DB_URL: f.t.url, CHILD_SEED: '3' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));

    const done = async (): Promise<number> => {
      const r = await sql<{ n: string }>`
        select count(*)::text as n from coin_stages where stage = 'candles' and status = 'done'`.execute(
        f.t.db,
      );
      return Number(r.rows[0]!.n);
    };
    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline && (await done()) < 15) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const before = await done();
    expect(before).toBeGreaterThanOrEqual(15);
    child.kill('SIGTERM');
    const code = await exited;

    expect(code).toBe(0);
    expect(out).toContain('finished stopped');
    expect(await countRunningStages(f.t.db)).toBe(0);
    const total = await sql<{ n: string }>`
      select count(*)::text as n from coins where rough_ath_market_cap_usd >= 30000`.execute(
      f.t.db,
    );
    expect(await done()).toBeGreaterThanOrEqual(before);
    expect(await done()).toBeLessThan(Number(total.rows[0]!.n));
  }, 90_000);
});
