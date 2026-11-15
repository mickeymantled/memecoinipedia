import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { upsertCoin } from '../src/coins.js';
import { discoverCoins, type DiscoveredCoin } from '../src/discovery.js';
import { createRun, finishRun, getRun, getUsage, recordUsage, startRun } from '../src/runs.js';
import {
  claimStage,
  countOpenIssues,
  countStages,
  ensureStages,
  finishStage,
  groupStageFailures,
  listCoinsNotDone,
  requeueFailed,
} from '../src/stages.js';
import { replaceCoinIssues } from '../src/dataIssues.js';
import { createTestDatabase, type TestDatabase } from '../src/testing.js';
import { adminUrl, describeDb } from './helpers.js';

const T0 = new Date('2026-11-15T10:00:00Z');
const after = (ms: number) => new Date(T0.getTime() + ms);
const STALE = 60_000;

describeDb('stage tracking', () => {
  let t: TestDatabase;
  let coin: number;
  beforeAll(async () => {
    t = await createTestDatabase(adminUrl!);
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await t.db.deleteFrom('data_issues').execute();
    await t.db.deleteFrom('coin_stages').execute();
    await t.db.deleteFrom('provider_usage').execute();
    await t.db.deleteFrom('ingest_runs').execute();
    await t.db.deleteFrom('coins').execute();
    coin = await upsertCoin(t.db, { chain: 'solana', address: 'A1' });
  });

  const claim = (stage: 'metadata' | 'discovered' = 'metadata', now = T0, version = 1) =>
    claimStage(t.db, { coinId: coin, stage, now, staleAfterMs: STALE, version });
  const row = (stage = 'metadata') =>
    t.db
      .selectFrom('coin_stages')
      .selectAll()
      .where('coin_id', '=', coin)
      .where('stage', '=', stage as 'metadata')
      .executeTakeFirstOrThrow();

  it('claims a pending stage once: running, attempts plus one, second claim is busy', async () => {
    await ensureStages(t.db, [coin], ['metadata']);
    expect(await claim()).toEqual({ status: 'claimed', attempt: 1 });
    expect(await row()).toMatchObject({ status: 'running', attempts: 1, started_at: T0 });
    expect(await claim('metadata', after(1000))).toEqual({ status: 'busy' });
    expect((await row()).attempts).toBe(1);
  });

  it('creates the row on claim when none exists, and reports a missing coin', async () => {
    expect(await claim()).toEqual({ status: 'claimed', attempt: 1 });
    expect(
      await claimStage(t.db, { coinId: 999_999, stage: 'metadata', now: T0, staleAfterMs: STALE }),
    ).toEqual({ status: 'no_coin' });
  });

  it('finishes done: never claimed again at that version, and last_error is cleared', async () => {
    const c = await claim();
    if (c.status !== 'claimed') throw new Error('expected a claim');
    expect(
      await finishStage(t.db, {
        coinId: coin,
        stage: 'metadata',
        attempt: c.attempt,
        outcome: { status: 'done' },
        now: after(10),
      }),
    ).toBe(true);
    expect(await row()).toMatchObject({ status: 'done', last_error: null });
    expect(await claim('metadata', after(10 * STALE))).toEqual({
      status: 'final',
      stageStatus: 'done',
    });
    expect((await row()).attempts).toBe(1);
  });

  it('a done stage is claimable again only at a higher version', async () => {
    const c = await claim();
    if (c.status !== 'claimed') throw new Error('expected a claim');
    await finishStage(t.db, {
      coinId: coin,
      stage: 'metadata',
      attempt: c.attempt,
      outcome: { status: 'done' },
      now: after(1),
    });
    expect(await claim('metadata', after(2), 1)).toMatchObject({ status: 'final' });
    expect(await claim('metadata', after(3), 2)).toEqual({ status: 'claimed', attempt: 2 });
    expect(await row()).toMatchObject({ version: 2, status: 'running' });
  });

  it('skipped is final and keeps its reason', async () => {
    const c = await claim();
    if (c.status !== 'claimed') throw new Error('expected a claim');
    await finishStage(t.db, {
      coinId: coin,
      stage: 'metadata',
      attempt: c.attempt,
      outcome: { status: 'skipped', reason: 'no_asset' },
      now: after(1),
    });
    expect(await row()).toMatchObject({ status: 'skipped', last_error: 'no_asset' });
    expect(await claim('metadata', after(2))).toEqual({ status: 'final', stageStatus: 'skipped' });
  });

  it('failed keeps the error text and is claimable again, counting attempts', async () => {
    for (let n = 1; n <= 3; n++) {
      const c = await claim('metadata', after(n * 10));
      expect(c).toEqual({ status: 'claimed', attempt: n });
      await finishStage(t.db, {
        coinId: coin,
        stage: 'metadata',
        attempt: n,
        outcome: { status: 'failed', error: `unreachable: try ${n}` },
        now: after(n * 10 + 1),
      });
      expect(await row()).toMatchObject({ status: 'failed', last_error: `unreachable: try ${n}` });
    }
    expect((await row()).attempts).toBe(3);
  });

  it('takes over a running stage only after the timeout, and the old claim cannot finish it', async () => {
    const first = await claim('metadata', T0);
    expect(first).toEqual({ status: 'claimed', attempt: 1 });
    expect(await claim('metadata', after(STALE - 1))).toEqual({ status: 'busy' });
    expect(await claim('metadata', after(STALE))).toEqual({ status: 'claimed', attempt: 2 });

    // The first worker wakes up and tries to report: refused, row untouched.
    expect(
      await finishStage(t.db, {
        coinId: coin,
        stage: 'metadata',
        attempt: 1,
        outcome: { status: 'failed', error: 'stale worker' },
        now: after(STALE + 5),
      }),
    ).toBe(false);
    expect(await row()).toMatchObject({ status: 'running', attempts: 2, last_error: null });

    expect(
      await finishStage(t.db, {
        coinId: coin,
        stage: 'metadata',
        attempt: 2,
        outcome: { status: 'done' },
        now: after(STALE + 6),
      }),
    ).toBe(true);
  });

  it('finish refuses a stage that is not running', async () => {
    await ensureStages(t.db, [coin], ['metadata']);
    expect(
      await finishStage(t.db, {
        coinId: coin,
        stage: 'metadata',
        attempt: 0,
        outcome: { status: 'done' },
        now: T0,
      }),
    ).toBe(false);
    expect((await row()).status).toBe('pending');
  });

  it('two concurrent claims: exactly one wins', async () => {
    await ensureStages(t.db, [coin], ['metadata']);
    const results = await Promise.all(Array.from({ length: 8 }, () => claim()));
    expect(results.filter((r) => r.status === 'claimed')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'busy')).toHaveLength(7);
  });

  it('lists coins whose stage is not done, with filters', async () => {
    const b = await upsertCoin(t.db, { chain: 'solana', address: 'B2' });
    const c = await upsertCoin(t.db, { chain: 'solana', address: 'C3' });
    const d = await upsertCoin(t.db, { chain: 'solana', address: 'D4' });
    // a: no row. b: done. c: failed. d: running, fresh.
    await ensureStages(t.db, [b, c, d], ['metadata']);
    await t.db
      .updateTable('coin_stages')
      .set({ status: 'done' })
      .where('coin_id', '=', b)
      .execute();
    await t.db
      .updateTable('coin_stages')
      .set({ status: 'failed' })
      .where('coin_id', '=', c)
      .execute();
    await t.db
      .updateTable('coin_stages')
      .set({ status: 'running', started_at: after(0) })
      .where('coin_id', '=', d)
      .execute();

    const all = await listCoinsNotDone(t.db, 'metadata');
    expect(all.map((r) => r.address)).toEqual(['A1', 'C3', 'D4']);
    expect(all.map((r) => r.status)).toEqual([null, 'failed', 'running']);

    // Fresh running rows are somebody else's; a stale one is listed.
    const idle = await listCoinsNotDone(t.db, 'metadata', { runningSince: after(-1000) });
    expect(idle.map((r) => r.address)).toEqual(['A1', 'C3']);
    const stale = await listCoinsNotDone(t.db, 'metadata', { runningSince: after(1000) });
    expect(stale.map((r) => r.address)).toEqual(['A1', 'C3', 'D4']);

    expect(
      (await listCoinsNotDone(t.db, 'metadata', { excludeFailed: true })).map((r) => r.address),
    ).toEqual(['A1', 'D4']);
    expect(
      (await listCoinsNotDone(t.db, 'metadata', { addresses: ['C3', 'B2'] })).map((r) => r.address),
    ).toEqual(['C3']);
    expect((await listCoinsNotDone(t.db, 'metadata', { limit: 1 })).map((r) => r.address)).toEqual([
      'A1',
    ]);
    expect(
      (await listCoinsNotDone(t.db, 'metadata', { afterId: coin })).map((r) => r.address),
    ).toEqual(['C3', 'D4']);
    // A higher stage version brings the done coin back.
    expect(
      (await listCoinsNotDone(t.db, 'metadata', { version: 2 })).map((r) => r.address),
    ).toContain('B2');
  });

  it('leaves failed stages that used their attempts, until they are requeued', async () => {
    const b = await upsertCoin(t.db, { chain: 'solana', address: 'B2' });
    await ensureStages(t.db, [coin, b], ['metadata']);
    await t.db
      .updateTable('coin_stages')
      .set({ status: 'failed', attempts: 3, last_error: 'metadata_unreachable: x' })
      .where('coin_id', '=', coin)
      .execute();
    await t.db
      .updateTable('coin_stages')
      .set({ status: 'failed', attempts: 1 })
      .where('coin_id', '=', b)
      .execute();
    const open = await listCoinsNotDone(t.db, 'metadata', { maxAttempts: 3 });
    expect(open.map((r) => r.address)).toEqual(['B2']);
    expect(await requeueFailed(t.db, ['metadata'], { addresses: ['A1'], now: T0 })).toBe(1);
    expect(await row()).toMatchObject({ status: 'pending', attempts: 0 });
    expect(
      (await listCoinsNotDone(t.db, 'metadata', { maxAttempts: 3 })).map((r) => r.address),
    ).toEqual(['A1', 'B2']);
    expect(await requeueFailed(t.db, ['metadata'], { now: T0 })).toBe(1); // B2, no address filter
  });

  it('requires: only coins whose earlier stage is done or skipped', async () => {
    const b = await upsertCoin(t.db, { chain: 'solana', address: 'B2' });
    await ensureStages(t.db, [coin, b], ['discovered']);
    await t.db
      .updateTable('coin_stages')
      .set({ status: 'skipped' })
      .where('coin_id', '=', b)
      .execute();
    const rows = await listCoinsNotDone(t.db, 'metadata', { requires: 'discovered' });
    expect(rows.map((r) => r.address)).toEqual(['B2']);
  });

  it('counts stages and groups failures by reason code', async () => {
    const ids = [coin];
    for (const a of ['B2', 'C3', 'D4']) {
      ids.push(await upsertCoin(t.db, { chain: 'solana', address: a }));
    }
    await ensureStages(t.db, ids, ['metadata']);
    const set = (id: number, status: 'done' | 'failed', err: string | null) =>
      t.db
        .updateTable('coin_stages')
        .set({ status, last_error: err })
        .where('coin_id', '=', id)
        .execute();
    await set(ids[0]!, 'done', null);
    await set(ids[1]!, 'failed', 'metadata_unreachable: a.example timeout');
    await set(ids[2]!, 'failed', 'metadata_unreachable: b.example 429');
    expect(await countStages(t.db, ['metadata'])).toEqual(
      expect.arrayContaining([
        { stage: 'metadata', status: 'done', coins: 1 },
        { stage: 'metadata', status: 'failed', coins: 2 },
        { stage: 'metadata', status: 'pending', coins: 1 },
      ]),
    );
    expect(await groupStageFailures(t.db, ['metadata'])).toEqual([
      { stage: 'metadata', status: 'failed', reason: 'metadata_unreachable', coins: 2 },
    ]);
  });

  it('stores detail on done, clears it on failed and skipped and on a new claim', async () => {
    const c1 = await claim('metadata', after(10));
    if (c1.status !== 'claimed') throw new Error('expected a claim');
    expect(
      await finishStage(t.db, {
        coinId: coin,
        stage: 'metadata',
        attempt: c1.attempt,
        outcome: { status: 'done', detail: { path: 'light', units: 12.5 } },
        now: after(11),
      }),
    ).toBe(true);
    expect((await row()).detail).toEqual({ path: 'light', units: 12.5 });

    // A higher version runs the stage again: the old detail goes at once.
    const c2 = await claim('metadata', after(20), 2);
    if (c2.status !== 'claimed') throw new Error('expected a claim');
    expect((await row()).detail).toBeNull();
    await finishStage(t.db, {
      coinId: coin,
      stage: 'metadata',
      attempt: c2.attempt,
      outcome: { status: 'done', detail: { path: 'full' } },
      now: after(21),
    });
    expect((await row()).detail).toEqual({ path: 'full' });

    // Failed and skipped never keep one, even if the caller passes one.
    const c3 = await claim('metadata', after(30), 3);
    if (c3.status !== 'claimed') throw new Error('expected a claim');
    await finishStage(t.db, {
      coinId: coin,
      stage: 'metadata',
      attempt: c3.attempt,
      outcome: { status: 'failed', error: 'x: y' },
      now: after(31),
    });
    expect((await row()).detail).toBeNull();
    const c4 = await claim('metadata', after(40), 3);
    if (c4.status !== 'claimed') throw new Error('expected a claim');
    await finishStage(t.db, {
      coinId: coin,
      stage: 'metadata',
      attempt: c4.attempt,
      outcome: { status: 'skipped', reason: 'r' },
      now: after(41),
    });
    expect((await row()).detail).toBeNull();
  });

  it('refuses a detail over 1 KB', async () => {
    const c = await claim();
    if (c.status !== 'claimed') throw new Error('expected a claim');
    await expect(
      finishStage(t.db, {
        coinId: coin,
        stage: 'metadata',
        attempt: c.attempt,
        outcome: { status: 'done', detail: { blob: 'x'.repeat(2000) } },
        now: after(1),
      }),
    ).rejects.toThrow(/limit is 1024/);
    expect((await row()).status).toBe('running');
  });

  it('lists a coin for a stage by its own requirement, whatever other stages did', async () => {
    const set = async (stage: 'discovered' | 'metadata' | 'candles', status: 'done' | 'failed') => {
      await ensureStages(t.db, [coin], [stage]);
      await t.db
        .updateTable('coin_stages')
        .set({ status })
        .where('coin_id', '=', coin)
        .where('stage', '=', stage)
        .execute();
    };
    await set('discovered', 'done');
    await set('metadata', 'failed');
    const ids = async (stage: 'candles' | 'metrics', requires: 'discovered' | 'candles') =>
      (await listCoinsNotDone(t.db, stage, { requires })).map((c) => c.id);
    expect(await ids('candles', 'discovered')).toEqual([coin]); // metadata failed, candles still listed
    expect(await ids('metrics', 'candles')).toEqual([]); // candles not done yet
    await set('candles', 'failed');
    expect(await ids('metrics', 'candles')).toEqual([]); // candles failed: metrics waits
    await set('candles', 'done');
    expect(await ids('metrics', 'candles')).toEqual([coin]);
  });

  it('a stage replaces only the issue kinds it owns', async () => {
    const META = ['metadata_invalid', 'social_links_dropped'];
    const CANDLES = ['candle_hourly_cap_hit', 'graduation_pool_not_found'];
    const open = async () =>
      (
        await t.db
          .selectFrom('data_issues')
          .select(['kind', 'detail'])
          .where('coin_id', '=', coin)
          .where('resolved_at', 'is', null)
          .orderBy('kind')
          .execute()
      ).map((r) => [r.kind, r.detail]);
    await replaceCoinIssues(t.db, coin, META, [{ kind: 'metadata_invalid', detail: { v: 1 } }]);
    await replaceCoinIssues(t.db, coin, CANDLES, [
      { kind: 'candle_hourly_cap_hit', detail: { v: 1 } },
    ]);
    // The candles stage runs again and finds nothing: metadata's issue stays.
    await replaceCoinIssues(t.db, coin, CANDLES, []);
    expect(await open()).toEqual([['metadata_invalid', { v: 1 }]]);
    // The metadata stage runs again with a different issue: candles' issue (added back) stays.
    await replaceCoinIssues(t.db, coin, CANDLES, [
      { kind: 'graduation_pool_not_found', detail: { v: 2 } },
    ]);
    await replaceCoinIssues(t.db, coin, META, [{ kind: 'social_links_dropped', detail: { v: 3 } }]);
    expect(await open()).toEqual([
      ['graduation_pool_not_found', { v: 2 }],
      ['social_links_dropped', { v: 3 }],
    ]);
    // The same result again changes no row.
    const rowsOf = async () =>
      t.db
        .selectFrom('data_issues')
        .selectAll()
        .where('coin_id', '=', coin)
        .orderBy('id')
        .execute();
    const before = await rowsOf();
    await replaceCoinIssues(t.db, coin, META, [{ kind: 'social_links_dropped', detail: { v: 3 } }]);
    await replaceCoinIssues(t.db, coin, CANDLES, [
      { kind: 'graduation_pool_not_found', detail: { v: 2 } },
    ]);
    expect(await rowsOf()).toEqual(before);
    // A stage cannot write a kind it does not own.
    await expect(
      replaceCoinIssues(t.db, coin, META, [{ kind: 'candle_hourly_cap_hit' }]),
    ).rejects.toThrow(/not owned/);
  });

  it('replaces open issues of the owned kinds and leaves the rest', async () => {
    await replaceCoinIssues(
      t.db,
      coin,
      ['metadata_invalid', 'social_links_dropped'],
      [{ kind: 'metadata_invalid', detail: { gateway: 'g' } }],
    );
    await replaceCoinIssues(t.db, coin, ['other_kind'], [{ kind: 'other_kind' }]);
    await replaceCoinIssues(
      t.db,
      coin,
      ['metadata_invalid', 'social_links_dropped'],
      [{ kind: 'social_links_dropped', detail: { links: [1, 2] } }],
    );
    expect(await countOpenIssues(t.db)).toEqual([
      { kind: 'other_kind', coins: 1, issues: 1 },
      { kind: 'social_links_dropped', coins: 1, issues: 1 },
    ]);
  });

  it('records a run with its estimate, usage and result', async () => {
    const id = await createRun(t.db, {
      kind: 'ingest-sample',
      params: { stages: ['metadata'] },
      estimate: { helius: { requests: 1, credits: 10 } },
    });
    expect(await getRun(t.db, id)).toMatchObject({ status: 'planned', actual: null });
    await startRun(t.db, id, T0);
    await recordUsage(t.db, id, { provider: 'helius', requests: 1, units: 10 }, T0);
    await recordUsage(t.db, id, { provider: 'helius', requests: 2, units: 20 }, after(5)); // a total, not an increment
    await recordUsage(t.db, id, { provider: 'jupiter', requests: 5, units: 0 }, T0);
    await finishRun(t.db, id, {
      status: 'done',
      actual: { helius: { credits: 20 } },
      now: after(9),
    });
    const run = await getRun(t.db, id);
    expect(run).toMatchObject({
      status: 'done',
      estimate: { helius: { requests: 1, credits: 10 } },
      actual: { helius: { credits: 20 } },
      startedAt: T0,
      finishedAt: after(9),
    });
    expect(await getUsage(t.db, id)).toEqual([
      { provider: 'helius', requests: 2, units: 20 },
      { provider: 'jupiter', requests: 5, units: 0 },
    ]);
  });
});

describeDb('discoverCoins', () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase(adminUrl!);
  });
  afterAll(async () => {
    await t.drop();
  });

  const coin = (address: string, extra: Partial<DiscoveredCoin> = {}): DiscoveredCoin => ({
    chain: 'solana',
    address,
    launchpad: 'pump.fun',
    launchedAt: new Date('2024-05-21T04:58:06Z'),
    creatorWallet: 'W1',
    graduatedAt: new Date('2024-05-21T06:21:58Z'),
    discoverySource: 'dune-2026-11-15',
    roughAthMarketCapUsd: 934000,
    ...extra,
  });

  it('inserts, marks discovered done, and a second load changes nothing', async () => {
    const rows = [coin('M1'), coin('M2', { graduatedAt: null }), coin('M1')];
    const first = await discoverCoins(t.db, rows, { now: T0 });
    expect(first).toEqual({ total: 2, inserted: 2, updated: 0, unchanged: 0, stagesMarked: 2 });

    const snapshot = async () => ({
      coins: await t.db.selectFrom('coins').selectAll().orderBy('id').execute(),
      stages: await t.db.selectFrom('coin_stages').selectAll().orderBy('coin_id').execute(),
    });
    const before = await snapshot();
    const second = await discoverCoins(t.db, rows, { now: after(60_000) });
    expect(second).toEqual({ total: 2, inserted: 0, updated: 0, unchanged: 2, stagesMarked: 0 });
    expect(await snapshot()).toEqual(before);

    const m1 = before.coins.find((c) => c.address === 'M1')!;
    expect(m1).toMatchObject({
      chain: 'solana',
      launchpad: 'pump.fun',
      creator_wallet: 'W1',
      discovery_source: 'dune-2026-11-15',
      rough_ath_market_cap_usd: 934000,
    });
    // Creation and graduation time stay separate.
    expect(m1.launched_at).toEqual(new Date('2024-05-21T04:58:06Z'));
    expect(m1.graduated_at).toEqual(new Date('2024-05-21T06:21:58Z'));
    expect(before.coins.find((c) => c.address === 'M2')!.graduated_at).toBeNull();
  });

  it('fills fields that were null but never overwrites a value', async () => {
    await discoverCoins(t.db, [coin('N1', { graduatedAt: null, creatorWallet: null })], {
      now: T0,
    });
    const r = await discoverCoins(
      t.db,
      [
        coin('N1', {
          graduatedAt: new Date('2024-06-01T00:00:00Z'),
          creatorWallet: 'W9',
          launchpad: 'other',
          roughAthMarketCapUsd: 1,
        }),
      ],
      { now: after(1000) },
    );
    expect(r).toMatchObject({ inserted: 0, updated: 1, unchanged: 0, stagesMarked: 0 });
    const n1 = await t.db
      .selectFrom('coins')
      .selectAll()
      .where('address', '=', 'N1')
      .executeTakeFirstOrThrow();
    expect(n1).toMatchObject({
      creator_wallet: 'W9',
      launchpad: 'pump.fun',
      rough_ath_market_cap_usd: 934000,
    });
    expect(n1.graduated_at).toEqual(new Date('2024-06-01T00:00:00Z'));
  });

  it('completes a discovered stage that was pending', async () => {
    const id = await upsertCoin(t.db, { chain: 'solana', address: 'P1' });
    await ensureStages(t.db, [id], ['discovered']);
    const r = await discoverCoins(t.db, [coin('P1')], { now: T0 });
    expect(r.stagesMarked).toBe(1);
    expect(
      await t.db
        .selectFrom('coin_stages')
        .select('status')
        .where('coin_id', '=', id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: 'done' });
  });
});
