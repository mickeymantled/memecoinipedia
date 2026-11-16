import { readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { emptyActual } from './batch.js';
import type { CoinInput } from './input.js';
import type { Narrative } from './schema.js';
import {
  runParamsSchema,
  type ApplyOutcome,
  type ClassifyStore,
  type FirstPassOptions,
  type Pass,
  type RunActual,
  type RunParams,
  type RunState,
  type SecondPassOptions,
  type WorkItem,
} from './store.js';

/**
 * File mode (`--mints FILE --out results.jsonl --no-db`): the coins come from the input file,
 * state lives in `<out>.state.json`, and results go to `<out>`. No database is opened, so
 * `coins`, `coin_stages` and `ingest_runs` are never touched.
 *
 * `<out>` holds one JSON line per coin: the final result (second pass replaces the first), or
 * `{ mint, error }` for a coin whose result failed validation.
 */

export interface FileCoin {
  mint: string;
  coin: CoinInput;
  candidates: string[];
}

const stateSchema = z.object({
  runs: z.array(
    z.object({
      id: z.number(),
      status: z.enum(['planned', 'running', 'done', 'failed', 'stopped']),
      params: runParamsSchema,
      estimate: z.unknown(),
      actual: z.unknown(),
    }),
  ),
  coins: z.record(
    z.string(),
    z.object({
      status: z.enum(['pending', 'running', 'done', 'failed']),
      attempts: z.number(),
      result: z
        .object({
          model: z.string(),
          promptVersion: z.string(),
          classifiedAt: z.string(),
          data: z.record(z.string(), z.unknown()),
        })
        .nullable(),
      error: z.string().nullable(),
    }),
  ),
});
type State = z.infer<typeof stateSchema>;

/** custom_id rule from the batch docs: 1 to 64 characters of letters, digits, hyphen, underscore. */
export const CUSTOM_ID = /^[a-zA-Z0-9_-]{1,64}$/;

export class FileStore implements ClassifyStore {
  private state: State = { runs: [], coins: {} };
  private dirty = 0;
  /** True once any state was written; a dry run never sets it, so it leaves no files. */
  private wrote = false;

  private constructor(
    private readonly stateFile: string,
    private readonly outFile: string,
    private readonly coinList: readonly FileCoin[],
  ) {}

  /** Reads `<out>.state.json` if it exists. Synchronous: it runs once, before any work. */
  static open(outFile: string, coins: readonly FileCoin[]): FileStore {
    for (const c of coins) {
      if (!CUSTOM_ID.test(c.mint)) {
        throw new Error(
          `"${c.mint}" cannot be used as a batch custom_id (letters, digits, - and _ only, 64 max)`,
        );
      }
    }
    const store = new FileStore(`${outFile}.state.json`, outFile, coins);
    try {
      store.state = stateSchema.parse(JSON.parse(readFileSync(store.stateFile, 'utf8')));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    for (const c of coins) {
      store.state.coins[c.mint] ??= { status: 'pending', attempts: 0, result: null, error: null };
    }
    return store;
  }

  narratives(): Promise<Narrative[] | null> {
    return Promise.resolve(null);
  }

  private async persist(): Promise<void> {
    await writeFile(`${this.stateFile}.tmp`, JSON.stringify(this.state));
    await rename(`${this.stateFile}.tmp`, this.stateFile);
    const lines: string[] = [];
    for (const c of this.coinList) {
      const s = this.state.coins[c.mint]!;
      if (s.result) {
        lines.push(
          JSON.stringify({
            mint: c.mint,
            model: s.result.model,
            prompt_version: s.result.promptVersion,
            classified_at: s.result.classifiedAt,
            ...s.result.data,
          }),
        );
      } else if (s.status === 'failed') {
        lines.push(JSON.stringify({ mint: c.mint, error: s.error }));
      }
    }
    await writeFile(`${this.outFile}.tmp`, lines.map((l) => `${l}\n`).join(''));
    await rename(`${this.outFile}.tmp`, this.outFile);
    this.dirty = 0;
    this.wrote = true;
  }

  async openRuns(): Promise<RunState[]> {
    return this.state.runs
      .filter((r) => r.status === 'running')
      .map((r) => ({
        id: r.id,
        status: r.status,
        params: r.params,
        estimate: r.estimate,
        actual: { ...emptyActual(), ...((r.actual ?? {}) as Partial<RunActual>) },
      }));
  }

  async createRun(params: RunParams, estimate: unknown): Promise<RunState> {
    const id = this.state.runs.reduce((m, r) => Math.max(m, r.id), 0) + 1;
    const run: RunState = { id, status: 'running', params, estimate, actual: emptyActual() };
    this.state.runs.push(run);
    await this.persist();
    return run;
  }

  async saveRun(run: RunState): Promise<void> {
    const i = this.state.runs.findIndex((r) => r.id === run.id);
    // Store a copy: the runner keeps mutating its own object.
    const copy = JSON.parse(JSON.stringify(run)) as State['runs'][number];
    if (i >= 0) this.state.runs[i] = copy;
    else this.state.runs.push(copy);
    await this.persist();
  }

  private toItem(c: FileCoin): WorkItem {
    return { key: c.mint, coin: c.coin, candidates: c.candidates };
  }

  async selectFirstPass(o: FirstPassOptions): Promise<WorkItem[]> {
    const out: WorkItem[] = [];
    for (const c of this.coinList) {
      const s = this.state.coins[c.mint]!;
      if (s.status === 'running') continue;
      const eligible =
        o.force ||
        s.status === 'pending' ||
        (s.status === 'failed' && s.attempts < o.maxAttempts) ||
        (s.status === 'done' && s.result?.promptVersion !== o.promptVersion);
      if (!eligible) continue;
      out.push(this.toItem(c));
      if (o.limit !== undefined && out.length >= o.limit) break;
    }
    return out;
  }

  async selectSecondPass(o: SecondPassOptions): Promise<WorkItem[]> {
    const out: WorkItem[] = [];
    for (const c of this.coinList) {
      const s = this.state.coins[c.mint]!;
      const conf = s.result?.data['confidence'];
      if (
        s.status === 'done' &&
        s.result?.model === o.firstModel &&
        s.result.promptVersion === o.promptVersion &&
        typeof conf === 'number' &&
        conf < o.threshold - 1e-9
      ) {
        out.push(this.toItem(c));
        if (o.limit !== undefined && out.length >= o.limit) break;
      }
    }
    return out;
  }

  async claim(_run: RunState, _pass: Pass, keys: string[]): Promise<void> {
    for (const k of keys) this.state.coins[k]!.status = 'running';
    await this.persist();
  }

  async release(_run: RunState, _pass: Pass, keys: string[]): Promise<void> {
    for (const k of keys) {
      const s = this.state.coins[k];
      if (s?.status === 'running') s.status = s.result ? 'done' : 'pending';
    }
    await this.persist();
  }

  async apply(
    _run: RunState,
    pass: Pass,
    key: string,
    outcome: ApplyOutcome,
  ): Promise<'applied' | 'skipped'> {
    const s = this.state.coins[key];
    if (!s || s.status !== 'running') return 'skipped';
    s.attempts += 1;
    if (outcome.kind === 'ok') {
      s.status = 'done';
      s.error = null;
      s.result = {
        model: outcome.model,
        promptVersion: outcome.promptVersion,
        classifiedAt: new Date().toISOString(),
        data: { ...outcome.result },
      };
    } else if (pass === 'second') {
      s.status = 'done';
      s.error = `second pass failed: ${outcome.error}`;
    } else {
      s.status = 'failed';
      s.error = outcome.error;
    }
    if (++this.dirty >= 100) await this.persist();
    return 'applied';
  }

  async close(): Promise<void> {
    if (this.wrote || this.dirty > 0) await this.persist();
  }
}

/** Reads a mints file: one bare mint or one JSON object per line. Blank lines and #-lines are skipped. */
export function parseMintsFile(text: string): Array<string | Record<string, unknown>> {
  const out: Array<string | Record<string, unknown>> = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('{')) out.push(JSON.parse(line) as Record<string, unknown>);
    else out.push(line);
  }
  return out;
}

const fileRecordSchema = z.object({
  mint: z.string(),
  chain: z.string().default('solana'),
  name: z.string().nullable().default(null),
  ticker: z.string().nullable().default(null),
  description: z.string().nullable().default(null),
  socials: z.record(z.string(), z.unknown()).default({}),
  launched_at: z.string().nullable().default(null),
  graduated_at: z.string().nullable().default(null),
  ath_market_cap_usd: z.number().nullable().default(null),
  ath_at: z.string().nullable().default(null),
  seconds_to_ath: z.number().nullable().default(null),
  status: z.string().default('unknown'),
  parent_candidates: z
    .array(
      z.object({
        address: z.string(),
        name: z.string().nullish(),
        ticker: z.string().nullish(),
        launched_at: z.string().nullish(),
        ath_market_cap_usd: z.number().nullish(),
      }),
    )
    .optional(),
  research: z
    .object({
      origin: z.string().optional(),
      origin_date: z.string().optional(),
      trigger_event: z.string().optional(),
      key_accounts: z.array(z.string()).optional(),
      notes: z.string().optional(),
      confidence: z.number().optional(),
    })
    .optional(),
});

/** A JSON line of a mints file as a coin. The line carries the coin's data; no database is read. */
export function fileRecordToCoin(rec: Record<string, unknown>): FileCoin {
  const r = fileRecordSchema.parse(rec);
  const coin: CoinInput = {
    chain: r.chain,
    address: r.mint,
    name: r.name,
    ticker: r.ticker,
    description: r.description,
    socials: r.socials,
    launched_at: r.launched_at,
    graduated_at: r.graduated_at,
    ath_market_cap_usd: r.ath_market_cap_usd,
    ath_at: r.ath_at,
    seconds_to_ath: r.seconds_to_ath,
    status: r.status,
  };
  if (r.parent_candidates) coin.parent_candidates = r.parent_candidates;
  if (r.research) coin.research = r.research;
  return {
    mint: r.mint,
    coin,
    candidates: (r.parent_candidates ?? []).map((c) => c.address),
  };
}
