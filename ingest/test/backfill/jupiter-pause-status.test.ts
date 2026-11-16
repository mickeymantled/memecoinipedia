import { afterAll, beforeAll, expect, it } from 'vitest';
import { createRun } from '@memecoinipedia/db';
import { createTestDatabase, type TestDatabase } from '@memecoinipedia/db/testing';
import { sql } from 'kysely';
import { collectStatus, formatStatus } from '../../src/backfill/status.js';
import { adminUrl, describeDb } from '../worker/helpers.js';

describeDb('backfill status and Jupiter pauses', () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase(adminUrl!);
  });
  afterAll(async () => {
    await t.drop();
  });

  it('prints the pauses and the seconds paused on a line of their own, not in the provider table', async () => {
    const runId = await createRun(t.db, { kind: 'backfill' });
    await sql`insert into provider_usage (run_id, provider, requests, units)
      values (${runId}, 'jupiter', 40, 0), (${runId}, 'jupiter_pause', 2, 120)`.execute(t.db);
    const text = formatStatus(await collectStatus(t.db, {}));
    expect(text).toMatch(/Jupiter paused 2 times after HTTP 429, 120 seconds in all/);
    const table = text.split('\n').filter((l) => /^jupiter/.test(l));
    expect(table).toHaveLength(1);
    expect(table[0]).toMatch(/^jupiter\s/);
  });
});
