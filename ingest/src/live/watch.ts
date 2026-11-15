/**
 * The watch loop: read the current price of every watched coin that is due and, when a coin's
 * market cap reaches the trigger, queue it for the stages a backfill runs.
 *
 * Costs Codex.io nothing: Jupiter answers 100 mints a request, under its own rate limit. It runs
 * whether or not the day's Codex.io ceiling has been reached.
 *
 * Market cap. Jupiter's price times the coin's stored total supply, the project's own rule
 * (Jupiter's market cap figure follows its own supply logic). Only when the supply is unknown
 * (not a positive number) is Jupiter's own market cap figure used. A mint Jupiter does not know,
 * or answers without a price, is not an error: it keeps its place in the watched set and is asked
 * again after its age's interval.
 *
 * Every graduate of the last 14 days is polled, fetched or not, listed or not: a coin that was
 * screened out at 24 hours, or fetched at $91,500, can still reach $100,000 on day 5. See
 * `triggerDecision` for when a coin is queued the first time and when again.
 *
 * What is queued is the `candles` stage; the worker queues `metrics`, then `metadata` for a coin
 * whose ATH is $100,000 or more, then `metadata_file`, as each finishes (the backfill's rules).
 */
import {
  listWatchedDue,
  recordTriggerMarketCaps,
  reopenForFetch,
  storeCurrentFigures,
  triggerCandles,
  type CurrentFigures,
  type WatchedCoin,
} from '@memecoinipedia/db';
import type { JupiterToken } from '../sources/jupiter/client.js';
import {
  RETRIGGER_MIN_SECONDS,
  RETRIGGER_STEP,
  TRIGGER_MARKET_CAP_USD,
  WATCH_MAX_REQUESTS_PER_PASS,
  WATCH_MINTS_PER_REQUEST,
  dayKey,
} from './constants.js';
import type { LiveDeps } from './deps.js';
import { WATCH_INTERVALS, safeText, watchEvery, watchSpec } from './util.js';

/** Memory of the watch loop between passes. Losing it (a restart) costs one extra price read. */
export interface WatchState {
  /** Coins Jupiter had no price for, by coin id: when it was asked, and how long to leave it. */
  unanswered: Map<number, { atMs: number; everyMs: number }>;
}
export const newWatchState = (): WatchState => ({ unanswered: new Map() });

export interface WatchPass {
  /** Coins whose price was read. */
  polled: number;
  /** Of those, coins Jupiter had a price for, and coins it had none for. */
  priced: number;
  unanswered: number;
  /** Coins queued for a first candle fetch this pass. */
  triggered: number;
  /** Coins queued for a later fetch (a new high after an earlier fetch) this pass. */
  retriggered: number;
  /** Jupiter requests made (counted here, one per chunk). */
  requests: number;
  error?: string;
}

/** Market cap for the trigger. Null when it cannot be known. */
export function marketCapOf(token: JupiterToken, totalSupply: number): number | null {
  const supplyKnown = Number.isFinite(totalSupply) && totalSupply > 0;
  if (supplyKnown) return token.priceUsd !== null ? token.priceUsd * totalSupply : null;
  return token.marketCapUsd;
}

export type TriggerDecision = 'first' | 'later' | null;

/**
 * Whether a polled coin is queued, and as what.
 *
 * First: its candles were never attempted and its market cap is at the trigger line. (A candles
 * row still waiting for a worker counts as never attempted: it is queued again, which is idempotent.)
 *
 * Later: candles and metrics have both finished (`done` or `skipped`), the candles at least
 * `RETRIGGER_MIN_SECONDS` ago, and the market cap is at the trigger line and at least
 * `RETRIGGER_STEP` times the larger of the stored ATH and the market cap at the last trigger.
 * A coin whose candles or metrics are waiting, running or failed is never triggered again here
 * (a failed one is retried by the sweep).
 */
export function triggerDecision(coin: WatchedCoin, mcap: number, nowMs: number): TriggerDecision {
  if (mcap < TRIGGER_MARKET_CAP_USD) return null;
  const c = coin.candles;
  const attempted =
    c !== null && (c.status !== 'pending' || c.attempts > 0 || c.startedAt !== null);
  if (!attempted) return 'first';
  const finished = (s: WatchedCoin['metrics']) =>
    s !== null && (s.status === 'done' || s.status === 'skipped');
  if (!finished(c) || !finished(coin.metrics)) return null;
  const since = c!.finishedAt === null ? Number.POSITIVE_INFINITY : nowMs - c!.finishedAt.getTime();
  if (since < RETRIGGER_MIN_SECONDS * 1000) return null;
  const high = Math.max(coin.athMarketCapUsd ?? 0, coin.lastTriggerMarketCapUsd ?? 0);
  return mcap >= Math.max(TRIGGER_MARKET_CAP_USD, RETRIGGER_STEP * high) ? 'later' : null;
}

export async function watchOnce(
  deps: LiveDeps,
  state: WatchState = newWatchState(),
): Promise<WatchPass> {
  const now = deps.now();
  const nowMs = now.getTime();
  for (const [id, u] of state.unanswered)
    if (nowMs - u.atMs >= u.everyMs) state.unanswered.delete(id);

  const due = await listWatchedDue(deps.db, watchSpec(now), WATCH_INTERVALS, {
    limit: WATCH_MAX_REQUESTS_PER_PASS * WATCH_MINTS_PER_REQUEST,
    excludeIds: [...state.unanswered.keys()],
  });
  const pass: WatchPass = {
    polled: 0,
    priced: 0,
    unanswered: 0,
    triggered: 0,
    retriggered: 0,
    requests: 0,
  };

  for (let i = 0; i < due.length; i += WATCH_MINTS_PER_REQUEST) {
    const chunk = due.slice(i, i + WATCH_MINTS_PER_REQUEST);
    let tokens: JupiterToken[];
    try {
      pass.requests++;
      tokens = await deps.jupiter.getTokens(chunk.map((c) => c.address));
    } catch (err) {
      pass.error = safeText(err);
      deps.log.warn(
        `watch: price request failed: ${pass.error}; the coins are due again next pass`,
      );
      break;
    }
    const byMint = new Map(tokens.map((t) => [t.mint, t]));
    const figures: CurrentFigures[] = [];
    const first: { coin: WatchedCoin; mcap: number }[] = [];
    const later: { coin: WatchedCoin; mcap: number }[] = [];
    for (const coin of chunk) {
      pass.polled++;
      const token = byMint.get(coin.address);
      const mcap = token && !token.invalid ? marketCapOf(token, coin.totalSupply) : null;
      if (!token || token.invalid || (token.priceUsd === null && mcap === null)) {
        pass.unanswered++;
        const ageSeconds = (nowMs - coin.graduatedAt.getTime()) / 1000;
        state.unanswered.set(coin.id, { atMs: nowMs, everyMs: watchEvery(ageSeconds) * 1000 });
        continue;
      }
      pass.priced++;
      figures.push({
        id: coin.id,
        priceUsd: token.priceUsd,
        marketCapUsd: mcap,
        liquidityUsd: token.liquidityUsd,
        volume24hUsd: token.volume24hUsd,
      });
      if (mcap === null) continue;
      const d = triggerDecision(coin, mcap, nowMs);
      if (d === 'first') first.push({ coin, mcap });
      else if (d === 'later') later.push({ coin, mcap });
    }
    await storeCurrentFigures(deps.db, figures, now);
    if (first.length > 0) {
      const ids = first.map((x) => x.coin.id);
      const fresh = await triggerCandles(deps.db, ids, {
        now,
        dayKey: dayKey(now),
        counter: 'triggered',
      });
      await recordTriggerMarketCaps(
        deps.db,
        first.map((x) => ({ id: x.coin.id, marketCapUsd: x.mcap })),
        now,
      );
      pass.triggered += fresh.length;
      // Every id, not only the new ones: a row left waiting by a lost job is queued again, and a
      // coin already waiting in the queue is not queued twice.
      await deps.enqueue('candles', ids);
      if (fresh.length > 0) deps.log.info(`watch: ${fresh.length} coins reached the trigger`);
    }
    if (later.length > 0) {
      const reopened = await reopenForFetch(
        deps.db,
        later.map((x) => x.coin.id),
        { now, dayKey: dayKey(now), counter: 'retriggered' },
      );
      const ok = new Set(reopened);
      await recordTriggerMarketCaps(
        deps.db,
        later
          .filter((x) => ok.has(x.coin.id))
          .map((x) => ({ id: x.coin.id, marketCapUsd: x.mcap })),
        now,
      );
      pass.retriggered += reopened.length;
      if (reopened.length > 0) {
        await deps.enqueue('candles', reopened);
        deps.log.info(`watch: ${reopened.length} fetched coins reached a new high`);
      }
    }
  }
  return pass;
}
