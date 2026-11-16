import type { BatchRequest, BatchResultEntry, ClassifierClient } from './client.js';
import type { ClassifyConfig } from './config.js';
import { addUsage, emptyUsage, usdForUsage } from './estimate.js';
import { planPass, type Calibration } from './plan.js';
import type { PromptBuilder } from './prompt.js';
import type { ModelPricing } from './pricing.js';
import { parseResult } from './schema.js';
import type {
  ApplyOutcome,
  BatchEntry,
  ClassifyStore,
  Pass,
  RunActual,
  RunState,
  WorkItem,
} from './store.js';

/**
 * The batch runner: selects coins, submits batches, saves the batch ids, polls, applies results.
 *
 * Limits (https://platform.claude.com/docs/en/build-with-claude/batch-processing): a batch holds
 * at most 100,000 requests or 256 MB, whichever comes first; most finish within an hour and all
 * within 24; results stay available for 29 days after creation; results come back in any order,
 * so they are matched by `custom_id`. Every request repeats the system prompt, so the 256 MB
 * limit binds long before the request count does; `chunkRequests` splits on both.
 *
 * Crash safety. Before a batch is created the run records an entry with `id: null` and the coin
 * keys, then marks those coins in flight (`claim`), then calls the API, then records the id. A
 * restart polls every recorded id and applies its results, and never selects an in-flight coin,
 * so the same coins are not submitted twice. The one gap is a kill between the API creating a
 * batch and the id being saved: the entry stays `pending`, the resume releases its coins and
 * reports the entry as abandoned, and those coins can be sent again. Anthropic has no lookup
 * by label, so that batch cannot be found; check the console for a batch created at that time.
 */

export interface RunnerDeps {
  client: ClassifierClient;
  store: ClassifyStore;
  builder: PromptBuilder;
  config: ClassifyConfig;
  calibration: Calibration;
  prices?: Record<string, ModelPricing> | undefined;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export interface RunOptions {
  maxUsd: number;
  passes: 'first' | 'second' | 'both';
  force: boolean;
  limit?: number | undefined;
  chain?: string | undefined;
  minAthUsd?: number | undefined;
}

export interface RunSummary {
  runId: number;
  status: RunState['status'];
  stoppedByCeiling: boolean;
  actual: RunActual;
  resumedRuns: number[];
}

export function emptyActual(): RunActual {
  return {
    usage: emptyUsage(),
    usd: 0,
    batches: 0,
    requests: 0,
    applied: 0,
    failed: 0,
    skipped: 0,
    released: 0,
    abandonedBatches: 0,
  };
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const SAVE_EVERY = 200;

/** Splits requests into batches under both the request-count and the byte limit. */
export function* chunkRequests(
  entries: Iterable<{ item: WorkItem; request: BatchRequest }>,
  maxRequests: number,
  maxBytes: number,
): Generator<{ items: WorkItem[]; requests: BatchRequest[] }> {
  let items: WorkItem[] = [];
  let requests: BatchRequest[] = [];
  let bytes = 0;
  for (const e of entries) {
    const size = Buffer.byteLength(JSON.stringify(e.request));
    if (requests.length > 0 && (requests.length >= maxRequests || bytes + size > maxBytes)) {
      yield { items, requests };
      items = [];
      requests = [];
      bytes = 0;
    }
    items.push(e.item);
    requests.push(e.request);
    bytes += size;
  }
  if (requests.length > 0) yield { items, requests };
}

export class Runner {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (line: string) => void;
  /** Dollars (no-cache-hit basis) committed by batches submitted in this process. */
  private committedUsd = 0;
  private ceilingHit = false;

  constructor(private readonly d: RunnerDeps) {
    this.sleep = d.sleep ?? defaultSleep;
    this.log = d.log ?? ((): void => undefined);
  }

  async run(opts: RunOptions): Promise<RunSummary> {
    const { store, config, builder } = this.d;
    if (!(opts.maxUsd > 0)) throw new Error('A real run needs a positive --max-usd.');

    const resumedRuns: number[] = [];
    for (const open of await store.openRuns()) {
      this.log(`resuming run ${open.id}`);
      await this.drain(open);
      await this.finish(open, 'done');
      resumedRuns.push(open.id);
    }

    const run = await store.createRun(
      {
        firstModel: config.firstModel,
        secondModel: config.secondModel,
        promptVersion: builder.version,
        force: opts.force,
        passes: opts.passes,
        maxUsd: opts.maxUsd,
        batches: [],
      },
      null,
    );
    // An error here (a network failure while polling, say) leaves the run in status 'running' on
    // purpose: the next invocation finds it and resumes from the saved batch ids. Only a failed
    // `create` is rolled back, because nothing is in flight then.
    if (opts.passes !== 'second') {
      const items = await store.selectFirstPass({
        force: opts.force,
        maxAttempts: config.maxAttempts,
        promptVersion: builder.version,
        limit: opts.limit,
        chain: opts.chain,
        minAthUsd: opts.minAthUsd,
      });
      this.log(`first pass: ${items.length} coins`);
      await this.submit(run, 'first', items, opts.maxUsd);
      await this.drain(run);
    }
    if (opts.passes !== 'first' && !this.ceilingHit) {
      const items = await store.selectSecondPass({
        firstModel: config.firstModel,
        threshold: config.secondPassThreshold,
        promptVersion: builder.version,
        limit: opts.limit,
      });
      this.log(`second pass: ${items.length} coins`);
      await this.submit(run, 'second', items, opts.maxUsd);
      await this.drain(run);
    }
    await this.finish(run, this.ceilingHit ? 'stopped' : 'done');
    return {
      runId: run.id,
      status: run.status,
      stoppedByCeiling: this.ceilingHit,
      actual: run.actual,
      resumedRuns,
    };
  }

  private async finish(run: RunState, status: 'done' | 'stopped'): Promise<void> {
    run.status = status;
    await this.d.store.saveRun(run);
  }

  /** Builds and submits batches for `items`, stopping before the batch that would pass the ceiling. */
  private async submit(
    run: RunState,
    pass: Pass,
    items: WorkItem[],
    maxUsd: number,
  ): Promise<void> {
    const { client, store, builder, config, calibration, prices } = this.d;
    const model = pass === 'first' ? config.firstModel : config.secondModel;
    if (items.length === 0) return;
    const whole = planPass(items, model, config, calibration, prices);
    run.estimate = {
      ...((run.estimate as Record<string, unknown> | null) ?? {}),
      [pass]: { model, requests: whole.requests, tokens: whole.tokens, usd: whole.usd },
    };
    await store.saveRun(run);
    const lazy = function* (): Generator<{ item: WorkItem; request: BatchRequest }> {
      for (const item of items) {
        yield { item, request: builder.request(item.key, model, item.coin) };
      }
    };
    for (const chunk of chunkRequests(lazy(), config.batchMaxRequests, config.batchMaxBytes)) {
      const estimateUsd = planPass(chunk.items, model, config, calibration, prices).usd.noCacheHits;
      if (this.committedUsd + estimateUsd > maxUsd + 1e-9) {
        this.ceilingHit = true;
        this.log(
          `stopping: next batch estimated at $${estimateUsd.toFixed(2)} would pass the ceiling ` +
            `($${this.committedUsd.toFixed(2)} committed of $${maxUsd.toFixed(2)})`,
        );
        return;
      }
      const keys = chunk.items.map((i) => i.key);
      const candidates: Record<string, string[]> = {};
      for (const i of chunk.items) if (i.candidates.length > 0) candidates[i.key] = i.candidates;
      const entry: BatchEntry = {
        id: null,
        pass,
        model,
        state: 'pending',
        keys,
        candidates,
        estimateUsd,
      };
      // Write-ahead: the intent is on record before the coins are claimed and before the API call.
      run.params.batches.push(entry);
      await store.saveRun(run);
      await store.claim(run, pass, keys);
      let info;
      try {
        info = await client.createBatch(chunk.requests);
      } catch (err) {
        await store.release(run, pass, keys);
        run.params.batches.pop();
        await store.saveRun(run);
        throw err;
      }
      entry.id = info.id;
      entry.state = 'submitted';
      run.actual.batches += 1;
      run.actual.requests += keys.length;
      await store.saveRun(run);
      this.committedUsd += estimateUsd;
      this.log(`submitted ${info.id}: ${keys.length} requests (${pass} pass)`);
    }
  }

  /** Polls and applies every batch of the run that is not applied yet. */
  private async drain(run: RunState): Promise<void> {
    for (const entry of run.params.batches) {
      if (entry.state === 'applied') continue;
      if (entry.id === null) {
        await this.d.store.release(run, entry.pass, entry.keys);
        entry.state = 'applied';
        entry.abandoned = true;
        run.actual.abandonedBatches += 1;
        this.log(
          'a batch entry has no id: the process stopped while creating it. Its coins were ' +
            'released. If the API created it, it exists in the console and will be billed.',
        );
        await this.d.store.saveRun(run);
        continue;
      }
      await this.waitForEnd(entry.id);
      await this.applyBatch(run, entry, entry.id);
      entry.state = 'applied';
      await this.d.store.saveRun(run);
    }
  }

  private async waitForEnd(batchId: string): Promise<void> {
    for (;;) {
      const info = await this.d.client.getBatch(batchId);
      if (info.status === 'ended') return;
      this.log(`batch ${batchId}: ${info.status}, ${info.counts.processing} processing`);
      await this.sleep(this.d.config.pollIntervalMs);
    }
  }

  private async applyBatch(run: RunState, entry: BatchEntry, batchId: string): Promise<void> {
    const { store, client, builder, prices, config } = this.d;
    const seen = new Set<string>();
    let sinceSave = 0;
    for await (const r of client.readResults(batchId)) {
      seen.add(r.customId);
      const outcome = this.toOutcome(r, entry, run, builder.slugs);
      if (outcome === 'release') {
        await store.release(run, entry.pass, [r.customId]);
        run.actual.released += 1;
        continue;
      }
      const res = await store.apply(run, entry.pass, r.customId, outcome);
      if (res === 'skipped') {
        run.actual.skipped += 1;
        continue;
      }
      if (outcome.kind === 'ok') run.actual.applied += 1;
      else run.actual.failed += 1;
      if (r.outcome === 'succeeded') {
        addUsage(run.actual.usage, r.usage);
        run.actual.usd += usdForUsage(entry.model, r.usage, config.cacheTtl, prices);
      }
      if (++sinceSave >= SAVE_EVERY) {
        sinceSave = 0;
        await store.saveRun(run);
      }
    }
    // Requests the batch never reported: put them back rather than leave them in flight.
    const missing = entry.keys.filter((k) => !seen.has(k));
    if (missing.length > 0) {
      await store.release(run, entry.pass, missing);
      run.actual.released += missing.length;
    }
  }

  private toOutcome(
    r: BatchResultEntry,
    entry: BatchEntry,
    run: RunState,
    slugs: string[],
  ): ApplyOutcome | 'release' {
    switch (r.outcome) {
      case 'canceled':
      case 'expired':
        return 'release';
      case 'errored':
        return { kind: 'failed', error: `request errored (${r.errorType}): ${r.errorMessage}` };
      case 'succeeded': {
        if (r.stopReason === 'refusal')
          return { kind: 'failed', error: 'model refused (stop_reason refusal)' };
        if (r.stopReason === 'max_tokens')
          return { kind: 'failed', error: 'output cut off at max_tokens' };
        if (r.text === null) return { kind: 'failed', error: 'response has no text block' };
        const parsed = parseResult(r.text, slugs, entry.candidates[r.customId] ?? []);
        if (!parsed.ok) return { kind: 'failed', error: parsed.error };
        return {
          kind: 'ok',
          result: parsed.result,
          model: entry.model,
          promptVersion: run.params.promptVersion,
        };
      }
    }
  }
}

export function openBatchCount(runs: readonly RunState[]): number {
  return runs.reduce((n, r) => n + r.params.batches.filter((b) => b.state !== 'applied').length, 0);
}
