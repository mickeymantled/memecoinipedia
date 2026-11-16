/**
 * The daily refresh: once per UTC day, read price, liquidity and 24-hour volume from Jupiter for
 * every listed coin (ATH of $100,000 or more), 100 mints a request, and store the `current_*`
 * columns, `last_alive_at` and the status they imply (`storeRefresh`, which decides the status with
 * the same function as the metrics computation). Costs Codex.io nothing.
 *
 * A pass sends at most `REFRESH_REQUESTS_PER_PASS` requests and goes on from where the last one
 * stopped: the day and the id reached are kept in `live_state` after every request, so a restart
 * does not start the day again. It shares the process's Jupiter client (and so its limiter) with
 * the watch loop, and the watch loop goes first: a request is sent only when no watch request is
 * due (`shouldYield`, asked before each one).
 *
 * A mint Jupiter does not know, or answers without a usable row, is stored with no price and no
 * liquidity; it is counted, not reported as an error. A failed request is logged and tried again
 * on the next pass; the place is not moved.
 */
import {
  bumpLiveCounters,
  getLiveState,
  listListedCoins,
  setLiveState,
  storeRefresh,
  type RefreshFigure,
} from '@memecoinipedia/db';
import {
  REFRESH_LISTED_USD,
  REFRESH_MINTS_PER_REQUEST,
  REFRESH_REQUESTS_PER_PASS,
  STATE_REFRESH,
  dayKey,
} from './constants.js';
import { JupiterRateLimitedError } from '../sources/jupiter/client.js';
import type { LiveDeps } from './deps.js';
import { safeText } from './util.js';
import { marketCapOf } from './watch.js';

/** What `live_state` keeps of the day's refresh. */
export interface RefreshState {
  /** UTC day, `day:YYYY-MM-DD`. */
  day: string;
  /** Listed coins up to this id have been refreshed today. */
  afterId: number;
  done: boolean;
  requests: number;
  coins: number;
  /** Coins Jupiter had no usable figures for. */
  unknown: number;
  /** Coins whose figures met the alive line. */
  metLine: number;
  /** Coins whose status changed. */
  changed: number;
  startedAt: string;
  finishedAt?: string;
}

export interface RefreshPass {
  status: 'idle' | 'progress' | 'done' | 'yielded' | 'paused' | 'failed';
  requests: number;
  coins: number;
  unknown: number;
  error?: string;
}

export async function refreshState(deps: Pick<LiveDeps, 'db'>): Promise<RefreshState | null> {
  return getLiveState<RefreshState>(deps.db, STATE_REFRESH);
}

/** True when today's refresh has finished (the top-up waits for it). */
export async function refreshDoneToday(deps: Pick<LiveDeps, 'db' | 'now'>): Promise<boolean> {
  const s = await refreshState(deps);
  return s !== null && s.day === dayKey(deps.now()) && s.done;
}

export async function refreshOnce(
  deps: LiveDeps,
  opts: {
    /** Asked before every request: true when a watch request is due and must go first. */
    shouldYield?: () => Promise<boolean>;
    maxRequests?: number;
  } = {},
): Promise<RefreshPass> {
  const pass: RefreshPass = { status: 'idle', requests: 0, coins: 0, unknown: 0 };
  const today = dayKey(deps.now());
  let state = await refreshState(deps);
  if (state === null || state.day !== today) {
    state = {
      day: today,
      afterId: 0,
      done: false,
      requests: 0,
      coins: 0,
      unknown: 0,
      metLine: 0,
      changed: 0,
      startedAt: deps.now().toISOString(),
    };
    await setLiveState(deps.db, STATE_REFRESH, state, deps.now());
  }
  if (state.done) return pass;

  const max = opts.maxRequests ?? REFRESH_REQUESTS_PER_PASS;
  while (pass.requests < max) {
    if (opts.shouldYield && (await opts.shouldYield())) {
      pass.status = 'yielded';
      return pass;
    }
    // Jupiter asked every request of the process to wait: end the pass, the next one goes on.
    if ((deps.jupiter.pausedForMs?.() ?? 0) > 0) {
      pass.status = 'paused';
      return pass;
    }
    const page = await listListedCoins(deps.db, {
      listedUsd: REFRESH_LISTED_USD,
      afterId: state.afterId,
      limit: REFRESH_MINTS_PER_REQUEST,
    });
    if (page.length === 0) {
      state = { ...state, done: true, finishedAt: deps.now().toISOString() };
      await setLiveState(deps.db, STATE_REFRESH, state, deps.now());
      deps.log.info(
        `refresh done for ${today.slice(4)}: ${state.coins} listed coins, ${state.unknown} unknown to Jupiter, ${state.changed} changed status`,
      );
      pass.status = 'done';
      return pass;
    }
    let tokens;
    try {
      pass.requests++;
      tokens = await deps.jupiter.getTokens(page.map((c) => c.address));
    } catch (err) {
      pass.error = safeText(err);
      if (err instanceof JupiterRateLimitedError) {
        // Not a failure of the pass or of any coin: Jupiter said wait, and kept saying it.
        pass.status = 'paused';
        deps.log.warn(`refresh: ${pass.error}; the next pass goes on from the same place`);
        return pass;
      }
      pass.status = 'failed';
      deps.log.warn(`refresh: price request failed: ${pass.error}; tried again next pass`);
      return pass;
    }
    const byMint = new Map(tokens.map((t) => [t.mint, t]));
    let unknown = 0;
    const figures: RefreshFigure[] = page.map((c) => {
      const t = byMint.get(c.address);
      if (!t || !t.found || t.invalid) {
        unknown++;
        return {
          id: c.id,
          priceUsd: null,
          marketCapUsd: null,
          liquidityUsd: null,
          volume24hUsd: null,
        };
      }
      return {
        id: c.id,
        priceUsd: t.priceUsd,
        marketCapUsd: marketCapOf(t, c.totalSupply),
        liquidityUsd: t.liquidityUsd,
        volume24hUsd: t.volume24hUsd,
      };
    });
    const now = deps.now();
    const out = await storeRefresh(deps.db, figures, now);
    state = {
      ...state,
      afterId: page[page.length - 1]!.id,
      requests: state.requests + 1,
      coins: state.coins + page.length,
      unknown: state.unknown + unknown,
      metLine: state.metLine + out.metLine,
      changed: state.changed + out.changed,
    };
    await setLiveState(deps.db, STATE_REFRESH, state, now);
    await bumpLiveCounters(
      deps.db,
      today,
      { refreshed: page.length, refresh_unknown: unknown },
      now,
    );
    pass.coins += page.length;
    pass.unknown += unknown;
    pass.status = 'progress';
  }
  return pass;
}
