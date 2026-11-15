import { beforeEach, describe, expect, it } from 'vitest';
import { Runner, chunkRequests, type RunSummary } from '../src/classify/batch.js';
import type { BatchRequest } from '../src/classify/client.js';
import { estimatedCalibration, planPass } from '../src/classify/plan.js';
import type { ClassifyStore, RunState, WorkItem } from '../src/classify/store.js';
import { FakeClient, coin, goodResult, testBuilder, testConfig, type Reply } from './helpers.js';
import type { ClassifyConfig } from '../src/classify/config.js';
import type { PromptBuilder } from '../src/classify/prompt.js';

/**
 * Scenarios that must hold for every store. `test/batch.test.ts` runs them on the file store,
 * `test/db-store.test.ts` on the database store.
 */

export interface CoinState {
  primary: string | null;
  confidence: number | null;
  model: string | null;
  version: string | null;
  stage: string;
  error: string | null;
}

export interface Harness {
  /** Creates `n` coins (clearing any earlier state). `candidates` is by coin index. */
  setup(n: number, candidates?: Record<number, string[]>): Promise<void>;
  keys(): string[];
  /** A store instance over the same persistent state: a restart. */
  store(): ClassifyStore;
  state(key: string): Promise<CoinState>;
}

const OPTS = { maxUsd: 100, passes: 'both' as const, force: false };

function runner(
  h: Harness,
  client: FakeClient,
  over: Partial<ClassifyConfig> = {},
  builder?: PromptBuilder,
  store: ClassifyStore = h.store(),
): Runner {
  const config = testConfig(over);
  const b = builder ?? testBuilder(config);
  return new Runner({
    client,
    store,
    builder: b,
    config,
    calibration: estimatedCalibration(b, config),
  });
}

/** Reply by model: first pass answers `first`, second pass answers `second`. */
function byModel(
  first: (key: string) => Reply,
  second: (key: string) => Reply = () => ({ result: goodResult({ confidence: 0.95 }) }),
): (r: BatchRequest) => Reply {
  return (r) =>
    r.params.model === testConfig().firstModel ? first(r.custom_id) : second(r.custom_id);
}

export function defineRunnerSuite(label: string, h: Harness): void {
  describe(`runner on ${label}`, () => {
    beforeEach(async () => {
      await h.setup(5);
    });

    it('classifies every coin in one batch, using the coin id as custom_id, and stores validated results', async () => {
      const client = new FakeClient();
      const summary = await runner(h, client).run(OPTS);
      expect(summary.status).toBe('done');
      expect(client.created).toHaveLength(1);
      expect(client.created[0]!.requests.map((r) => r.custom_id).sort()).toEqual(
        [...h.keys()].sort(),
      );
      for (const k of h.keys()) {
        const s = await h.state(k);
        expect(s).toMatchObject({
          primary: 'animal',
          confidence: 0.9,
          model: 'claude-haiku-5-5',
          stage: 'done',
          error: null,
        });
        expect(s.version).toMatch(/^test-v0\+/);
      }
      // The request is the system prompt (cached) plus the coin record, with the output schema.
      const p = client.created[0]!.requests[0]!.params;
      expect(p.system[0]!.cache_control).toBeDefined();
      expect(p.output_config.format.type).toBe('json_schema');
    });

    it('sums API usage per run, in the API field names, and prices it', async () => {
      const client = new FakeClient(() => ({
        result: goodResult(),
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 1000,
          cache_read_input_tokens: 0,
          output_tokens: 20,
        },
      }));
      const summary = await runner(h, client).run({ ...OPTS, passes: 'first' });
      expect(summary.actual.usage).toEqual({
        input_tokens: 50,
        cache_creation_input_tokens: 5000,
        cache_read_input_tokens: 0,
        output_tokens: 100,
      });
      // (50*0.10 + 5000*0.20 + 100*0.50) / 1e6 * 0.5
      expect(summary.actual.usd).toBeCloseTo(((50 * 0.1 + 5000 * 0.2 + 100 * 0.5) / 1e6) * 0.5, 12);
      expect(summary.actual).toMatchObject({ batches: 1, requests: 5, applied: 5, failed: 0 });
      // Persisted: a restarted store sees the same figures on the finished run record.
      expect(await h.store().openRuns()).toEqual([]);
    });

    it('re-running skips coins already classified with the current prompt version, and sends nothing', async () => {
      const client = new FakeClient();
      await runner(h, client).run({ ...OPTS, passes: 'first' });
      const again = await runner(h, client).run({ ...OPTS, passes: 'first' });
      expect(client.created).toHaveLength(1);
      expect(again.actual.requests).toBe(0);
    });

    it('--force re-classifies; a new prompt version re-opens the coins', async () => {
      const client = new FakeClient();
      await runner(h, client).run({ ...OPTS, passes: 'first' });
      await runner(h, client).run({ ...OPTS, passes: 'first', force: true });
      expect(client.created).toHaveLength(2);
      expect(client.created[1]!.requests).toHaveLength(5);

      const config = testConfig();
      const next = testBuilderWithTaxonomy(config, 'A changed taxonomy.');
      await runner(h, client, {}, next).run({ ...OPTS, passes: 'first' });
      expect(client.created).toHaveLength(3);
      expect((await h.state(h.keys()[0]!)).version).toBe(next.version);
    });

    it('records an invalid result as a failure for that coin and does not write it', async () => {
      const bad = h.keys()[1]!;
      const worse = h.keys()[2]!;
      const client = new FakeClient((r) =>
        r.custom_id === bad
          ? { result: goodResult({ parent_address: 'MadeUpAddress' }) }
          : r.custom_id === worse
            ? { text: '{"primary_narrative": "animal"' }
            : { result: goodResult() },
      );
      const s = await runner(h, client).run({ ...OPTS, passes: 'first' });
      expect(s.actual).toMatchObject({ applied: 3, failed: 2 });
      for (const k of [bad, worse]) {
        const st = await h.state(k);
        expect(st.primary).toBeNull();
        expect(st.stage).toBe('failed');
        expect(st.error).toBeTruthy();
      }
      expect((await h.state(bad)).error).toMatch(/parent_address/);
    });

    it('retries a failed coin on the next run, up to the attempt limit', async () => {
      const bad = h.keys()[0]!;
      const client = new FakeClient((r) =>
        r.custom_id === bad ? { text: 'nope' } : { result: goodResult() },
      );
      for (let i = 0; i < 4; i++)
        await runner(h, client, { maxAttempts: 2 }).run({ ...OPTS, passes: 'first' });
      // run 1: 5 requests; run 2: only the failed coin; runs 3 and 4: it has used both attempts.
      expect(client.created.map((c) => c.requests.length)).toEqual([5, 1]);
    });

    it('treats refusal, cut-off output, errored and expired results without writing garbage', async () => {
      const [a, b, c, d] = h.keys() as [string, string, string, string];
      const client = new FakeClient((r) => {
        if (r.custom_id === a) return { result: goodResult(), stopReason: 'refusal' };
        if (r.custom_id === b) return { result: goodResult(), stopReason: 'max_tokens' };
        if (r.custom_id === c) return { outcome: 'errored' };
        if (r.custom_id === d) return { outcome: 'expired' };
        return { result: goodResult() };
      });
      const s = await runner(h, client).run({ ...OPTS, passes: 'first' });
      expect(s.actual).toMatchObject({ applied: 1, failed: 3, released: 1 });
      expect((await h.state(a)).stage).toBe('failed');
      expect((await h.state(b)).error).toMatch(/max_tokens/);
      expect((await h.state(c)).error).toMatch(/errored/);
      // Expired: back to pending with no attempt used, so the next run sends it again.
      expect(await h.state(d)).toMatchObject({ stage: 'pending', primary: null });
      const client2 = new FakeClient();
      await runner(h, client2).run({ ...OPTS, passes: 'first' });
      expect(client2.created[0]!.requests.map((r) => r.custom_id)).toContain(d);
    });

    it('re-runs coins under 0.7 on the second-pass model and replaces the first result', async () => {
      const keys = h.keys();
      const low = new Set([keys[0]!, keys[1]!, keys[2]!]);
      const exactly = keys[3]!; // 0.7 exactly: not under the threshold
      const client = new FakeClient(
        byModel(
          (k) =>
            low.has(k)
              ? { result: goodResult({ confidence: 0.55, primary_narrative: 'other' }) }
              : k === exactly
                ? { result: goodResult({ confidence: 0.7 }) }
                : { result: goodResult({ confidence: 0.95 }) },
          () => ({ result: goodResult({ confidence: 0.85, primary_narrative: 'tech' }) }),
        ),
      );
      const s = await runner(h, client).run(OPTS);
      expect(client.created).toHaveLength(2);
      expect(client.created[1]!.requests.map((r) => r.custom_id).sort()).toEqual([...low].sort());
      expect(client.created[1]!.requests[0]!.params.model).toBe('claude-sonnet-5-5');
      expect(client.created[1]!.requests[0]!.params.thinking).toEqual({ type: 'between_tools' });
      for (const k of low) {
        expect(await h.state(k)).toMatchObject({
          primary: 'tech',
          model: 'claude-sonnet-5-5',
          stage: 'done',
        });
        expect((await h.state(k)).confidence).toBeCloseTo(0.85, 5);
      }
      expect(await h.state(exactly)).toMatchObject({ model: 'claude-haiku-5-5' });
      expect(await h.state(keys[4]!)).toMatchObject({ model: 'claude-haiku-5-5' });
      expect(s.actual.requests).toBe(8);
      // A third run does not send the Sonnet results again (their model is not the first-pass model).
      await runner(h, client).run(OPTS);
      expect(client.created).toHaveLength(2);
    });

    it('keeps the first result when the second pass fails validation', async () => {
      const k0 = h.keys()[0]!;
      const client = new FakeClient(
        byModel(
          (k) => ({ result: goodResult({ confidence: k === k0 ? 0.4 : 0.9 }) }),
          () => ({ text: 'broken' }),
        ),
      );
      await runner(h, client).run(OPTS);
      const st = await h.state(k0);
      expect(st).toMatchObject({ model: 'claude-haiku-5-5', primary: 'animal', stage: 'done' });
      expect(st.error).toMatch(/second pass failed/);
    });

    it('stops submitting when the estimate for the next batch would pass the ceiling', async () => {
      await h.setup(6);
      const config = testConfig({ batchMaxRequests: 2 });
      const b = testBuilder(config);
      const cal = estimatedCalibration(b, config);
      const two = await h
        .store()
        .selectFirstPass({ force: false, maxAttempts: 3, promptVersion: b.version, limit: 2 });
      const perBatch = planPass(two, config.firstModel, config, cal).usd.noCacheHits;
      expect(perBatch).toBeGreaterThan(0);

      // A ceiling under one batch: nothing is sent.
      const none = new FakeClient();
      const s1 = await runner(h, none, { batchMaxRequests: 2 }).run({
        maxUsd: perBatch * 0.9,
        passes: 'first',
        force: false,
      });
      expect(none.created).toHaveLength(0);
      expect(s1).toMatchObject({ stoppedByCeiling: true, status: 'stopped' });

      // Room for one batch and a half: exactly one 2-coin batch goes, the rest wait.
      const one = new FakeClient();
      const s2 = await runner(h, one, { batchMaxRequests: 2 }).run({
        maxUsd: perBatch * 1.5,
        passes: 'first',
        force: false,
      });
      expect(one.created).toHaveLength(1);
      expect(one.created[0]!.requests).toHaveLength(2);
      expect(s2.stoppedByCeiling).toBe(true);
      expect(s2.actual.requests).toBe(2);

      // Room for all three: nothing left over.
      const rest = new FakeClient();
      const s3 = await runner(h, rest, { batchMaxRequests: 2 }).run({
        maxUsd: perBatch * 3.5,
        passes: 'first',
        force: false,
      });
      expect(s3.stoppedByCeiling).toBe(false);
      expect(rest.created.flatMap((c) => c.requests)).toHaveLength(4);
      const sent = [...one.created, ...rest.created].flatMap((c) =>
        c.requests.map((r) => r.custom_id),
      );
      expect(sent.sort()).toEqual([...h.keys()].sort());
    });

    it('splits batches by request count and by size in bytes', () => {
      const mk = (i: number, pad = 0): { item: WorkItem; request: BatchRequest } => ({
        item: { key: String(i), coin: coin(), candidates: [] },
        request: {
          custom_id: String(i),
          params: {
            model: 'm',
            max_tokens: 1,
            system: [{ type: 'text', text: 'x'.repeat(pad) }],
            messages: [{ role: 'user', content: 'u' }],
            output_config: { format: { type: 'json_schema', schema: {} } },
          },
        },
      });
      const five = [1, 2, 3, 4, 5].map((i) => mk(i));
      expect([...chunkRequests(five, 2, 1e9)].map((c) => c.requests.length)).toEqual([2, 2, 1]);
      const big = [1, 2, 3, 4, 5].map((i) => mk(i, 1000));
      expect([...chunkRequests(big, 100, 2500)].map((c) => c.requests.length)).toEqual([2, 2, 1]);
      // A single request over the byte limit still goes alone.
      expect([...chunkRequests(big, 100, 10)].map((c) => c.requests.length)).toEqual([
        1, 1, 1, 1, 1,
      ]);
      expect([...chunkRequests([], 2, 100)]).toEqual([]);
    });

    it('a run killed after submitting resumes from the saved batch ids and does not submit the same coins twice', async () => {
      const client = new FakeClient();
      // The process dies while polling: getBatch throws once.
      const realGet = client.getBatch.bind(client);
      let killed = false;
      client.getBatch = (id: string) => {
        if (!killed) {
          killed = true;
          return Promise.reject(new Error('process killed'));
        }
        return realGet(id);
      };
      await expect(runner(h, client).run({ ...OPTS, passes: 'first' })).rejects.toThrow('killed');
      expect(client.created).toHaveLength(1);
      // Nothing is classified yet and every coin is in flight, so a fresh selection finds none.
      const open = await h.store().openRuns();
      expect(open).toHaveLength(1);
      expect(open[0]!.params.batches).toHaveLength(1);
      expect(open[0]!.params.batches[0]).toMatchObject({ id: 'batch_1', state: 'submitted' });
      expect(
        await h
          .store()
          .selectFirstPass({ force: false, maxAttempts: 3, promptVersion: testBuilder().version }),
      ).toEqual([]);

      // Restart: same saved ids, no new batch for those coins.
      const s = await runner(h, client).run({ ...OPTS, passes: 'first' });
      expect(s.resumedRuns).toHaveLength(1);
      expect(client.created).toHaveLength(1);
      for (const k of h.keys())
        expect(await h.state(k)).toMatchObject({ stage: 'done', primary: 'animal' });
      expect(await h.store().openRuns()).toEqual([]);
    });

    it('resumes safely when it was killed halfway through applying results', async () => {
      const client = new FakeClient();
      const store = h.store();
      const realApply = store.apply.bind(store);
      let n = 0;
      store.apply = (...args: Parameters<ClassifyStore['apply']>) => {
        if (++n === 3) return Promise.reject(new Error('process killed'));
        return realApply(...args);
      };
      await expect(
        runner(h, client, {}, undefined, store).run({ ...OPTS, passes: 'first' }),
      ).rejects.toThrow('killed');
      const s = await runner(h, client).run({ ...OPTS, passes: 'first' });
      expect(client.created).toHaveLength(1);
      expect(s.resumedRuns).toHaveLength(1);
      for (const k of h.keys())
        expect(await h.state(k)).toMatchObject({ stage: 'done', primary: 'animal' });
      const done = await finishedRunApplied(h);
      expect(done).toBe(5);
    });

    it('a kill between creating a batch and saving its id releases the coins and flags the entry', async () => {
      const client = new FakeClient();
      const store = h.store();
      const realSave = store.saveRun.bind(store);
      let crashed = false;
      store.saveRun = (run: RunState) => {
        const submitted = run.params.batches.some((b) => b.state === 'submitted');
        if (submitted && !crashed) {
          crashed = true;
          return Promise.reject(new Error('process killed'));
        }
        return realSave(run);
      };
      await expect(
        runner(h, client, {}, undefined, store).run({ ...OPTS, passes: 'first' }),
      ).rejects.toThrow('killed');
      expect(client.created).toHaveLength(1);
      const open = await h.store().openRuns();
      expect(open[0]!.params.batches[0]).toMatchObject({ id: null, state: 'pending' });

      const client2 = new FakeClient();
      const s = await runner(h, client2).run({ ...OPTS, passes: 'first' });
      expect(s.resumedRuns).toHaveLength(1);
      // The unknown batch cannot be polled; its coins went back and are sent in a new batch.
      expect(client2.created).toHaveLength(1);
      for (const k of h.keys()) expect((await h.state(k)).stage).toBe('done');
    });

    it('rolls back when batch creation itself fails, so nothing is stuck in flight', async () => {
      const client = new FakeClient();
      client.failCreateOn = 1;
      await expect(runner(h, client).run({ ...OPTS, passes: 'first' })).rejects.toThrow(
        'create failed',
      );
      for (const k of h.keys()) expect((await h.state(k)).stage).toBe('pending');
      const client2 = new FakeClient();
      await runner(h, client2).run({ ...OPTS, passes: 'first' });
      for (const k of h.keys()) expect((await h.state(k)).stage).toBe('done');
    });

    it('polls until the batch has ended', async () => {
      const client = new FakeClient(undefined, 3);
      await runner(h, client).run({ ...OPTS, passes: 'first' });
      expect(client.getBatchCalls).toBe(4);
    });

    it('accepts a parent address from the input candidates and rejects any other', async () => {
      await h.setup(2, { 0: ['RealParent'], 1: ['RealParent'] });
      const [k0, k1] = h.keys() as [string, string];
      const client = new FakeClient((r) => ({
        result: goodResult({
          primary_narrative: 'derivative',
          secondary_narratives: [],
          parent_address: r.custom_id === k0 ? 'RealParent' : 'Invented',
        }),
      }));
      await runner(h, client).run({ ...OPTS, passes: 'first' });
      expect(await h.state(k0)).toMatchObject({ primary: 'derivative', stage: 'done' });
      expect(await h.state(k1)).toMatchObject({ primary: null, stage: 'failed' });
      // The candidates were given to the model inside the data block.
      const msgs = client.created[0]!.requests.map((r) => r.params.messages[0]!.content).join('\n');
      expect(msgs).toContain('RealParent');
    });

    it('refuses a real run without a positive ceiling', async () => {
      await expect(runner(h, new FakeClient()).run({ ...OPTS, maxUsd: 0 })).rejects.toThrow(
        /max-usd/,
      );
    });
  });
}

async function finishedRunApplied(h: Harness): Promise<number> {
  let n = 0;
  for (const k of h.keys()) if ((await h.state(k)).stage === 'done') n++;
  return n;
}

function testBuilderWithTaxonomy(config: ClassifyConfig, taxonomy: string): PromptBuilder {
  return testBuilder(config, taxonomy);
}

export type { RunSummary };
