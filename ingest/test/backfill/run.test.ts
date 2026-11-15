import { createReadOnlyDb } from '@memecoinipedia/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { runBackfill, countRunningStages, type BackfillOptions } from '../../src/backfill/run.js';
import { collectStatus } from '../../src/backfill/status.js';
import { RateLimiter } from '../../src/sources/ratelimit.js';
import { describeDb, seededDatabase, testClients, testLog, type Fixture } from './helpers.js';
import { synthProvider } from './synthetic.js';

const ROWS = 600;

const stageCounts = async (f: Fixture, stage: string, status: string): Promise<number> => {
  const r = await sql<{ n: string }>`
    select count(*)::text as n from coin_stages where stage = ${stage} and status = ${status}`.execute(
    f.t.db,
  );
  return Number(r.rows[0]!.n);
};

const baseOptions = (f: Fixture, over: Partial<BackfillOptions> = {}): BackfillOptions => {
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

describeDb('backfill run', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await seededDatabase(ROWS);
  });
  afterAll(async () => {
    await f.cleanup();
  });

  it('a dry run reads only: no provider call, no stage row written', async () => {
    const tc = testClients();
    const lines: string[] = [];
    const report = await runBackfill(
      baseOptions(f, { confirm: false, clients: tc.clients, out: (t) => lines.push(t) }),
    );
    expect(report.status).toBe('dry_run');
    expect(tc.provider.requests()).toBe(0);
    expect(await stageCounts(f, 'candles', 'done')).toBe(0);
    const runs = await sql<{ n: string }>`select count(*)::text as n from ingest_runs`.execute(
      f.t.db,
    );
    expect(runs.rows[0]!.n).toBe('0');
    expect(lines.join('\n')).toMatch(/Backfill plan: [\d,]+ coins selected/);
    expect(lines.join('\n')).toMatch(/compute units/);
    expect(report.plan.estimate.units).toBeGreaterThan(0);
  });

  it('--confirm needs a unit ceiling when candles is a stage', async () => {
    await expect(runBackfill(baseOptions(f, { maxCodexUnits: null }))).rejects.toThrow(
      /--max-codex-units is required/,
    );
  });

  it('refuses pools above the connection cap', async () => {
    await expect(
      runBackfill(baseOptions(f, { dbPoolSize: 35, queuePoolSize: 10 })),
    ).rejects.toThrow(/at most 40/);
  });

  it('runs the stages in order over the selection, and a second run does nothing', async () => {
    const tc = testClients();
    const report = await runBackfill(baseOptions(f, { clients: tc.clients }));
    expect(report.status).toBe('done');
    const selected = report.plan.selection.size;
    expect(selected).toBeGreaterThan(100);
    expect(selected).toBeLessThan(ROWS);
    expect(await stageCounts(f, 'candles', 'done')).toBe(selected);
    expect(await stageCounts(f, 'metrics', 'done')).toBe(selected);
    expect(await stageCounts(f, 'candles', 'failed')).toBe(0);
    expect(await countRunningStages(f.t.db)).toBe(0);

    // Only coins at or above the listed threshold got metadata.
    const meta = await sql<{ n: string; low: string }>`
      select count(*)::text as n,
             count(*) filter (where c.ath_market_cap_usd is null or c.ath_market_cap_usd < 100000)::text as low
      from coin_stages s
      join coins c on c.id = s.coin_id
      where s.stage = 'metadata'`.execute(f.t.db);
    expect(Number(meta.rows[0]!.n)).toBeGreaterThan(0);
    expect(meta.rows[0]!.low).toBe('0');

    // Coins outside the selection were not touched.
    const outside = await sql<{ n: string }>`
      select count(*)::text as n from coin_stages s join coins c on c.id = s.coin_id
      where s.stage = 'candles' and (c.rough_ath_market_cap_usd is null or c.rough_ath_market_cap_usd < 30000)`.execute(
      f.t.db,
    );
    expect(outside.rows[0]!.n).toBe('0');

    const again = testClients();
    const second = await runBackfill(baseOptions(f, { clients: again.clients }));
    expect(second.status).toBe('nothing_to_do');
    expect(again.provider.requests()).toBe(0);
  }, 120_000);

  it('the status view reads through a connection that cannot write', async () => {
    const ro = createReadOnlyDb(f.t.url);
    try {
      const s = await collectStatus(ro, {
        selection: { minRoughPeakUsd: 30_000, order: 'hash' },
      });
      const candles = s.stages.find((x) => x.stage === 'candles')!;
      expect(candles.done).toBe(s.selection.size);
      expect(candles.waiting).toBe(0);
      expect(s.databaseBytes).toBeGreaterThan(0);
      await expect(sql`delete from coin_stages`.execute(ro)).rejects.toThrow(/read-only/);
    } finally {
      await ro.destroy();
    }
  });
});

describeDb('backfill run: limits, rate limits, stop and resume', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await seededDatabase(ROWS, 2);
  });
  afterAll(async () => {
    await f.cleanup();
  });

  const reset = async () => {
    await sql`delete from coin_stages where stage <> 'discovered'`.execute(f.t.db);
  };

  it('hash order with a limit picks the same coins every time and skips the rest', async () => {
    await reset();
    const sel = {
      chain: 'solana',
      minRoughPeakUsd: 30_000,
      includeNoPrice: false,
      order: 'hash' as const,
      limit: 40,
    };
    const a = await runBackfill(
      baseOptions(f, {
        selection: sel,
        stages: ['candles'],
        clients: testClients({ provider: synthProvider({ seed: 2 }) }).clients,
      }),
    );
    expect(a.plan.selection.size).toBe(40);
    const first = await sql<{ id: string }>`
      select coin_id::text as id from coin_stages where stage = 'candles' and status = 'done' order by coin_id`.execute(
      f.t.db,
    );
    expect(first.rows).toHaveLength(40);

    await reset();
    await runBackfill(
      baseOptions(f, {
        selection: sel,
        stages: ['candles'],
        clients: testClients({ provider: synthProvider({ seed: 2 }) }).clients,
      }),
    );
    const second = await sql<{ id: string }>`
      select coin_id::text as id from coin_stages where stage = 'candles' and status = 'done' order by coin_id`.execute(
      f.t.db,
    );
    expect(second.rows).toEqual(first.rows);
  }, 60_000);

  it('a rate-limited request is retried without costing an attempt, and the run still finishes', async () => {
    await reset();
    const provider = synthProvider({
      seed: 2,
      refuse: (n) => (n % 7 === 0 ? (n % 14 === 0 ? 429 : 'graphql_rate_limit') : undefined),
    });
    const limiter = new RateLimiter({ maxPerSecond: 10_000, burst: 100 });
    const tc = testClients({ provider, limiter });
    const report = await runBackfill(
      baseOptions(f, {
        selection: {
          chain: 'solana',
          minRoughPeakUsd: 30_000,
          includeNoPrice: false,
          order: 'hash',
          limit: 60,
        },
        stages: ['candles'],
        clients: tc.clients,
        maxAttempts: 1,
      }),
    );
    expect(provider.refused()).toBeGreaterThan(3);
    expect(limiter.penalties).toBeGreaterThan(0);
    // maxAttempts is 1: only the refund can explain every coin finishing.
    expect(report.status).toBe('done');
    expect(await stageCounts(f, 'candles', 'done')).toBe(60);
    expect(await stageCounts(f, 'candles', 'failed')).toBe(0);
  }, 120_000);

  it('stops gracefully on abort, leaves nothing running, and a later run finishes the job', async () => {
    await reset();
    const provider = synthProvider({ seed: 2, latencyMs: 15 });
    const tc = testClients({ provider });
    const abort = new AbortController();
    const sel = {
      chain: 'solana',
      minRoughPeakUsd: 30_000,
      includeNoPrice: false,
      order: 'peak' as const,
      limit: null,
    };
    const timer = setInterval(async () => {
      if ((await stageCounts(f, 'candles', 'done')) >= 20) abort.abort();
    }, 50);
    const first = await runBackfill(
      baseOptions(f, {
        selection: sel,
        stages: ['candles'],
        clients: tc.clients,
        signal: abort.signal,
        candlesConcurrency: 8,
        maxQueued: 30,
        feedPage: 10,
      }),
    ).finally(() => clearInterval(timer));
    expect(first.status).toBe('stopped');
    const done = await stageCounts(f, 'candles', 'done');
    expect(done).toBeGreaterThanOrEqual(20);
    expect(done).toBeLessThan(first.plan.selection.size);
    expect(await countRunningStages(f.t.db)).toBe(0);
    const state = await sql<{ status: string }>`
      select status from ingest_runs order by id desc limit 1`.execute(f.t.db);
    expect(state.rows[0]!.status).toBe('stopped');

    const rest = testClients({ provider: synthProvider({ seed: 2 }) });
    const second = await runBackfill(
      baseOptions(f, { selection: sel, stages: ['candles'], clients: rest.clients }),
    );
    expect(second.status).toBe('done');
    expect(await stageCounts(f, 'candles', 'done')).toBe(second.plan.selection.size);
    // The coins done before the stop are not offered again.
    expect(second.plan.ready.candles).toBe(second.plan.selection.size - done);
  }, 120_000);
});
