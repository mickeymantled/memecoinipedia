/**
 * The queue worker: pg-boss on the same Postgres, one queue per stage, one job
 * per coin.
 *
 * Where the truth lives. `coin_stages` is the authority on what is done. The
 * queue only carries "please look at coin N, stage S". Every job goes through
 * `executeStage`, whose claim is one atomic UPDATE, so a duplicate job, a job
 * redelivered after a crash, or two workers can never run a finished stage
 * again or run one stage twice at the same time.
 *
 * Order. Each stage has a requirement (`STAGE_REQUIRES`): the stage that must be done
 * for the coin first. When a stage finishes a coin, the coin is queued for every active
 * stage that requires it; there is no single line of stages.
 *
 * Retries. A stage that fails with `retry: true` is marked `failed` and the
 * job throws, so pg-boss retries it after an exponentially growing delay. After
 * `maxAttempts` claims the failure is final: the stage stays `failed` with its
 * reason and the job completes. A retryable failure never moves the coin on.
 *
 * Crashes. A killed process leaves its stage `running` and its pg-boss job
 * `active`. The stage row is claimable again after `stageTimeoutSeconds`
 * (`enqueueNotDone` lists it and queues a fresh job), and pg-boss expires the
 * old job after the same time.
 */
import {
  listCoinsNotDone,
  type Database,
  type NotDoneCoin,
  type StageName,
} from '@memecoinipedia/db';
import { sql, type Kysely } from 'kysely';
import { PgBoss } from 'pg-boss';
import { executeStage, staleAfterMs, type ExecuteOptions } from './execute.js';
import type { Logger } from './log.js';
import { coinQualifies, type StageRegistry } from './stage.js';

export interface PipelineWorkerOptions {
  /** Postgres URL for pg-boss. It keeps its own tables in `schema`. */
  connectionString: string;
  db: Kysely<Database>;
  registry: StageRegistry;
  /** The stages to run, a subset of the registered ones. Default: all registered. */
  stages?: readonly StageName[];
  runId: number;
  log: Logger;
  /** Jobs running at once, per stage queue. Default 5. */
  concurrency?: number;
  /** Jobs running at once for particular stages; overrides `concurrency` for them. */
  stageConcurrency?: Partial<Record<StageName, number>>;
  /**
   * Jobs a worker takes from the queue at a time, per stage, and runs side by side. Default 1.
   *
   * Why it matters at volume: the queue library lets each worker fetch once per polling interval
   * (half a second at the least) unless its last fetch came back full, so a stage with one job
   * per fetch moves at most 2 jobs a second per worker. With a batch, a worker whose batch came
   * back full fetches again at once. The price is that a batch ends when its slowest job does, so
   * stages that wait on a provider keep their batches small (5).
   */
  stageBatchSize?: Partial<Record<StageName, number>>;
  /** Claims a stage may use before a retryable failure is final. Default 3 (`DEFAULT_MAX_ATTEMPTS`). */
  maxAttempts?: number;
  /** First retry delay in seconds; it doubles each time. Default 5. */
  retryDelaySeconds?: number;
  retryDelayMaxSeconds?: number;
  /**
   * A stage running longer than this is presumed dead. Overrides every stage's own
   * `timeoutSeconds` (tests use it); by default each stage uses its own, else 120.
   */
  stageTimeoutSeconds?: number;
  /** Connections in pg-boss's own pool. Default pg-boss's own (10). */
  queuePoolSize?: number;
  /** Called after jobs are queued, with the stage and the coin ids. */
  onEnqueued?: (stage: StageName, coinIds: readonly number[]) => void;
  pollingIntervalSeconds?: number;
  monitorIntervalSeconds?: number;
  schema?: string;
  now?: () => Date;
}

interface JobData {
  coinId: number;
}

export const DEFAULT_MAX_ATTEMPTS = 3;
export const queueName = (stage: StageName): string => `ingest.${stage}`;
const PAGE = 1000;

export class PipelineWorker {
  private readonly boss: PgBoss;
  private readonly opts: PipelineWorkerOptions;
  private readonly stages: StageName[];
  private readonly schema: string;
  private readonly now: () => Date;
  private readonly exec: ExecuteOptions;
  private running = 0;
  private started = false;

  constructor(opts: PipelineWorkerOptions) {
    this.opts = opts;
    this.schema = opts.schema ?? 'pgboss';
    this.now = opts.now ?? (() => new Date());
    const registered = opts.registry.list().map((s) => s.name);
    const wanted = opts.stages ?? registered;
    for (const s of wanted) {
      if (!registered.includes(s as never)) throw new Error(`Stage "${s}" is not registered`);
    }
    // Registration order, so "next" always means the next one in the pipeline.
    this.stages = registered.filter((s) => wanted.includes(s));
    this.exec = {
      db: opts.db,
      registry: opts.registry,
      now: this.now,
      log: opts.log,
      runId: opts.runId,
      ...(opts.stageTimeoutSeconds !== undefined
        ? { staleAfterMs: opts.stageTimeoutSeconds * 1000 }
        : {}),
      maxAttempts: opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    };
    this.boss = new PgBoss({
      connectionString: opts.connectionString,
      schema: this.schema,
      application_name: 'memecoinipedia-ingest',
      ...(opts.queuePoolSize !== undefined ? { max: opts.queuePoolSize } : {}),
      ...(opts.monitorIntervalSeconds !== undefined
        ? {
            monitorIntervalSeconds: opts.monitorIntervalSeconds,
            superviseIntervalSeconds: opts.monitorIntervalSeconds,
          }
        : {}),
    });
    this.boss.on('error', (err: Error) => opts.log.error(`queue error: ${err.message}`));
  }

  /** Stages this worker runs, in pipeline order. */
  get activeStages(): readonly StageName[] {
    return this.stages;
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.boss.start();
    const maxAttempts = this.opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    for (const stage of this.stages) {
      const timeout = this.timeoutSeconds(stage);
      await this.boss.createQueue(queueName(stage), {
        // One waiting job per coin; the claim makes extra copies harmless anyway.
        policy: 'short',
        // Slack beyond maxAttempts for jobs redelivered after a crash or found busy.
        retryLimit: maxAttempts + 5,
        retryDelay: this.opts.retryDelaySeconds ?? 5,
        retryBackoff: true,
        retryDelayMax: this.opts.retryDelayMaxSeconds ?? 300,
        expireInSeconds: timeout,
        deleteAfterSeconds: 3600,
      });
    }
    for (const stage of this.stages) {
      const slots = this.opts.stageConcurrency?.[stage] ?? this.opts.concurrency ?? 5;
      const batchSize = Math.max(1, Math.min(this.opts.stageBatchSize?.[stage] ?? 1, slots));
      if (batchSize === 1) {
        await this.boss.work<JobData>(
          queueName(stage),
          {
            localConcurrency: slots,
            batchSize: 1,
            pollingIntervalSeconds: this.opts.pollingIntervalSeconds ?? 0.5,
          },
          async (jobs) => {
            for (const job of jobs) await this.handle(stage, job.data.coinId);
          },
        );
        continue;
      }
      // A batch: the jobs run side by side, and each is settled on its own, so one coin that has
      // to be retried does not fail the others.
      const handler = async (jobs: Array<{ id: string; data: JobData }>) =>
        Promise.all(
          jobs.map(async (job) => {
            try {
              await this.handle(stage, job.data.coinId);
              return { id: job.id, status: 'completed' as const };
            } catch (err) {
              return {
                id: job.id,
                status: 'failed' as const,
                output: { message: err instanceof Error ? err.message : String(err) },
              };
            }
          }),
        );
      await this.boss.work<JobData>(
        queueName(stage),
        {
          localConcurrency: Math.ceil(slots / batchSize),
          batchSize,
          burstWhenBatchFull: true,
          perJobResults: true,
          pollingIntervalSeconds: this.opts.pollingIntervalSeconds ?? 0.5,
        },
        handler,
      );
    }
    this.started = true;
  }

  private timeoutSeconds(stage: StageName): number {
    return staleAfterMs(this.exec, this.opts.registry.get(stage)!) / 1000;
  }

  private async handle(stage: StageName, coinId: number): Promise<void> {
    this.running++;
    try {
      const out = await executeStage(this.exec, stage, coinId);
      switch (out.kind) {
        case 'done':
        case 'skipped':
        case 'final':
          await this.enqueueDependents(stage, coinId);
          return;
        case 'held':
          // The stage takes no new coin right now; the coin keeps its state for a later run.
          return;
        case 'busy':
          throw new Error(`stage ${stage} of coin ${coinId} is held by another worker`);
        case 'retry':
          this.opts.log.warn(`retrying later: ${out.reason}`, { coinId, stage });
          throw new Error(out.reason);
        case 'failed':
          this.opts.log.warn(`left failed: ${out.reason}`, { coinId, stage });
          return;
        case 'ineligible':
        case 'lost':
        case 'no_coin':
          return;
      }
    } finally {
      this.running--;
    }
  }

  /**
   * Queues the coin for each active stage that requires `stage`. A stage with a rule on the coin
   * (`onlyIf`) is queued only when the coin satisfies it: the coin's ATH is read once for all
   * such stages.
   */
  private async enqueueDependents(stage: StageName, coinId: number): Promise<void> {
    let ath: number | null | undefined;
    for (const next of this.stages) {
      if (this.opts.registry.requirementOf(next) !== stage) continue;
      const rule = this.opts.registry.get(next)?.onlyIf;
      if (rule) {
        if (ath === undefined) {
          const row = await this.opts.db
            .selectFrom('coins')
            .select('ath_market_cap_usd')
            .where('id', '=', coinId)
            .executeTakeFirst();
          ath = row?.ath_market_cap_usd ?? null;
        }
        if (!coinQualifies(rule, ath)) continue;
      }
      await this.enqueue(next, [coinId]);
    }
  }

  /** Queues coins for a stage. A coin already waiting in that queue is not queued twice. */
  async enqueueCoins(stage: StageName, coinIds: readonly number[]): Promise<void> {
    await this.enqueue(stage, coinIds);
  }

  private async enqueue(stage: StageName, coinIds: readonly number[]): Promise<void> {
    if (coinIds.length > 0) this.opts.onEnqueued?.(stage, coinIds);
    for (let i = 0; i < coinIds.length; i += PAGE) {
      await this.boss.insert(
        queueName(stage),
        coinIds
          .slice(i, i + PAGE)
          .map((coinId) => ({ data: { coinId } satisfies JobData, singletonKey: String(coinId) })),
      );
    }
  }

  /** Coins that still need `stage`, in the same terms the worker uses to claim them. */
  async coinsToDo(stage: StageName, addresses?: readonly string[]): Promise<NotDoneCoin[]> {
    const stageDef = this.opts.registry.get(stage);
    if (!stageDef) throw new Error(`Stage "${stage}" is not registered`);
    const requires = this.opts.registry.requirementOf(stage);
    const out: NotDoneCoin[] = [];
    let afterId = 0;
    for (;;) {
      const page = await listCoinsNotDone(this.opts.db, stage, {
        version: stageDef.version,
        ...(requires ? { requires } : {}),
        ...(addresses ? { addresses } : {}),
        ...(stageDef.onlyIf ? { minAthMarketCapUsd: stageDef.onlyIf.minAthMarketCapUsd } : {}),
        // A stage that used up its attempts is left failed.
        maxAttempts: this.exec.maxAttempts,
        // A fresh `running` row has a live worker on it.
        runningSince: new Date(this.now().getTime() - staleAfterMs(this.exec, stageDef)),
        afterId,
        limit: PAGE,
      });
      out.push(...page);
      if (page.length < PAGE) return out;
      afterId = page[page.length - 1]!.id;
    }
  }

  /**
   * Of these coins, the ones that still need `stage` and whose requirement is met, in the same
   * terms the worker uses to claim them. For feeding the queue a page of coins at a time.
   */
  async coinsToDoAmong(stage: StageName, ids: readonly number[]): Promise<NotDoneCoin[]> {
    const stageDef = this.opts.registry.get(stage);
    if (!stageDef) throw new Error(`Stage "${stage}" is not registered`);
    const requires = this.opts.registry.requirementOf(stage);
    return listCoinsNotDone(this.opts.db, stage, {
      version: stageDef.version,
      ...(requires ? { requires } : {}),
      ids,
      ...(stageDef.onlyIf ? { minAthMarketCapUsd: stageDef.onlyIf.minAthMarketCapUsd } : {}),
      maxAttempts: this.exec.maxAttempts,
      runningSince: new Date(this.now().getTime() - staleAfterMs(this.exec, stageDef)),
    });
  }

  /**
   * Removes jobs of this worker's queues that are waiting or in retry backoff (not running ones).
   * The stage rows are the truth about what is done; a backfill that is started again feeds the
   * queue afresh from them, so jobs left by an earlier run, for a different selection, do not run.
   */
  async clearQueued(): Promise<void> {
    for (const stage of this.stages) await this.boss.deleteQueuedJobs(queueName(stage));
  }

  /** Jobs of this worker's queues that are waiting, being retried or running. */
  async outstandingJobs(stage?: StageName): Promise<number> {
    const names = (stage ? [stage] : this.stages).map(queueName);
    if (names.length === 0) return 0;
    const res = await sql<{ n: string }>`
      select count(*)::text as n
      from ${sql.id(this.schema, 'job')}
      where name in (${sql.join(names)}) and state in ('created', 'retry', 'active')
    `.execute(this.opts.db);
    return Number(res.rows[0]?.n ?? 0);
  }

  /**
   * True when any active stage's queue holds a job that is waiting, retrying or running. An
   * existence check: it stops at the first row, so a queue of 100,000 jobs costs no more than one.
   */
  async hasOutstandingJobs(): Promise<boolean> {
    const names = this.stages.map(queueName);
    if (names.length === 0) return false;
    const res = await sql<{ found: boolean }>`
      select exists (
        select 1 from ${sql.id(this.schema, 'job')}
        where name in (${sql.join(names)}) and state in ('created', 'retry', 'active')
      ) as found
    `.execute(this.opts.db);
    return res.rows[0]?.found === true;
  }

  /** Jobs waiting or in retry (not running), per active stage. */
  async queuedByStage(): Promise<Partial<Record<StageName, number>>> {
    const out: Partial<Record<StageName, number>> = {};
    for (const stage of this.stages) {
      const res = await sql<{ n: string }>`
        select count(*)::text as n from ${sql.id(this.schema, 'job')}
        where name = ${queueName(stage)} and state in ('created', 'retry')
      `.execute(this.opts.db);
      out[stage] = Number(res.rows[0]?.n ?? 0);
    }
    return out;
  }

  /** Handlers running in this process. */
  get runningHere(): number {
    return this.running;
  }

  /**
   * Queues every coin that still needs a stage, for each active stage in
   * order. Returns how many jobs were offered per stage (a coin already waiting
   * in a queue is not queued twice).
   */
  async enqueueNotDone(addresses?: readonly string[]): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const stage of this.stages) {
      const coins = await this.coinsToDo(stage, addresses);
      counts[stage] = coins.length;
      await this.enqueue(
        stage,
        coins.map((c) => c.id),
      );
    }
    return counts;
  }

  /**
   * Waits until no handler is running here, no job of ours is waiting (created
   * or in retry backoff) in the queue, and no stage of ours is left `running`.
   *
   * A stage `running` while nothing here runs it belongs to a dead process (or
   * to another worker, which then finishes it). This waits for its timeout and
   * queues it again, so a run started after a kill still completes every coin.
   */
  async waitUntilIdle(
    opts: { pollMs?: number; signal?: AbortSignal; addresses?: readonly string[] } = {},
  ): Promise<void> {
    const pollMs = opts.pollMs ?? 250;
    let quiet = 0;
    while (!opts.signal?.aborted) {
      const waiting = await this.waitingJobs();
      let settled = this.running === 0 && waiting === 0;
      if (settled && (await this.stagesStillRunning(opts.addresses)) > 0) {
        settled = false;
        // Only stale ones are listed; a fresh `running` row is left to its owner.
        for (const stage of this.stages) {
          const stale = (await this.coinsToDo(stage, opts.addresses)).filter(
            (c) => c.status === 'running',
          );
          await this.enqueue(
            stage,
            stale.map((c) => c.id),
          );
        }
      }
      if (settled) {
        // Two quiet looks in a row: a handler may be between finishing and queueing the next stage.
        if (++quiet >= 2) return;
      } else {
        quiet = 0;
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  private async stagesStillRunning(addresses?: readonly string[]): Promise<number> {
    let q = this.opts.db
      .selectFrom('coin_stages as s')
      .innerJoin('coins', 'coins.id', 's.coin_id')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('s.stage', 'in', [...this.stages])
      .where('s.status', '=', 'running');
    if (addresses) q = q.where('coins.address', 'in', [...addresses]);
    return Number((await q.executeTakeFirstOrThrow()).n);
  }

  /** Jobs of this worker's queues in `created` or `retry` state. Reads pg-boss's job table. */
  async waitingJobs(): Promise<number> {
    const names = this.stages.map(queueName);
    if (names.length === 0) return 0;
    const res = await sql<{ n: string }>`
      select count(*)::text as n
      from ${sql.id(this.schema, 'job')}
      where name in (${sql.join(names)}) and state in ('created', 'retry')
    `.execute(this.opts.db);
    return Number(res.rows[0]?.n ?? 0);
  }

  /** Stops taking jobs and waits for running ones (graceful), then closes the connections. */
  async stop(opts: { graceful?: boolean; timeoutMs?: number } = {}): Promise<void> {
    if (!this.started) return;
    this.started = false;
    await this.boss.stop({
      graceful: opts.graceful ?? true,
      timeout: opts.timeoutMs ?? 30_000,
      close: true,
    });
  }
}
