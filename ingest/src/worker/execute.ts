/**
 * Runs one stage for one coin: claim it, call the stage, record the result.
 * This is everything a queue job does, kept free of the queue so it can be
 * tested and reused by other drivers.
 */
import { claimStage, databaseShape, finishStage, type StageName } from '@memecoinipedia/db';
import type { Kysely } from 'kysely';
import type { Database } from '@memecoinipedia/db';
import { BudgetExceededError } from '../sources/budget.js';
import type { Logger } from './log.js';
import type { Stage, StageCoin, StageRegistry, StageResult } from './stage.js';

export type ExecuteOutcome =
  | { kind: 'done' | 'skipped'; coinId: number; stage: StageName }
  /** Already done or skipped at this version: nothing was run. */
  | { kind: 'final'; coinId: number; stage: StageName }
  /** Somebody else holds it and has not timed out. Try again later. */
  | { kind: 'busy'; coinId: number; stage: StageName }
  /** Failed, and trying again may help. The stage row is `failed`. */
  | { kind: 'retry'; coinId: number; stage: StageName; reason: string }
  /** Failed for good: not retryable, or out of attempts. The stage row is `failed`. */
  | { kind: 'failed'; coinId: number; stage: StageName; reason: string }
  /** The claim was taken over while this ran; the result was thrown away. */
  | { kind: 'lost'; coinId: number; stage: StageName }
  | { kind: 'no_coin'; coinId: number; stage: StageName };

export interface ExecuteOptions {
  db: Kysely<Database>;
  registry: StageRegistry;
  now: () => Date;
  log: Logger;
  runId: number;
  /** A `running` stage older than this belongs to a dead worker and may be taken over. */
  staleAfterMs: number;
  /** Claims a stage may use up before a retryable failure becomes final. */
  maxAttempts: number;
}

const COIN_COLUMNS = (Object.keys(databaseShape.coins) as Array<keyof typeof databaseShape.coins>)
  .filter((c) => c !== 'metadata_raw')
  .map((c) => `coins.${c}` as const);

async function loadCoin(db: Kysely<Database>, coinId: number): Promise<StageCoin | undefined> {
  return (await db
    .selectFrom('coins')
    .select(COIN_COLUMNS)
    .where('id', '=', coinId)
    .executeTakeFirst()) as StageCoin | undefined;
}

const errorText = (err: unknown): string =>
  err instanceof Error ? `${err.name}: ${err.message}` : String(err);

async function callStage(
  stage: Stage,
  opts: ExecuteOptions,
  coin: StageCoin,
): Promise<StageResult> {
  try {
    return await stage.run({ db: opts.db, now: opts.now, log: opts.log, runId: opts.runId }, coin);
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      return { status: 'failed', reason: `budget_exceeded: ${err.message}`, retry: false };
    }
    return { status: 'failed', reason: `error: ${errorText(err)}`, retry: true };
  }
}

export async function executeStage(
  opts: ExecuteOptions,
  stageName: StageName,
  coinId: number,
): Promise<ExecuteOutcome> {
  const stage = opts.registry.get(stageName);
  if (!stage) throw new Error(`Stage "${stageName}" is not registered`);
  const base = { coinId, stage: stageName };

  const claim = await claimStage(opts.db, {
    coinId,
    stage: stageName,
    version: stage.version,
    runId: opts.runId,
    now: opts.now(),
    staleAfterMs: opts.staleAfterMs,
  });
  if (claim.status === 'no_coin') return { kind: 'no_coin', ...base };
  if (claim.status === 'final') return { kind: 'final', ...base };
  if (claim.status === 'busy') return { kind: 'busy', ...base };

  const coin = await loadCoin(opts.db, coinId);
  const result: StageResult = coin
    ? await callStage(stage, opts, coin)
    : { status: 'failed', reason: 'no_coin: the coin row disappeared', retry: false };

  const outcome =
    result.status === 'done'
      ? ({ status: 'done' } as const)
      : result.status === 'skipped'
        ? ({ status: 'skipped', reason: result.reason } as const)
        : ({ status: 'failed', error: result.reason } as const);
  const recorded = await finishStage(opts.db, {
    coinId,
    stage: stageName,
    attempt: claim.attempt,
    outcome,
    now: opts.now(),
  });
  if (!recorded) {
    opts.log.warn('stage result discarded: the claim was taken over', { coinId, stage: stageName });
    return { kind: 'lost', ...base };
  }

  if (result.status === 'done') return { kind: 'done', ...base };
  if (result.status === 'skipped') return { kind: 'skipped', ...base };
  if (result.retry && claim.attempt < opts.maxAttempts) {
    return { kind: 'retry', ...base, reason: result.reason };
  }
  return { kind: 'failed', ...base, reason: result.reason };
}
