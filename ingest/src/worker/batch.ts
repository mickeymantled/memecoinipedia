/**
 * Turns "one coin asks for one answer" into "one request for a whole batch".
 *
 * The queue runs one job per coin, but Helius answers 1,000 mints per call and
 * Jupiter 100. When a job asks for a mint that is not cached, the loader asks
 * `candidates` for the next coins that will need the same data and fetches the
 * lot in one request, then keeps the answers. Later jobs find theirs in the
 * cache. A resumed process starts with an empty cache and so fetches only for
 * the coins that are still to do.
 *
 * - Loads run one at a time, so jobs that miss together share one batch.
 * - A failed load is remembered for `errorCooldownMs`: jobs that arrive during
 *   that time fail at once with the same error instead of each repeating a
 *   request that is failing (and costing credits).
 * - The cache is bounded; the oldest entries go first.
 */

export interface PrefetchLoaderOptions<V> {
  /** Answers for these keys. A key left out of the map is treated as unknown to the source. */
  fetch(keys: string[]): Promise<Map<string, V>>;
  /** The value to hand out for a key `fetch` left out. */
  missing(key: string): V;
  /** Keys most likely to be asked for next (up to `limit`, which may exceed `maxBatch`). */
  candidates(first: string, limit: number): Promise<string[]>;
  maxBatch: number;
  cacheLimit?: number;
  errorCooldownMs?: number;
  now?: () => number;
}

export class PrefetchLoader<V> {
  private readonly cache = new Map<string, V>();
  private lock: Promise<unknown> = Promise.resolve();
  private lastError: { error: unknown; at: number } | null = null;
  private readonly cacheLimit: number;
  private readonly cooldown: number;
  private readonly now: () => number;
  /** Requests made to `fetch`. */
  fetches = 0;

  constructor(private readonly opts: PrefetchLoaderOptions<V>) {
    this.cacheLimit = opts.cacheLimit ?? 5000;
    this.cooldown = opts.errorCooldownMs ?? 30_000;
    this.now = opts.now ?? (() => Date.now());
  }

  get(key: string): Promise<V> {
    const hit = this.cache.get(key);
    if (hit !== undefined) return Promise.resolve(hit);
    const run = this.lock.then(() => this.load(key));
    this.lock = run.catch(() => undefined);
    return run;
  }

  private async load(key: string): Promise<V> {
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    if (this.lastError && this.now() - this.lastError.at < this.cooldown) {
      throw this.lastError.error;
    }
    // Ask for extra: coins fetched earlier that are not finished yet come back too, and are filtered out below.
    const ask = this.opts.maxBatch + Math.min(this.cache.size, 5000);
    const others = await this.opts.candidates(key, ask);
    const batch = [key, ...others.filter((k) => k !== key && !this.cache.has(k))].slice(
      0,
      this.opts.maxBatch,
    );
    let answers: Map<string, V>;
    try {
      this.fetches++;
      answers = await this.opts.fetch(batch);
    } catch (err) {
      this.lastError = { error: err, at: this.now() };
      throw err;
    }
    this.lastError = null;
    for (const k of batch) this.remember(k, answers.get(k) ?? this.opts.missing(k));
    return this.cache.get(key) as V;
  }

  private remember(key: string, value: V): void {
    this.cache.delete(key);
    this.cache.set(key, value);
    while (this.cache.size > this.cacheLimit) {
      const oldest = this.cache.keys().next().value as string;
      this.cache.delete(oldest);
    }
  }
}
