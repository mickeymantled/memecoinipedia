/**
 * The stage contract.
 *
 * A stage is one step of the per-coin pipeline. The pipeline runs a coin
 * through its stages in order:
 *
 *   discovered -> metadata -> candles -> metrics
 *
 * `discovered` and `metadata` are built in part 1 of A5. `candles` and
 * `metrics` are registered by part 3, which wraps part 2's functions to fit
 * this contract; until they are registered the pipeline stops after
 * `metadata`. (`classified` and `embedded` belong to /pipeline and are not
 * part of this worker.)
 *
 * What a stage is:
 *
 *   interface Stage {
 *     name: StageName;          // one of STAGE_ORDER
 *     version: number;          // bump it when the code's output changes; done coins are run again
 *     run(ctx, coin): Promise<StageResult>;
 *   }
 *
 *   ctx  = { db, now(), log, runId }   // the database handle, a clock, a logger, the ingest_runs id
 *   coin = one row of `coins` without `metadata_raw`
 *
 * What a stage returns:
 *
 *   { status: 'done' }                               the work is complete
 *   { status: 'skipped', reason }                    nothing to do for this coin, and that is final
 *   { status: 'failed', reason, retry }              it did not work; `retry` says whether trying
 *                                                    again could help (a timeout: yes; a budget stop
 *                                                    or a bad input: no)
 *
 * Rules a stage must follow:
 *
 * - Idempotent. The worker may call `run` again for the same coin after a
 *   crash, a timeout or a retry. Write results with upserts and replace, never
 *   append.
 * - Write the coin's data first, return afterwards. The worker records the
 *   stage as done only after `run` returns, so a crash in between just means
 *   one more run.
 * - Expected bad outcomes are results, not exceptions. A thrown error is
 *   treated as `failed` with `retry: true` and the error message as the reason.
 * - `reason` is `<code>: <detail>`. The text before the first colon groups
 *   failures in the run summary, so keep it a short stable code.
 * - Do not touch the stage row yourself. Claiming, finishing, retrying and the
 *   timeout all belong to the worker.
 * - Never put a key, or a URL that carries one, in `reason` or in a log line.
 *
 * Statuses: `done` and `skipped` are final and both let the coin move on to
 * the next stage. A `failed` coin does not move on until a retry succeeds.
 */
import type { Kysely, Selectable } from 'kysely';
import type { CoinsTable, Database, StageName } from '@memecoinipedia/db';
import type { Logger } from './log.js';

/** The pipeline order. Stages are registered in this order, with no gaps. */
export const STAGE_ORDER = ['discovered', 'metadata', 'candles', 'metrics'] as const;
export type PipelineStageName = (typeof STAGE_ORDER)[number];

export interface StageContext {
  db: Kysely<Database>;
  now: () => Date;
  log: Logger;
  /** `ingest_runs.id` of the run this work belongs to. */
  runId: number;
}

/** A coin as a stage sees it: every column except the raw metadata JSON. */
export type StageCoin = Omit<Selectable<CoinsTable>, 'metadata_raw'>;

export type StageResult =
  | { status: 'done' }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string; retry: boolean };

export interface Stage {
  name: PipelineStageName;
  version: number;
  run(ctx: StageContext, coin: StageCoin): Promise<StageResult>;
}

export const done = (): StageResult => ({ status: 'done' });
export const skipped = (reason: string): StageResult => ({ status: 'skipped', reason });
export const failed = (reason: string, retry: boolean): StageResult => ({
  status: 'failed',
  reason,
  retry,
});

export const isPipelineStage = (name: StageName): name is PipelineStageName =>
  (STAGE_ORDER as readonly string[]).includes(name);

/** Stages in the order they were registered. Registration must follow `STAGE_ORDER` without gaps. */
export class StageRegistry {
  private readonly stages: Stage[] = [];

  register(stage: Stage): this {
    const expected = STAGE_ORDER[this.stages.length];
    if (stage.name !== expected) {
      throw new Error(
        `Stage "${stage.name}" registered out of order: expected "${expected ?? '(none left)'}"`,
      );
    }
    if (!Number.isInteger(stage.version) || stage.version < 1) {
      throw new RangeError(`Stage "${stage.name}" version must be a positive integer`);
    }
    this.stages.push(stage);
    return this;
  }

  list(): readonly Stage[] {
    return this.stages;
  }

  get(name: StageName): Stage | undefined {
    return this.stages.find((s) => s.name === name);
  }

  /** The stage after `name`, or undefined when `name` is the last one registered. */
  next(name: StageName): Stage | undefined {
    const i = this.stages.findIndex((s) => s.name === name);
    return i < 0 ? undefined : this.stages[i + 1];
  }

  previous(name: StageName): Stage | undefined {
    const i = this.stages.findIndex((s) => s.name === name);
    return i <= 0 ? undefined : this.stages[i - 1];
  }
}
