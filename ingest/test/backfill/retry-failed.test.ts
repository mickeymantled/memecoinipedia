/**
 * `backfill run --retry-failed` when failed stages are the only work (issue 85): the plan counts
 * them, a dry run prints the count and writes nothing, a confirmed run requeues and runs them.
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { runBackfill, type BackfillOptions } from '../../src/backfill/run.js';
import { describeDb, seededDatabase, testClients, testLog, type Fixture } from './helpers.js';

const stageRows = async (f: Fixture) =>
  (await sql`select * from coin_stages order by coin_id, stage`.execute(f.t.db)).rows;

const options = (f: Fixture, over: Partial<BackfillOptions> = {}): BackfillOptions => ({
  selection: {
    chain: 'solana',
    minRoughPeakUsd: 30_000,
    includeNoPrice: false,
    order: 'hash',
    limit: null,
  },
  stages: ['candles', 'metrics'],
  codexRps: 10_000,
  maxCodexUnits: 10_000_000,
  confirm: true,
  env: { DATABASE_URL: f.t.url },
  log: testLog,
  out: () => undefined,
  db: f.t.db,
  candlesConcurrency: 20,
  feedPage: 50,
  maxQueued: 100,
  ...over,
});

describeDb('backfill run --retry-failed with nothing else to do', () => {
  let f: Fixture;
  let failedId = 0;
  let outsideId = 0;
  let metadataId = 0;
  beforeAll(async () => {
    f = await seededDatabase(120);
    await runBackfill(options(f, { clients: testClients().clients }));
    const inside = await sql<{ id: string }>`select c.id::text as id from coins c
      join coin_stages s on s.coin_id = c.id and s.stage = 'candles' and s.status = 'done'
      order by c.id limit 2`.execute(f.t.db);
    failedId = Number(inside.rows[0]!.id);
    metadataId = Number(inside.rows[1]!.id);
    const outside = await sql<{ id: string }>`select c.id::text as id from coins c
      where c.rough_ath_market_cap_usd < 30000 order by c.id limit 1`.execute(f.t.db);
    outsideId = Number(outside.rows[0]!.id);
    // One coin of the selection whose candles used up its attempts; a failed stage that is not
    // asked for (metadata); a failed stage of a coin outside the selection.
    await sql`update coin_stages set status = 'failed', attempts = 3, last_error = 'boom'
      where coin_id = ${failedId} and stage = 'candles'`.execute(f.t.db);
    await sql`insert into coin_stages (coin_id, stage, status, attempts)
      values (${metadataId}, 'metadata', 'failed', 3)
      on conflict (coin_id, stage) do update set status = 'failed', attempts = 3`.execute(f.t.db);
    await sql`insert into coin_stages (coin_id, stage, status, attempts)
      values (${outsideId}, 'candles', 'failed', 3)
      on conflict (coin_id, stage) do update set status = 'failed', attempts = 3`.execute(f.t.db);
  }, 120_000);
  afterAll(async () => {
    await f.cleanup();
  });

  const status = async (coinId: number, stage: string): Promise<string> =>
    (
      await sql<{ status: string }>`select status from coin_stages
        where coin_id = ${coinId} and stage = ${stage}`.execute(f.t.db)
    ).rows[0]!.status;

  it('without the option the answer is nothing to do', async () => {
    const tc = testClients();
    const before = await stageRows(f);
    const report = await runBackfill(options(f, { clients: tc.clients }));
    expect(report.status).toBe('nothing_to_do');
    expect(report.plan.retryFailed).toBeUndefined();
    expect(tc.provider.requests()).toBe(0);
    expect(await stageRows(f)).toEqual(before);
  });

  it('a dry run prints the count on its own line and leaves every row as it was', async () => {
    const tc = testClients();
    const before = await stageRows(f);
    const lines: string[] = [];
    const report = await runBackfill(
      options(f, {
        confirm: false,
        retryFailed: true,
        clients: tc.clients,
        out: (x) => lines.push(x),
      }),
    );
    expect(report.status).toBe('dry_run');
    // One failed stage of the asked-for stages inside the selection: not metadata, not the coin
    // outside the selection.
    expect(report.plan.retryFailed).toEqual({ stages: 1 });
    expect(report.plan.nothingToDo).toBe(false);
    expect(lines.join('\n').split('\n')).toContain(
      'Failed stages to retry (--retry-failed): 1; they are put back to pending with a full set of attempts.',
    );
    expect(lines.join('\n')).not.toMatch(/Nothing to do/);
    expect(tc.provider.requests()).toBe(0);
    expect(await stageRows(f)).toEqual(before);
  });

  it('a confirmed run requeues the failed stage and runs it, and touches nothing else that failed', async () => {
    const tc = testClients();
    const report = await runBackfill(options(f, { retryFailed: true, clients: tc.clients }));
    expect(report.status).toBe('done');
    expect(tc.provider.requests()).toBeGreaterThan(0);
    expect(await status(failedId, 'candles')).toBe('done');
    expect(await status(metadataId, 'metadata')).toBe('failed');
    expect(await status(outsideId, 'candles')).toBe('failed');

    // And now there is nothing left, with or without the option.
    const again = await runBackfill(
      options(f, { retryFailed: true, clients: testClients().clients }),
    );
    expect(again.status).toBe('nothing_to_do');
  }, 120_000);
});
