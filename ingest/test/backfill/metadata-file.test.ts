import { afterAll, beforeAll, expect, it } from 'vitest';
import { sql } from 'kysely';
import { runBackfill, type BackfillOptions } from '../../src/backfill/run.js';
import { collectStatus } from '../../src/backfill/status.js';
import { DEFAULT_BACKFILL_STAGES } from '../../src/backfill/setup.js';
import type { SourceClients } from '../../src/worker/run.js';
import { asset, okResult, token } from '../worker/helpers.js';
import { describeDb, seededDatabase, testClients, testLog, type Fixture } from './helpers.js';

const ROWS = 300;

/** Simulated clients that count every call: nothing here reaches a provider. */
function countingClients() {
  const base = testClients();
  const calls = { helius: 0, jupiter: 0, file: [] as string[] };
  const clients: SourceClients = {
    ...base.clients,
    helius: {
      getAssets: async (mints) => {
        calls.helius++;
        return mints.map((m) =>
          asset(m, {
            uri: `https://ipfs.io/ipfs/bafy${m.slice(0, 20)}`,
            description: `helius ${m.slice(0, 6)}`,
          }),
        );
      },
    },
    jupiter: {
      getTokens: async (mints) => {
        calls.jupiter++;
        return mints.map((m) => token(m));
      },
    },
    fetchMetadata: async (uri) => {
      calls.file.push(uri);
      return okResult({ description: `file ${uri.slice(-8)}` });
    },
  };
  return { clients, calls, provider: base.provider };
}

describeDb('backfill: metadata and metadata_file', () => {
  let f: Fixture;
  const opts = (over: Partial<BackfillOptions>): BackfillOptions => {
    const lines: string[] = [];
    return {
      selection: {
        chain: 'solana',
        minRoughPeakUsd: 30_000,
        includeNoPrice: false,
        order: 'hash',
        limit: null,
      },
      codexRps: 10_000,
      maxCodexUnits: 10_000_000,
      maxHeliusCredits: 1_000_000,
      confirm: true,
      env: { DATABASE_URL: f.t.url },
      log: testLog,
      out: (t) => lines.push(t),
      db: f.t.db,
      candlesConcurrency: 40,
      feedPage: 50,
      maxQueued: 100,
      ...over,
    };
  };
  const count = async (stage: string, status: string) =>
    Number(
      (
        await sql<{ n: string }>`
          select count(*)::text as n from coin_stages where stage = ${stage} and status = ${status}`.execute(
          f.t.db,
        )
      ).rows[0]!.n,
    );

  beforeAll(async () => {
    f = await seededDatabase(ROWS);
  });
  afterAll(async () => {
    await f.cleanup();
  });

  it('the default stages leave metadata_file out, and metadata makes no gateway request', async () => {
    expect(DEFAULT_BACKFILL_STAGES).toEqual(['candles', 'metrics', 'metadata']);
    const c = countingClients();
    const report = await runBackfill(opts({ clients: c.clients }));
    expect(report.status).toBe('done');
    const listed = await count('metadata', 'done');
    expect(listed).toBeGreaterThan(0);
    expect(c.calls.file).toEqual([]);
    expect(c.calls.helius).toBeGreaterThan(0);
    expect(await count('metadata_file', 'done')).toBe(0);
    // The description is Helius's for now.
    const d = await sql<{ n: string }>`
      select count(*)::text as n from coins where description like 'helius %'`.execute(f.t.db);
    expect(Number(d.rows[0]!.n)).toBe(listed);
  }, 120_000);

  it('a dry run of metadata_file says how many coins and how long at the gateway rate, and asks nothing', async () => {
    const c = countingClients();
    const lines: string[] = [];
    const report = await runBackfill(
      opts({
        confirm: false,
        stages: ['metadata_file'],
        gatewayRps: 2,
        clients: c.clients,
        out: (t) => lines.push(t),
      }),
    );
    expect(report.status).toBe('dry_run');
    const listed = await count('metadata', 'done');
    expect(report.plan.ready['metadata_file']).toBe(listed);
    const text = lines.join('\n');
    expect(text).toMatch(new RegExp(`Metadata file: ${listed} coins ready now, no cost`));
    expect(text).toContain('At 2 request a second to each gateway');
    expect(text).not.toMatch(/Codex\.io estimate/);
    expect(text).toMatch(/metadata_file +0 \/ 0 \/ 0 \/ /);
    expect(c.calls).toEqual({ helius: 0, jupiter: 0, file: [] });
    expect(c.provider.requests()).toBe(0);
  });

  it('metadata_file runs by itself, skips coins already marked done, and the file wins', async () => {
    const listed = (
      await sql<{ id: string }>`
        select c.id::text as id from coins c
        join coin_stages s on s.coin_id = c.id and s.stage = 'metadata' and s.status = 'done'
        order by c.id`.execute(f.t.db)
    ).rows.map((r) => Number(r.id));
    // The migration's job, in miniature: the first three coins already hold their file.
    const held = listed.slice(0, 3);
    for (const id of held) {
      await sql`insert into coin_stages (coin_id, stage, status, version) values (${id}, 'metadata_file', 'done', 1)`.execute(
        f.t.db,
      );
    }
    const c = countingClients();
    const report = await runBackfill(opts({ stages: ['metadata_file'], clients: c.clients }));
    expect(report.status).toBe('done');
    expect(c.calls.file).toHaveLength(listed.length - held.length);
    expect(c.calls.helius).toBe(0);
    expect(c.calls.jupiter).toBe(0);
    expect(await count('metadata_file', 'done')).toBe(listed.length);
    const fromFile = await sql<{ n: string }>`
      select count(*)::text as n from coins where description like 'file %'`.execute(f.t.db);
    expect(Number(fromFile.rows[0]!.n)).toBe(listed.length - held.length);
    const kept = await sql<{ n: string }>`
      select count(*)::text as n from coins where id = any(${held}::bigint[]) and description like 'helius %'`.execute(
      f.t.db,
    );
    expect(Number(kept.rows[0]!.n)).toBe(held.length);

    // Nothing left: a second run asks nothing.
    const again = countingClients();
    const second = await runBackfill(opts({ stages: ['metadata_file'], clients: again.clients }));
    expect(second.status).toBe('nothing_to_do');
    expect(again.calls.file).toEqual([]);
  }, 120_000);

  it('the status view lists the metadata_file stage', async () => {
    const s = await collectStatus(f.t.db, {
      selection: { minRoughPeakUsd: 30_000, order: 'hash' },
    });
    const st = s.stages.find((x) => x.stage === 'metadata_file')!;
    expect(st).toBeDefined();
    expect(st.done).toBeGreaterThan(0);
    expect(st.waiting).toBe(0);
  });

  it('a version bump of metadata after metadata_file does not bring the Helius text back', async () => {
    await sql`update coin_stages set version = 1 where stage = 'metadata'`.execute(f.t.db);
    const c = countingClients();
    const report = await runBackfill(opts({ stages: ['metadata'], clients: c.clients }));
    expect(report.status).toBe('done');
    expect(c.calls.helius).toBeGreaterThan(0);
    const helius = await sql<{ n: string }>`
      select count(*)::text as n from coins c
      join coin_stages f on f.coin_id = c.id and f.stage = 'metadata_file' and f.status = 'done'
      where c.description like 'helius %'`.execute(f.t.db);
    // Only the coins whose file stage was marked done without a fetch still hold Helius's text.
    expect(Number(helius.rows[0]!.n)).toBe(3);
    const fileText = await sql<{ n: string }>`
      select count(*)::text as n from coins where description like 'file %'`.execute(f.t.db);
    expect(Number(fileText.rows[0]!.n)).toBeGreaterThan(0);
  }, 120_000);
});
