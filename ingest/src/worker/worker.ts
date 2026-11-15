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
import { executeStage, type ExecuteOptions } from './execute.js';
import type { Logger } from './log.js';
import type { StageRegistry } from './stage.js';

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
  /** Claims a stage may use before a retryable failure is final. Default 3 (`DEFAULT_MAX_ATTEMPTS`). */
  maxAttempts?: number;
  /** First retry delay in seconds; it doubles each time. Default 5. */
  retryDelaySeconds?: number;
  retryDelayMaxSeconds?: number;
  /** A stage running longer than this is presumed dead. Default 120. */
  stageTimeoutSeconds?: number;
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
      staleAfterMs: (opts.stageTimeoutSeconds ?? 120) * 1000,
      maxAttempts: opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    };
    this.boss = new PgBoss({
      connectionString: opts.connectionString,
      schema: this.schema,
      application_name: 'memecoinipedia-ingest',
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
    const timeout = this.opts.stageTimeoutSeconds ?? 120;
    const maxAttempts = this.opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    for (const stage of this.stages) {
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
      await this.boss.work<JobData>(
        queueName(stage),
        {
          localConcurrency: this.opts.concurrency ?? 5,
          batchSize: 1,
          pollingIntervalSeconds: this.opts.pollingIntervalSeconds ?? 0.5,
        },
        async (jobs) => {
          for (const job of jobs) await this.handle(stage, job.data.coinId);
        },
      );
    }
    this.started = true;
  }

  private async handle(stage: StageName, coinId: number): Promise<void> {
    this.running++;
    try {
      const out = await executeStage(this.exec, stage, coinId);
      switch (out.kind) {
        case 'done':
        case 'skipped':
        case 'final':
          await this.enqueueNext(stage, coinId);
          return;
        case 'busy':
          throw new Error(`stage ${stage} of coin ${coinId} is held by another worker`);
        case 'retry':
          this.opts.log.warn(`retrying later: ${out.reason}`, { coinId, stage });
          throw new Error(out.reason);
        case 'failed':
          this.opts.log.warn(`left failed: ${out.reason}`, { coinId, stage });
          return;
        case 'lost':
        case 'no_coin':
          return;
      }
    } finally {
      this.running--;
    }
  }

  private nextStage(stage: StageName): StageName | undefined {
    const i = this.stages.indexOf(stage);
    return i >= 0 ? this.stages[i + 1] : undefined;
  }

  private async enqueueNext(stage: StageName, coinId: number): Promise<void> {
    const next = this.nextStage(stage);
    if (next) await this.enqueue(next, [coinId]);
  }

  private async enqueue(stage: StageName, coinIds: readonly number[]): Promise<void> {
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
    const previous = this.opts.registry.previous(stage)?.name;
    const out: NotDoneCoin[] = [];
    let afterId = 0;
    for (;;) {
      const page = await listCoinsNotDone(this.opts.db, stage, {
        version: stageDef.version,
        ...(previous ? { requires: previous } : {}),
        ...(addresses ? { addresses } : {}),
        // A stage that used up its attempts is left failed.
        maxAttempts: this.exec.maxAttempts,
        // A fresh `running` row has a live worker on it.
        runningSince: new Date(this.now().getTime() - this.exec.staleAfterMs),
        afterId,
        limit: PAGE,
      });
      out.push(...page);
      if (page.length < PAGE) return out;
      afterId = page[page.length - 1]!.id;
    }
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
