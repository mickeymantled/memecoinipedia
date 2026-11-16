import { sql, type Kysely } from 'kysely';
import type { Database } from '@memecoinipedia/db';
import { COIN_INPUT_COLUMNS, coinRowToInput, type CoinInput, type CoinRow } from './input.js';
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
import { emptyActual } from './batch.js';
import type { FileCoin } from './file-store.js';

/**
 * Database-backed state. One `ingest_runs` row (kind 'classify') per run holds the batch
 * entries in `params`, the estimate, and the summed API usage in `actual`. A coin in flight has
 * its `coin_stages` row for stage 'classified' at status 'running' with this run's id.
 *
 * Reads and writes only `coins`, `coin_stages`, `ingest_runs` and `narratives`.
 */

export const RUN_KIND = 'classify';
const STAGE = 'classified';

/** Optional extras per coin (task B5's parent candidates, Grok research). Keyed by coin id. */
export type ExtrasProvider = (
  rows: ReadonlyArray<{ id: number; chain: string; address: string }>,
) => Promise<Map<number, Pick<CoinInput, 'parent_candidates' | 'research'>>>;

export class DbStore implements ClassifyStore {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly extras?: ExtrasProvider,
  ) {}

  async narratives(): Promise<Narrative[]> {
    return this.db
      .selectFrom('narratives')
      .select(['slug', 'label'])
      .orderBy('sort_order')
      .execute();
  }

  async openRuns(): Promise<RunState[]> {
    const rows = await this.db
      .selectFrom('ingest_runs')
      .selectAll()
      .where('kind', '=', RUN_KIND)
      .where('status', '=', 'running')
      .orderBy('id')
      .execute();
    return rows.map((r) => ({
      id: r.id,
      status: r.status,
      params: runParamsSchema.parse(r.params),
      estimate: r.estimate,
      actual: { ...emptyActual(), ...((r.actual ?? {}) as Partial<RunActual>) },
    }));
  }

  async createRun(params: RunParams, estimate: unknown): Promise<RunState> {
    const actual = emptyActual();
    const row = await this.db
      .insertInto('ingest_runs')
      .values({
        kind: RUN_KIND,
        status: 'running',
        params: JSON.stringify(params),
        estimate: estimate === null ? null : JSON.stringify(estimate),
        actual: JSON.stringify(actual),
        started_at: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { id: row.id, status: 'running', params, estimate, actual };
  }

  async saveRun(run: RunState): Promise<void> {
    await this.db
      .updateTable('ingest_runs')
      .set({
        status: run.status,
        params: JSON.stringify(run.params),
        estimate: run.estimate === null ? null : JSON.stringify(run.estimate),
        actual: JSON.stringify(run.actual),
        finished_at: run.status === 'running' ? null : new Date(),
      })
      .where('id', '=', run.id)
      .execute();
  }

  private async toItems(rows: Array<CoinRow & { id: number }>): Promise<WorkItem[]> {
    const extras = this.extras ? await this.extras(rows) : new Map();
    return rows.map((r) => {
      const x = extras.get(r.id) ?? {};
      const coin = coinRowToInput(r, x);
      return {
        key: String(r.id),
        coin,
        candidates: (coin.parent_candidates ?? []).map((c) => c.address),
      };
    });
  }

  async selectFirstPass(o: FirstPassOptions): Promise<WorkItem[]> {
    const cols = COIN_INPUT_COLUMNS.map((c) => `c.${c}` as const);
    let q = this.db
      .selectFrom('coins as c')
      .leftJoin('coin_stages as s', (j) =>
        j.onRef('s.coin_id', '=', 'c.id').on('s.stage', '=', STAGE),
      )
      .select(['c.id', ...cols])
      .where(sql<boolean>`(s.status is null or s.status <> 'running')`)
      .where(
        o.force
          ? sql<boolean>`true`
          : sql<boolean>`(
              s.status is null
              or s.status in ('pending', 'skipped')
              or (s.status = 'failed' and s.attempts < ${o.maxAttempts})
              or (s.status = 'done' and c.classifier_prompt_version is distinct from ${o.promptVersion})
            )`,
      )
      .orderBy('c.id');
    if (o.chain) q = q.where('c.chain', '=', o.chain);
    if (o.minAthUsd !== undefined) q = q.where('c.ath_market_cap_usd', '>=', o.minAthUsd);
    if (o.limit !== undefined) q = q.limit(o.limit);
    return this.toItems(await q.execute());
  }

  async selectSecondPass(o: SecondPassOptions): Promise<WorkItem[]> {
    const cols = COIN_INPUT_COLUMNS.map((c) => `c.${c}` as const);
    let q = this.db
      .selectFrom('coins as c')
      .innerJoin('coin_stages as s', (j) =>
        j.onRef('s.coin_id', '=', 'c.id').on('s.stage', '=', STAGE),
      )
      .select(['c.id', ...cols])
      .where('s.status', '=', 'done')
      .where('c.classifier_model', '=', o.firstModel)
      .where('c.classifier_prompt_version', '=', o.promptVersion)
      // narrative_confidence is a 4-byte real: 0.7 reads back as 0.699999988 in float8, which a
      // plain `< 0.7` would treat as under the threshold. The cast to numeric restores 0.7.
      .where(sql<boolean>`c.narrative_confidence::numeric < ${o.threshold}`)
      .orderBy('c.id');
    if (o.limit !== undefined) q = q.limit(o.limit);
    return this.toItems(await q.execute());
  }

  async claim(run: RunState, _pass: Pass, keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    const ids = keys.map(Number);
    await this.db.transaction().execute(async (trx) => {
      for (let i = 0; i < ids.length; i += 1000) {
        const part = ids.slice(i, i + 1000);
        await trx
          .insertInto('coin_stages')
          .values(
            part.map((id) => ({
              coin_id: id,
              stage: STAGE as 'classified',
              status: 'running' as const,
              run_id: run.id,
              started_at: new Date(),
            })),
          )
          .onConflict((oc) =>
            oc.columns(['coin_id', 'stage']).doUpdateSet({
              status: 'running',
              run_id: run.id,
              started_at: new Date(),
              updated_at: new Date(),
            }),
          )
          .execute();
      }
    });
  }

  async release(run: RunState, _pass: Pass, keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    const ids = keys.map(Number);
    // Back to 'done' when the coin already holds a classification, else 'pending'.
    await this.db
      .updateTable('coin_stages as s')
      .set({
        status: sql<'done' | 'pending'>`(
          select case when c.classifier_model is not null then 'done' else 'pending' end
          from coins c where c.id = s.coin_id
        )`,
        updated_at: new Date(),
      })
      .where('s.stage', '=', STAGE)
      .where('s.status', '=', 'running')
      .where('s.run_id', '=', run.id)
      .where('s.coin_id', 'in', ids)
      .execute();
  }

  async apply(
    run: RunState,
    pass: Pass,
    key: string,
    outcome: ApplyOutcome,
  ): Promise<'applied' | 'skipped'> {
    const id = Number(key);
    return this.db.transaction().execute(async (trx) => {
      const stage = await trx
        .selectFrom('coin_stages')
        .select('attempts')
        .where('coin_id', '=', id)
        .where('stage', '=', STAGE)
        .where('status', '=', 'running')
        .where('run_id', '=', run.id)
        .forUpdate()
        .executeTakeFirst();
      if (!stage) return 'skipped';

      if (outcome.kind === 'ok') {
        const r = outcome.result;
        await trx
          .updateTable('coins')
          .set({
            primary_narrative: r.primary_narrative,
            secondary_narratives: r.secondary_narratives,
            narrative_confidence: r.confidence,
            narrative_reason: r.reason,
            parent_address: r.parent_address,
            parent_coin_id:
              r.parent_address === null
                ? null
                : sql<number | null>`(
                    select p.id from coins p
                    where p.chain = coins.chain and p.address = ${r.parent_address}
                  )`,
            sensitive: r.sensitive,
            summary: r.summary,
            classifier_model: outcome.model,
            classifier_prompt_version: outcome.promptVersion,
            classified_at: new Date(),
            updated_at: new Date(),
          })
          .where('id', '=', id)
          .execute();
        await trx
          .updateTable('coin_stages')
          .set({
            status: 'done',
            attempts: stage.attempts + 1,
            last_error: null,
            finished_at: new Date(),
            updated_at: new Date(),
          })
          .where('coin_id', '=', id)
          .where('stage', '=', STAGE)
          .execute();
        return 'applied';
      }

      // A failed second pass keeps the first-pass result, so the stage stays 'done'.
      await trx
        .updateTable('coin_stages')
        .set({
          status: pass === 'second' ? 'done' : 'failed',
          attempts: stage.attempts + 1,
          last_error: pass === 'second' ? `second pass failed: ${outcome.error}` : outcome.error,
          finished_at: new Date(),
          updated_at: new Date(),
        })
        .where('coin_id', '=', id)
        .where('stage', '=', STAGE)
        .execute();
      return 'applied';
    });
  }

  async close(): Promise<void> {
    await this.db.destroy();
  }
}

/**
 * File mode with bare mints and a database: reads the coins (SELECT only) so the results can be
 * written to a file. Mints with no coin row are returned in `missing`.
 */
export async function loadCoinsByMint(
  db: Kysely<Database>,
  mints: readonly string[],
  chain = 'solana',
): Promise<{ coins: FileCoin[]; missing: string[] }> {
  const byMint = new Map<string, FileCoin>();
  for (let i = 0; i < mints.length; i += 1000) {
    const rows = await db
      .selectFrom('coins')
      .select(COIN_INPUT_COLUMNS)
      .where('chain', '=', chain)
      .where('address', 'in', mints.slice(i, i + 1000))
      .execute();
    for (const r of rows)
      byMint.set(r.address, { mint: r.address, coin: coinRowToInput(r), candidates: [] });
  }
  return {
    coins: mints.flatMap((m) => {
      const c = byMint.get(m);
      return c ? [c] : [];
    }),
    missing: mints.filter((m) => !byMint.has(m)),
  };
}
