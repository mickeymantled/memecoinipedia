import { z } from 'zod';
import type { CoinInput } from './input.js';
import type { UsageTotals } from './estimate.js';
import type { ClassifyResult, Narrative } from './schema.js';

/**
 * What the batch runner needs from storage. `DbStore` (db-store.ts) keeps state in
 * `coins`, `coin_stages` and `ingest_runs`; `FileStore` (file-store.ts) keeps it in a JSON
 * state file next to the output file, for `--no-db` runs.
 */

export type Pass = 'first' | 'second';

/** One coin to classify. `key` is the batch request's custom_id (the coin's database id in DB mode). */
export interface WorkItem {
  key: string;
  coin: CoinInput;
  /** Parent addresses given in the input. A result may name one of these or null. */
  candidates: string[];
}

export const batchEntrySchema = z.object({
  /** Null until the API has answered `create`; see the write-ahead note in batch.ts. */
  id: z.string().nullable(),
  pass: z.enum(['first', 'second']),
  model: z.string(),
  state: z.enum(['pending', 'submitted', 'applied']),
  keys: z.array(z.string()),
  /** Non-empty candidate lists only, by key. Empty until task B5 fills the slot. */
  candidates: z.record(z.string(), z.array(z.string())),
  /** Ceiling estimate (no cache hits) in USD, counted against --max-usd. */
  estimateUsd: z.number(),
  abandoned: z.boolean().optional(),
});
export type BatchEntry = z.infer<typeof batchEntrySchema>;

export const runParamsSchema = z.object({
  firstModel: z.string(),
  secondModel: z.string(),
  promptVersion: z.string(),
  force: z.boolean(),
  passes: z.enum(['first', 'second', 'both']),
  maxUsd: z.number(),
  batches: z.array(batchEntrySchema),
});
export type RunParams = z.infer<typeof runParamsSchema>;

/** Stored in `ingest_runs.actual`. Usage fields are the API's own names, summed over the run. */
export interface RunActual {
  usage: UsageTotals;
  /** Dollars computed from `usage` with the prices in pricing.ts and the batch discount. */
  usd: number;
  batches: number;
  requests: number;
  applied: number;
  failed: number;
  /** Results that were already applied (re-read after a restart), or whose coin was no longer in flight. */
  skipped: number;
  /** Requests that expired or were canceled and went back to pending. */
  released: number;
  /** Pending batch entries from a crash between the write-ahead save and the API answer. */
  abandonedBatches: number;
}

export type RunStatus = 'planned' | 'running' | 'done' | 'failed' | 'stopped';

export interface RunState {
  id: number;
  status: RunStatus;
  params: RunParams;
  estimate: unknown;
  actual: RunActual;
}

export type ApplyOutcome =
  | { kind: 'ok'; result: ClassifyResult; model: string; promptVersion: string }
  | { kind: 'failed'; error: string };

export interface SelectOptions {
  limit?: number | undefined;
  promptVersion: string;
}

export interface FirstPassOptions extends SelectOptions {
  force: boolean;
  maxAttempts: number;
  chain?: string | undefined;
  minAthUsd?: number | undefined;
}

export interface SecondPassOptions extends SelectOptions {
  firstModel: string;
  threshold: number;
}

export interface ClassifyStore {
  /** The narratives table, or null when the store has none (file mode uses the built-in list). */
  narratives(): Promise<Narrative[] | null>;
  /** Runs left in status 'running' by a process that was killed. */
  openRuns(): Promise<RunState[]>;
  createRun(params: RunParams, estimate: unknown): Promise<RunState>;
  /** Persists params, estimate, actual and status; sets finished_at for a finished status. */
  saveRun(run: RunState): Promise<void>;
  selectFirstPass(o: FirstPassOptions): Promise<WorkItem[]>;
  selectSecondPass(o: SecondPassOptions): Promise<WorkItem[]>;
  /** Marks the coins in flight for this run, so no other selection returns them. */
  claim(run: RunState, pass: Pass, keys: string[]): Promise<void>;
  /** Returns in-flight coins to the state they were in before, without counting an attempt. */
  release(run: RunState, pass: Pass, keys: string[]): Promise<void>;
  /**
   * Stores one outcome. Idempotent: only a coin that is still in flight for this run is
   * written; any other coin returns 'skipped' and is left alone.
   */
  apply(
    run: RunState,
    pass: Pass,
    key: string,
    outcome: ApplyOutcome,
  ): Promise<'applied' | 'skipped'>;
  close(): Promise<void>;
}
