/**
 * The stage contract.
 *
 * A stage is one step of the per-coin pipeline. Each stage states what it
 * requires (`STAGE_REQUIRES`); there is no single line the coins walk along:
 *
 *   discovered -> metadata -> metadata_file
 *   discovered -> candles -> metrics
 *
 * A coin whose `metadata` failed still gets `candles` and `metrics`. A stage
 * runs for a coin once the stage it requires is `done` or `skipped` for that
 * coin, and not before. (`classified` and `embedded` belong to /pipeline and
 * are not part of this worker.)
 *
 * What a stage is:
 *
 *   interface Stage {
 *     name: StageName;          // one of STAGE_ORDER
 *     version: number;          // bump it when the code's output changes; done coins are run again
 *     run(ctx, coin): Promise<StageResult>;
 *     timeoutSeconds?: number;  // a run longer than this is presumed dead; default 120
 *     admit?(): boolean;        // false: the stage takes no new coin right now (a run-wide stop)
 *     requires?: PipelineStageName | null;  // overrides STAGE_REQUIRES for this registry
 *     onlyIf?: { minAthMarketCapUsd: number };  // the stage runs only for coins with this ATH or more
 *   }
 *
 *   ctx  = { db, now(), log, runId }   // the database handle, a clock, a logger, the ingest_runs id
 *   coin = one row of `coins` without `metadata_raw`
 *
 * What a stage returns:
 *
 *   { status: 'done', detail? }                      the work is complete; `detail` is a small JSON
 *                                                    object (under 1 KB) kept on the stage row
 *   { status: 'skipped', reason }                    nothing to do for this coin, and that is final
 *   { status: 'failed', reason, retry, refundAttempt? }
 *                                                    it did not work; `retry` says whether trying
 *                                                    again could help (a timeout: yes; a bad input:
 *                                                    no); `refundAttempt` gives the attempt back
 *                                                    when the cause was the run, not the coin
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
 * - Data issues belong to the stage that wrote them: write them with
 *   `replaceCoinIssues` and the kinds the stage owns, so a run of another stage
 *   never removes them.
 * - Never put a key, or a URL that carries one, in `reason`, `detail` or in a log line.
 *
 * Statuses: `done` and `skipped` are final and both let a dependent stage run.
 * A `failed` coin does not let its dependents run until a retry succeeds.
 */
import type { Kysely, Selectable } from 'kysely';
import type { CoinsTable, Database, StageName } from '@memecoinipedia/db';
import type { Logger } from './log.js';

/** The stages this worker runs, in the order they print. */
export const STAGE_ORDER = [
  'discovered',
  'metadata',
  'metadata_file',
  'candles',
  'metrics',
] as const;
export type PipelineStageName = (typeof STAGE_ORDER)[number];

/**
 * The stage each stage needs done (or skipped) for the same coin before it runs.
 * `metadata` and `candles` both need only `discovered`, so a coin whose metadata
 * failed still gets candles and metrics. `metrics` reads stored bars, so it needs `candles`.
 */
export const STAGE_REQUIRES: Readonly<Record<PipelineStageName, PipelineStageName | null>> = {
  discovered: null,
  metadata: 'discovered',
  metadata_file: 'metadata',
  candles: 'discovered',
  metrics: 'candles',
};

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
  | { status: 'done'; detail?: Record<string, unknown> }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string; retry: boolean; refundAttempt?: boolean };

export interface Stage {
  name: PipelineStageName;
  version: number;
  run(ctx: StageContext, coin: StageCoin): Promise<StageResult>;
  /** A run longer than this is presumed dead and may be taken over. Default 120 seconds. */
  timeoutSeconds?: number;
  /**
   * Asked before each coin is claimed. False holds the stage: no new coin is claimed, the job
   * ends quietly, and the coin stays as it was for a later run (a spend ceiling reached, say).
   */
  admit?(): boolean;
  /**
   * The stage this one needs done (or skipped) first, for coins in this registry. Absent: the
   * default in `STAGE_REQUIRES`. A backfill registers `metadata` with `requires: 'metrics'`.
   */
  requires?: PipelineStageName | null;
  /**
   * A rule on the coin: the stage runs only for coins whose ATH (from the metrics stage) is at or
   * above this. A coin outside the rule is not "waiting" for the stage anywhere: it is not queued,
   * not counted as to do, and a job that reaches it changes nothing. It is declarative, not a
   * function, so the queue, the counts and the status view can all apply the same rule in SQL.
   */
  onlyIf?: StageCoinRule;
}

export interface StageCoinRule {
  minAthMarketCapUsd: number;
}

/** A coin with this ATH or more is "listed" (the product indexes coins that reached $100,000). */
export const LISTED_ATH_USD = 100_000;

/** True when the coin satisfies the stage's rule (always true without one). */
export function coinQualifies(rule: StageCoinRule | undefined, ath: number | null): boolean {
  return rule === undefined || (ath !== null && ath >= rule.minAthMarketCapUsd);
}

export const done = (detail?: Record<string, unknown>): StageResult =>
  detail ? { status: 'done', detail } : { status: 'done' };
export const skipped = (reason: string): StageResult => ({ status: 'skipped', reason });
export const failed = (reason: string, retry: boolean, refundAttempt = false): StageResult =>
  refundAttempt
    ? { status: 'failed', reason, retry, refundAttempt }
    : { status: 'failed', reason, retry };

export const isPipelineStage = (name: StageName): name is PipelineStageName =>
  (STAGE_ORDER as readonly string[]).includes(name);

/** The stage `name` requires, or null (also for stages outside this worker). */
export const requirementOf = (name: StageName): PipelineStageName | null =>
  isPipelineStage(name) ? STAGE_REQUIRES[name] : null;

/**
 * The registered stages. A stage's requirement need not be registered here: it is checked
 * against the coin's stage rows, so `metrics` can run alone over coins whose candles are done.
 */
export class StageRegistry {
  private readonly stages: Stage[] = [];

  register(stage: Stage): this {
    if (this.get(stage.name)) throw new Error(`Stage "${stage.name}" is registered twice`);
    if (!Number.isInteger(stage.version) || stage.version < 1) {
      throw new RangeError(`Stage "${stage.name}" version must be a positive integer`);
    }
    if (stage.timeoutSeconds !== undefined && !(stage.timeoutSeconds > 0)) {
      throw new RangeError(`Stage "${stage.name}" timeoutSeconds must be positive`);
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

  /** The stage `name` requires in this registry: its own `requires`, else the default. */
  requirementOf(name: StageName): PipelineStageName | null {
    const stage = this.get(name);
    if (stage && stage.requires !== undefined) return stage.requires;
    return requirementOf(name);
  }

  /** Registered stages that require `name`. */
  dependents(name: StageName): Stage[] {
    return this.stages.filter((s) => this.requirementOf(s.name) === name);
  }
}
