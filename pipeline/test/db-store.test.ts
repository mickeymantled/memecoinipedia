import { afterAll, beforeAll, expect, it } from 'vitest';
import { sql } from 'kysely';
import { upsertCoin } from '@memecoinipedia/db';
import { Runner } from '../src/classify/batch.js';
import { DbStore, loadCoinsByMint, type ExtrasProvider } from '../src/classify/db-store.js';
import { estimatedCalibration } from '../src/classify/plan.js';
import {
  FakeClient,
  createTestDb,
  describeDb,
  goodResult,
  testBuilder,
  testConfig,
  type TestDb,
} from './helpers.js';
import { defineRunnerSuite, type CoinState, type Harness } from './runner-suite.js';

let t: TestDb;
let candidates: Record<number, string[]> = {};
let ids: number[] = [];

const extras: ExtrasProvider = (rows) => {
  const m = new Map<number, { parent_candidates?: { address: string }[] }>();
  rows.forEach((r) => {
    const i = ids.indexOf(r.id);
    const c = candidates[i];
    if (c && c.length > 0) m.set(r.id, { parent_candidates: c.map((address) => ({ address })) });
  });
  return Promise.resolve(m);
};

const harness: Harness = {
  async setup(n, cands = {}) {
    await sql`truncate coins, ingest_runs restart identity cascade`.execute(t.db);
    candidates = cands;
    ids = [];
    for (let i = 0; i < n; i++) {
      const id = await upsertCoin(t.db, {
        chain: 'solana',
        address: `Mint${i + 1}`,
        name: `Coin ${i + 1}`,
        ticker: `C${i + 1}`,
      });
      ids.push(id);
    }
  },
  keys: () => ids.map(String),
  // A fresh store over the same database, as after a restart. It shares the pool, so it is not closed.
  store: () => new DbStore(t.db, extras),
  async state(key): Promise<CoinState> {
    const c = await t.db
      .selectFrom('coins')
      .selectAll()
      .where('id', '=', Number(key))
      .executeTakeFirstOrThrow();
    const s = await t.db
      .selectFrom('coin_stages')
      .selectAll()
      .where('coin_id', '=', Number(key))
      .where('stage', '=', 'classified')
      .executeTakeFirst();
    return {
      primary: c.primary_narrative,
      confidence: c.narrative_confidence,
      model: c.classifier_model,
      version: c.classifier_prompt_version,
      stage: s?.status ?? 'none',
      error: s?.last_error ?? null,
    };
  },
};

beforeAll(async () => {
  if (process.env['TEST_DATABASE_ADMIN_URL']) t = await createTestDb();
});
afterAll(async () => {
  if (t) await t.drop();
});

describeDb('database store', () => {
  defineRunnerSuite('the database store', harness);

  const run = (
    client: FakeClient,
    passes: 'first' | 'second' | 'both' = 'first',
    force = false,
  ) => {
    const config = testConfig();
    const b = testBuilder(config);
    return new Runner({
      client,
      store: new DbStore(t.db, extras),
      builder: b,
      config,
      calibration: estimatedCalibration(b, config),
    }).run({ maxUsd: 100, passes, force });
  };

  it('stores every column, marks the classified stage and links the parent coin', async () => {
    await harness.setup(2, { 0: ['Mint2'] });
    const [k0] = harness.keys() as [string, string];
    const client = new FakeClient((r) => ({
      result: goodResult({
        primary_narrative: 'derivative',
        secondary_narratives: ['animal', 'tech'],
        confidence: 0.65,
        reason: 'Baby Coin 2',
        parent_address: r.custom_id === k0 ? 'Mint2' : null,
        sensitive: true,
        summary: 'Two sentences. Of facts.',
      }),
    }));
    await run(client);
    const c = await t.db
      .selectFrom('coins')
      .selectAll()
      .where('id', '=', Number(k0))
      .executeTakeFirstOrThrow();
    expect(c).toMatchObject({
      primary_narrative: 'derivative',
      secondary_narratives: ['animal', 'tech'],
      narrative_reason: 'Baby Coin 2',
      parent_address: 'Mint2',
      parent_coin_id: ids[1],
      sensitive: true,
      summary: 'Two sentences. Of facts.',
      classifier_model: 'claude-haiku-5-5',
    });
    expect(c.narrative_confidence).toBeCloseTo(0.65, 5);
    expect(c.classifier_prompt_version).toBe(testBuilder().version);
    expect(c.classified_at).toBeInstanceOf(Date);
    const stage = await t.db
      .selectFrom('coin_stages')
      .selectAll()
      .where('coin_id', '=', Number(k0))
      .where('stage', '=', 'classified')
      .executeTakeFirstOrThrow();
    expect(stage).toMatchObject({ status: 'done', attempts: 1, last_error: null });
    expect(stage.finished_at).toBeInstanceOf(Date);
    expect(stage.run_id).not.toBeNull();
  });

  it('keeps the batch ids, estimate and summed usage in ingest_runs', async () => {
    await harness.setup(4);
    const usage = {
      input_tokens: 7,
      cache_creation_input_tokens: 700,
      cache_read_input_tokens: 70,
      output_tokens: 9,
    };
    const client = new FakeClient(() => ({ result: goodResult(), usage }));
    await run(client);
    const runs = await t.db.selectFrom('ingest_runs').selectAll().execute();
    expect(runs).toHaveLength(1);
    const r = runs[0]!;
    expect(r).toMatchObject({ kind: 'classify', status: 'done' });
    expect(r.started_at).toBeInstanceOf(Date);
    expect(r.finished_at).toBeInstanceOf(Date);
    const params = r.params as { batches: Array<{ id: string; state: string; keys: string[] }> };
    expect(params.batches).toHaveLength(1);
    expect(params.batches[0]).toMatchObject({ id: 'batch_1', state: 'applied' });
    expect(params.batches[0]!.keys).toHaveLength(4);
    const actual = r.actual as { usage: Record<string, number>; usd: number; applied: number };
    expect(actual.usage).toEqual({
      input_tokens: 28,
      cache_creation_input_tokens: 2800,
      cache_read_input_tokens: 280,
      output_tokens: 36,
    });
    expect(actual.applied).toBe(4);
    expect(actual.usd).toBeGreaterThan(0);
    expect((r.estimate as { first: { requests: number } }).first.requests).toBe(4);
  });

  it('does not select coins in flight, and a failed coin keeps its stage row and error', async () => {
    await harness.setup(3);
    const store = new DbStore(t.db);
    const version = testBuilder().version;
    const sel = () =>
      store.selectFirstPass({ force: false, maxAttempts: 3, promptVersion: version });
    expect(await sel()).toHaveLength(3);
    const runState = await store.createRun(
      {
        firstModel: 'a',
        secondModel: 'b',
        promptVersion: version,
        force: false,
        passes: 'first',
        maxUsd: 1,
        batches: [],
      },
      null,
    );
    await store.claim(runState, 'first', [String(ids[0]), String(ids[1])]);
    expect((await sel()).map((i) => i.key)).toEqual([String(ids[2])]);
    // Even --force does not take a coin that is in flight.
    expect(
      (await store.selectFirstPass({ force: true, maxAttempts: 3, promptVersion: version })).map(
        (i) => i.key,
      ),
    ).toEqual([String(ids[2])]);
  });

  it('second pass selects confidence under 0.7 only, on the first-pass model and the current prompt version', async () => {
    await harness.setup(6);
    const version = testBuilder().version;
    const set = async (
      i: number,
      conf: number | null,
      model: string,
      ver: string,
      stage = 'done',
    ) => {
      await t.db
        .updateTable('coins')
        .set({
          narrative_confidence: conf,
          classifier_model: model,
          classifier_prompt_version: ver,
          primary_narrative: 'other',
        })
        .where('id', '=', ids[i]!)
        .execute();
      await t.db
        .insertInto('coin_stages')
        .values({ coin_id: ids[i]!, stage: 'classified', status: stage as 'done' })
        .execute();
    };
    await set(0, 0.69, 'claude-haiku-5-5', version);
    await set(1, 0.7, 'claude-haiku-5-5', version); // exactly 0.7 (a float4 reads back as 0.699999988)
    await set(2, 0.2, 'claude-sonnet-5-5', version); // already second pass
    await set(3, 0.2, 'claude-haiku-5-5', 'old-version');
    await set(4, 0.1, 'claude-haiku-5-5', version, 'running');
    const store = new DbStore(t.db);
    const rows = await store.selectSecondPass({
      firstModel: 'claude-haiku-5-5',
      threshold: 0.7,
      promptVersion: version,
    });
    expect(rows.map((r) => r.key)).toEqual([String(ids[0])]);
  });

  it('reads bare mints for file mode with a SELECT and reports unknown ones', async () => {
    await harness.setup(2);
    const { coins, missing } = await loadCoinsByMint(t.db, ['Mint2', 'Nope', 'Mint1']);
    expect(coins.map((c) => c.mint)).toEqual(['Mint2', 'Mint1']);
    expect(missing).toEqual(['Nope']);
    expect(coins[0]!.coin.name).toBe('Coin 2');
    expect(await t.db.selectFrom('ingest_runs').selectAll().execute()).toEqual([]);
  });

  it('the narratives come from the table, in order', async () => {
    const n = await new DbStore(t.db).narratives();
    expect(n.map((x) => x.slug)).toEqual([
      'ai',
      'tech',
      'animal',
      'celebrity',
      'political',
      'news_event',
      'culture_meme',
      'gaming',
      'derivative',
      'utility',
      'other',
    ]);
  });

  it('applying the same result twice writes once', async () => {
    await harness.setup(1);
    const store = new DbStore(t.db);
    const version = testBuilder().version;
    const runState = await store.createRun(
      {
        firstModel: 'claude-haiku-5-5',
        secondModel: 'b',
        promptVersion: version,
        force: false,
        passes: 'first',
        maxUsd: 1,
        batches: [],
      },
      null,
    );
    const key = String(ids[0]);
    await store.claim(runState, 'first', [key]);
    const outcome = {
      kind: 'ok' as const,
      result: goodResult(),
      model: 'claude-haiku-5-5',
      promptVersion: version,
    };
    expect(await store.apply(runState, 'first', key, outcome)).toBe('applied');
    expect(await store.apply(runState, 'first', key, outcome)).toBe('skipped');
    const stage = await t.db
      .selectFrom('coin_stages')
      .select('attempts')
      .where('coin_id', '=', ids[0]!)
      .executeTakeFirstOrThrow();
    expect(stage.attempts).toBe(1);
  });
});
