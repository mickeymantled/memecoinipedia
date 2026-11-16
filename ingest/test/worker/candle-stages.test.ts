import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { claimStage, type Database, type StageName } from '@memecoinipedia/db';
import { createTestDatabase, type TestDatabase } from '@memecoinipedia/db/testing';
import { sql, type Kysely } from 'kysely';
import { fetchCandlesForCoin } from '../../src/candles/index.js';
import { UnitBudget } from '../../src/sources/budget.js';
import { CodexClient } from '../../src/sources/codex/index.js';
import type { FetchLike } from '../../src/sources/http.js';
import { runIngest, type IngestOptions, type SourceClients } from '../../src/worker/run.js';
import { metricsStage } from '../../src/worker/stages/metrics.js';
import { METRICS_VERSION } from '../../src/candles/index.js';
import { minute, simProvider, type SimCoin, type SimMinute, type SimPool } from '../candles/sim.js';
import { snapshotTables } from '../candles/helpers.js';
import { buildReport, loadReportData } from '../../scripts/lib/sample-report.js';
import { readSampleFile } from '../../src/worker/seed.js';
import { adminUrl, asset, describeDb, okResult, testLog, token } from './helpers.js';

const DAY = 86_400;
const T0 = 1_767_225_600;
const LAUNCH = T0 + 3 * 3_600;
const GRAD = LAUNCH + 2 * 3_600;
const NOW = GRAD + 5 * DAY;
const clock = () => new Date(NOW * 1000);

const HEADER =
  'mint,half_year,cell,probe,cell_size,created_at,creator,graduated_at,hours,peak_max_usd,peak_p999_usd,peak_at';

const mcap = (usd: number): number => usd / 1e9;
const dense = (start: number, n: number, price: (i: number) => number): SimMinute[] =>
  Array.from({ length: n }, (_, i) => minute(start + i * 60, price(i), 3_000));

const addr = (ch: string, tag: string): string => ch.repeat(44 - tag.length) + tag;
const gradPool = (tag: string, minutes: SimMinute[]): SimPool => ({
  address: addr('C', tag),
  exchange: 'PumpSwap',
  protocol: 'PumpAmm',
  createdAt: GRAD,
  liquidity: 30_000,
  minutes,
});
const curvePool = (tag: string): SimPool => ({
  address: addr('B', tag),
  exchange: 'Pump.fun',
  protocol: 'Pump',
  createdAt: LAUNCH,
  liquidity: 0,
  minutes: [],
});

/** Mints of coins the Dune peak agrees are small (a peak far above the screen would escalate them). */
const smallMints = new Set<string>();

/** Never near $100k: screened out after one launch lookup and one bars request. */
function small(tag: string): SimCoin {
  smallMints.add(addr('D', tag));
  const grad = gradPool(
    tag,
    dense(GRAD, 300, (i) => mcap(20_000 + i * 100)),
  );
  return {
    mint: addr('D', tag),
    createdAt: LAUNCH,
    migratedAt: GRAD,
    migratedPoolAddress: grad.address,
    pools: [curvePool(tag), grad],
  };
}

/** Climbs to $500,000: past the screen, so it fetches minute and hourly bars. */
function mid(tag: string, namesPool = true): SimCoin {
  const grad = gradPool(tag, [
    ...dense(GRAD, 200, (i) => mcap(60_000 + i * 2_211)),
    ...Array.from({ length: 6 }, (_, k) => minute(GRAD + 2 * DAY + k * 600, mcap(200_000))),
  ]);
  return {
    mint: addr('D', tag),
    createdAt: LAUNCH,
    migratedAt: GRAD,
    migratedPoolAddress: namesPool ? grad.address : null,
    pools: [curvePool(tag), grad],
  };
}

/** Launch info names no pool and the list holds no graduation pool: records `graduation_pool_not_found`. */
function lost(tag: string): SimCoin {
  const curve = curvePool(tag);
  curve.minutes = dense(LAUNCH, 100, (i) => mcap(30_000 + i * 50));
  return {
    mint: addr('D', tag),
    createdAt: LAUNCH,
    migratedAt: GRAD,
    migratedPoolAddress: null,
    pools: [curve],
  };
}

/** One provider for many coins: routes each request to the coin whose address it carries. */
function routedProvider(coins: SimCoin[]) {
  const sims = new Map(coins.map((c) => [c.mint, simProvider(c)]));
  const keys = coins.map((c) => ({
    mint: c.mint,
    keys: [c.mint, ...c.pools.map((p) => p.address)],
  }));
  const perMint = new Map<string, number>();
  const failing = new Set<string>();
  let total = 0;
  const fetch: FetchLike = async (url, init) => {
    const query = (JSON.parse(init.body) as { query: string }).query;
    const owner = keys.find((k) => k.keys.some((key) => query.includes(key)));
    if (!owner) throw new Error(`No simulated coin for query: ${query.slice(0, 100)}`);
    total++;
    perMint.set(owner.mint, (perMint.get(owner.mint) ?? 0) + 1);
    if (failing.has(owner.mint)) {
      return { status: 500, ok: false, headers: { get: () => null }, text: async () => 'error' };
    }
    return sims.get(owner.mint)!.fetch(url, init);
  };
  return {
    fetch,
    failing,
    perMint,
    total: () => total,
  };
}

describeDb('candles and metrics stages in the run', () => {
  let t: TestDatabase;
  let db: Kysely<Database>;
  let dir: string;
  const files: string[] = [];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ingest-candles-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    t = await createTestDatabase(adminUrl!);
    db = t.db;
  });
  afterEach(async () => {
    await t.drop();
  });

  const csv = async (coins: SimCoin[], cells: string[] = []): Promise<string> => {
    const file = join(dir, `sample-${files.length}.csv`);
    files.push(file);
    const rows = coins.map(
      (c, i) =>
        `${c.mint},2026-H1,${cells[i] ?? '100k-1M'},false,2,${new Date(LAUNCH * 1000).toISOString()},,${new Date(GRAD * 1000).toISOString()},670,934000,${smallMints.has(c.mint) ? 55_000 : 200_000 + i},2026-01-02T15:00:00Z`,
    );
    await writeFile(file, [HEADER, ...rows].join('\n'));
    return file;
  };

  const fast = { retryDelaySeconds: 1, monitorIntervalSeconds: 1, pollingIntervalSeconds: 0.5 };

  const harness = (coins: SimCoin[], ceiling: number | null = null) => {
    const provider = routedProvider(coins);
    const codex = new CodexClient({
      apiKey: 'test-key-not-real',
      fetch: provider.fetch,
      budget: new UnitBudget(ceiling === null ? {} : { ceilingUnits: ceiling }),
      http: { maxRetries: 0, sleep: async () => {} },
    });
    const meta = { helius: 0, down: false, notFound: new Set<string>() };
    const clients: SourceClients = {
      helius: {
        getAssets: async (mints) => {
          meta.helius++;
          if (meta.down) throw new Error('helius is down');
          return mints.map((m) => (meta.notFound.has(m) ? asset(m, { found: false }) : asset(m)));
        },
      },
      jupiter: { getTokens: async (mints) => mints.map((m) => token(m)) },
      fetchMetadata: async () => okResult({ description: 'd' }),
      codex,
    };
    return { provider, codex, clients, meta };
  };

  const run = async (
    h: ReturnType<typeof harness>,
    file: string,
    extra: Partial<IngestOptions> = {},
  ) => {
    const out: string[] = [];
    const report = await runIngest({
      samplePath: file,
      env: { DATABASE_URL: t.url },
      log: testLog,
      out: (s) => out.push(s),
      confirm: true,
      db,
      clients: h.clients,
      maxCodexUnits: 100_000,
      maxAttempts: 1,
      concurrency: 3,
      now: clock,
      worker: fast,
      ...extra,
    });
    return { report, text: out.join('\n') };
  };

  const stageRows = (stage: StageName) =>
    db
      .selectFrom('coin_stages as s')
      .innerJoin('coins', 'coins.id', 's.coin_id')
      .select(['coins.address', 's.status', 's.attempts', 's.last_error', 's.detail'])
      .where('s.stage', '=', stage)
      .orderBy('coins.address')
      .execute();
  const statusOf = async (stage: StageName, mint: string) =>
    (await stageRows(stage)).find((r) => r.address === mint)?.status ?? 'none';
  const everything = async () => ({
    ...(await snapshotTables(db)),
    coin_stages: (
      await sql<Record<string, unknown>>`
      select * from coin_stages order by coin_id, stage`.execute(db)
    ).rows,
  });

  it('metadata failing does not stop candles and metrics for that coin', async () => {
    const coins = [small('1'), mid('2'), mid('3')];
    const h = harness(coins);
    h.meta.down = true; // every metadata lookup fails
    const { report } = await run(h, await csv(coins));
    expect(report.status).toBe('done');
    for (const c of coins) {
      expect(await statusOf('metadata', c.mint)).toBe('failed');
      expect(await statusOf('candles', c.mint)).toBe('done');
      expect(await statusOf('metrics', c.mint)).toBe('done');
    }
    const m = await db
      .selectFrom('coins')
      .select(['address', 'metrics_version', 'status'])
      .orderBy('address')
      .execute();
    expect(m.every((r) => r.metrics_version === METRICS_VERSION)).toBe(true);
  }, 60_000);

  it('candles failing keeps metrics from running; --retry-failed finishes both', async () => {
    const coins = [mid('1'), mid('2'), mid('3')];
    const h = harness(coins);
    h.provider.failing.add(coins[1]!.mint);
    const first = await run(h, await csv(coins));
    expect(first.report.status).toBe('done');
    expect(await statusOf('candles', coins[1]!.mint)).toBe('failed');
    expect(await statusOf('metrics', coins[1]!.mint)).not.toBe('done');
    expect(await statusOf('metrics', coins[0]!.mint)).toBe('done');
    expect(first.report.summary!.failures.find((f) => f.stage === 'candles')?.reason).toBe(
      'provider_unavailable',
    );

    // The provider recovers. A plain re-run leaves the coin (it used its one attempt) ...
    h.provider.failing.clear();
    const same = await run(h, await csv(coins));
    expect(same.report.status).toBe('nothing_to_do');
    // ... and --retry-failed finishes candles, then metrics.
    const retried = await run(h, await csv(coins), { retryFailed: true });
    expect(retried.report.status).toBe('done');
    expect(await statusOf('candles', coins[1]!.mint)).toBe('done');
    expect(await statusOf('metrics', coins[1]!.mint)).toBe('done');
  }, 60_000);

  it('the unit ceiling stops a run part-way, the next run finishes it, and no coin is fetched twice', async () => {
    const coins = Array.from({ length: 8 }, (_, i) => small(String(i + 1)));
    const file = await csv(coins);
    // A screened-out coin costs 8 units (a launch lookup and one bars request).
    const first = harness(coins, 30);
    const r1 = await run(first, file);
    expect(r1.report.status).toBe('done'); // exit code 0: a ceiling stop is not a failure
    expect(r1.report.ceilingStop).toBeDefined();
    expect(r1.text).toContain('STOPPED AT THE CODEX.IO UNIT CEILING');
    expect(first.codex.spend().units).toBeLessThanOrEqual(30);
    const done1 = (await stageRows('candles')).filter((r) => r.status === 'done');
    expect(done1.length).toBeGreaterThan(0);
    expect(done1.length).toBeLessThan(coins.length);
    expect(r1.report.ceilingStop!.coinsLeft).toBe(coins.length - done1.length);
    // Coins stopped by the ceiling are failed with the reason, and the attempt is given back.
    const stopped = (await stageRows('candles')).filter((r) => r.status === 'failed');
    for (const s of stopped) {
      expect(s.last_error).toMatch(/^budget_exhausted:/);
      expect(s.attempts).toBe(0);
    }
    // Metrics ran for every coin whose candles were done, and only for those.
    expect((await stageRows('metrics')).filter((r) => r.status === 'done')).toHaveLength(
      done1.length,
    );

    // Next run: a higher ceiling, a fresh client, the same database.
    const second = harness(coins, 1_000);
    for (const [mint, n] of first.provider.perMint) second.provider.perMint.set(mint, n);
    const r2 = await run(second, file);
    expect(r2.report.status).toBe('done');
    expect(r2.report.ceilingStop).toBeUndefined();
    expect((await stageRows('candles')).every((r) => r.status === 'done')).toBe(true);
    expect((await stageRows('metrics')).every((r) => r.status === 'done')).toBe(true);
    // Each coin cost exactly what one uninterrupted fetch costs: 2 requests, in the two runs together.
    expect([...second.provider.perMint.values()]).toEqual(Array(8).fill(2));
    // The second run spent only what was left.
    expect(first.codex.spend().units + second.codex.spend().units).toBe(8 * 8);
  }, 90_000);

  it('a second run makes no provider request and changes no row', async () => {
    const coins = [small('1'), mid('2'), mid('3'), lost('4')];
    const h = harness(coins);
    const file = await csv(coins);
    const first = await run(h, file);
    expect(first.report.status).toBe('done');
    expect(first.report.summary!.failures.filter((f) => f.stage !== 'metadata')).toEqual([]);
    const requests = h.provider.total();
    const before = await everything();
    const heliusCalls = h.meta.helius;

    const again = await run(h, file);
    expect(again.report.status).toBe('nothing_to_do');
    expect(again.report.ranWork).toBe(false);
    expect(h.provider.total()).toBe(requests);
    expect(h.meta.helius).toBe(heliusCalls);
    expect(await everything()).toEqual(before);
  }, 90_000);

  it('a run killed after the bars were stored and before the stage finished leaves no duplicates', async () => {
    const coins = [mid('1')];
    const h = harness(coins);
    const file = await csv(coins);
    // Seed the coin (discovered), then do what a killed worker did: claim the stage, fetch
    // and store everything, and die before recording the result.
    await run(h, file, { stages: ['discovered'] });
    const coin = await db.selectFrom('coins').select(['id', 'address']).executeTakeFirstOrThrow();
    const claimed = await claimStage(db, {
      coinId: coin.id,
      stage: 'candles',
      version: 1,
      now: new Date((NOW - 3_600) * 1000),
      staleAfterMs: 600_000,
    });
    expect(claimed.status).toBe('claimed');
    const fetched = await fetchCandlesForCoin(
      { db, codex: h.codex, clock },
      { id: coin.id, address: coin.address },
    );
    expect(fetched.ok).toBe(true);
    const requestsBefore = h.provider.total();
    const stored = await snapshotTables(db);
    expect(await statusOf('candles', coin.address)).toBe('running');

    // The next run takes the stale stage over and finishes it.
    const r = await run(h, file, { stages: ['candles', 'metrics'] });
    expect(r.report.status).toBe('done');
    expect(await statusOf('candles', coin.address)).toBe('done');
    expect(await statusOf('metrics', coin.address)).toBe('done');
    const after = await snapshotTables(db);
    expect(after['candle_chunks']).toEqual(stored['candle_chunks']);
    expect(after['candle_coverage']).toEqual(stored['candle_coverage']);
    expect(after['pools']).toEqual(stored['pools']);
    // The same clock, the same plan: nothing left to ask the provider for.
    expect(h.provider.total()).toBe(requestsBefore);
  }, 90_000);

  it('stores a small detail on done and none on a failed stage', async () => {
    const coins = [small('1'), mid('2'), mid('3', false), mid('4')];
    const h = harness(coins);
    h.provider.failing.add(coins[3]!.mint);
    await run(h, await csv(coins));
    const rows = await stageRows('candles');
    const by = (mint: string) => rows.find((r) => r.address === mint)!;

    const screened = by(coins[0]!.mint).detail as Record<string, unknown>;
    expect(by(coins[0]!.mint).status).toBe('done');
    expect(screened).toMatchObject({
      path: 'screened_out',
      escalated: false,
      units: 8,
      lookupRequests: 1,
      barRequests: 1,
      refinementRequests: 0,
      launchInfoNamedPool: true,
      hourlyCapHit: false,
    });
    expect(typeof screened['w']).toBe('number');

    const light = by(coins[1]!.mint).detail as Record<string, unknown>;
    expect(['light', 'full']).toContain(light['path']);
    expect(light['units']).toBeGreaterThan(8);
    expect(light['barRequests']).toBeGreaterThan(1);
    expect(light['launchInfoNamedPool']).toBe(true);

    // Launch info that names no pool needs the pool list as well.
    const listed = by(coins[2]!.mint).detail as Record<string, unknown>;
    expect(listed['launchInfoNamedPool']).toBe(false);
    expect(listed['lookupRequests']).toBe(2);

    expect(by(coins[3]!.mint).status).toBe('failed');
    expect(by(coins[3]!.mint).detail).toBeNull();

    for (const r of rows.filter((x) => x.status === 'done')) {
      const text = JSON.stringify(r.detail);
      expect(text.length).toBeLessThan(1024);
      expect(text).not.toMatch(/https?:|key|[1-9A-HJ-NP-Za-km-z]{32}/i);
      expect(Object.keys(r.detail as object).sort()).toEqual([
        'barRequests',
        'escalated',
        'hourlyCapHit',
        'launchInfoNamedPool',
        'lookupRequests',
        'path',
        'refinementRequests',
        'units',
        'w',
      ]);
    }
  }, 90_000);

  it("issues belong to the stage that wrote them: neither stage removes the other's", async () => {
    const coins = [lost('1'), small('2')];
    const h = harness(coins);
    h.meta.notFound.add(coins[0]!.mint); // metadata records `asset_not_found` for this coin
    const file = await csv(coins);
    await run(h, file);
    const issues = async () =>
      (
        await db
          .selectFrom('data_issues as d')
          .innerJoin('coins', 'coins.id', 'd.coin_id')
          .select(['d.id', 'd.kind', 'coins.address'])
          .where('d.resolved_at', 'is', null)
          .orderBy('d.kind')
          .execute()
      ).filter((i) => i.address === coins[0]!.mint);
    const first = await issues();
    expect(first.map((i) => i.kind)).toEqual(['asset_not_found', 'graduation_pool_not_found']);

    const reset = (stage: StageName) =>
      db
        .updateTable('coin_stages')
        .set({ status: 'pending', attempts: 0 })
        .where('stage', '=', stage)
        .execute();
    const idOf = (list: typeof first, kind: string) => list.find((i) => i.kind === kind)!.id;

    // Candles runs again: metadata's issue stays, and there is still one of each.
    await reset('candles');
    await run(h, file, { stages: ['candles'] });
    const afterCandles = await issues();
    expect(afterCandles.map((i) => i.kind)).toEqual([
      'asset_not_found',
      'graduation_pool_not_found',
    ]);
    expect(idOf(afterCandles, 'asset_not_found')).toBe(idOf(first, 'asset_not_found'));

    // Metadata runs again: candles' issue stays.
    await reset('metadata');
    await run(h, file, { stages: ['metadata'] });
    const afterMetadata = await issues();
    expect(afterMetadata.map((i) => i.kind)).toEqual([
      'asset_not_found',
      'graduation_pool_not_found',
    ]);
    expect(idOf(afterMetadata, 'graduation_pool_not_found')).toBe(
      idOf(afterCandles, 'graduation_pool_not_found'),
    );
  }, 90_000);

  it('the report reads a finished run from the database and the sample file', async () => {
    const coins = [small('1'), mid('2'), mid('3'), lost('4')];
    const h = harness(coins);
    h.provider.failing.add(coins[2]!.mint);
    const file = await csv(coins, ['30k-50k', '100k-1M', '100k-1M', '1M-10M']);
    await run(h, file);
    const sample = await readSampleFile(file);
    const data = await loadReportData(db, sample, file, new Date('2026-11-15T12:00:00Z'));
    const text = buildReport(data);
    expect(text).toContain('Candles done for 3 of 4 coins (75.0%)');
    expect(text).toContain('| candles | failed | provider_unavailable | 1 |');
    // Overall, by cell and by half-year: coins, candles done, screened out, light, full.
    expect(text).toContain('| all | 4 | 3 | 2 | 1 | 0 |');
    expect(text).toContain('| 30k-50k | 1 | 1 | 1 | 0 | 0 |');
    expect(text).toContain('| 2026-H1 | 4 | 3 | 2 | 1 | 0 |');
    expect(text).toContain('### Every coin outside 0.5 to 3');
    // Launch info named the pool for two of the three coins that finished.
    expect(text).toContain('| 2026-H1 | 2 | 3 | 66.7% |');
    expect(text).toContain('graduation_pool_not_found');
    // The failed coin has no ATH and is not in the ratio.
    const failed = data.coins.find((c) => c.mint === coins[2]!.mint)!;
    expect(failed.candles).toBe('failed');
    expect(failed.ath).toBeNull();
    expect(data.runs.count).toBe(1);
    expect(data.runs.codexUnits).toBeGreaterThan(0);
  }, 90_000);

  it('a dry run lists every stage and the candles estimate by cell, and spends nothing', async () => {
    const coins = [small('1'), small('2'), mid('3'), mid('4'), mid('5')];
    const h = harness(coins);
    const file = await csv(coins, ['30k-50k', '30k-50k', '100k-1M', '1M-10M', '10M+']);
    const before = await everything();
    const out: string[] = [];
    const report = await runIngest({
      samplePath: file,
      env: { DATABASE_URL: t.url },
      log: testLog,
      out: (s) => out.push(s),
      confirm: false,
      db,
      clients: h.clients,
      maxCodexUnits: 300,
    });
    const text = out.join('\n');
    expect(report.status).toBe('dry_run');
    expect(h.provider.total()).toBe(0);
    expect(await everything()).toEqual(before);
    expect(report.plan.stageWork).toEqual({ discovered: 5, metadata: 5, candles: 5, metrics: 5 });
    expect(report.plan.candles!.totalUnits).toBe(16 * 2 + 20 + 35 + 80);
    expect(text).toContain('about 167 compute units for 5 coins (ceiling 300)');
    expect(text).toContain('30k-50k');
    expect(text).toContain('Dry run');
  });

  it('refuses --confirm with the candles stage and no unit ceiling', async () => {
    const coins = [small('1')];
    const h = harness(coins);
    await expect(run(h, await csv(coins), { maxCodexUnits: null })).rejects.toThrow(
      /--max-codex-units is required/,
    );
    expect(h.provider.total()).toBe(0);
  });

  it('the metrics stage follows the candle module version', () => {
    expect(metricsStage.version).toBe(METRICS_VERSION);
  });
});
