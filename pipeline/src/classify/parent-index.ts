import type { Kysely } from 'kysely';
import type { Database } from '@memecoinipedia/db';
import type { ExtrasProvider } from './db-store.js';
import { MAX_CANDIDATES, type CoinInput, type ParentCandidate } from './input.js';
import {
  LISTED_MIN_ATH_USD,
  MIN_TICKER_CHARS,
  MAX_NAME_WORDS,
  NAME_SIMILARITY_MIN,
  STOP_WORDS,
  compareRanked,
  normName,
  normTicker,
  prepareCoin,
  scoreParent,
  trigrams,
  usableName,
  usableTicker,
  words,
  coreName,
  type ParentCoin,
  type PreparedCoin,
  type RankKey,
} from './parent-score.js';

/**
 * In-memory parent lookup for one chain (task B5). Built once from the listed coins; answers each
 * coin from hash maps. Read-only: nothing here writes anywhere.
 */

/** Most candidates scored per coin. A ticker that matches thousands of coins is cut to the
 * largest by ATH (then earlier launch, then address) before scoring. */
export const MAX_CONSIDERED = 500;

type Postings = Map<string, number[]>;

function add(map: Postings, key: string, i: number): void {
  const l = map.get(key);
  if (l) l.push(i);
  else map.set(key, [i]);
}

/** Every 3-character run of a ticker (no padding). */
function ticker3grams(t: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3));
  return out;
}

export interface ChildCoin extends ParentCoin {
  description: string | null;
}

export class ParentIndex {
  private readonly addr: string[] = [];
  private readonly rawTicker: (string | null)[] = [];
  private readonly rawName: (string | null)[] = [];
  private readonly tickerN: string[] = [];
  private readonly nameN: string[] = [];
  private readonly launch: number[] = [];
  private readonly ath: number[] = [];
  private readonly athAt: (number | null)[] = [];

  /** Normalised ticker (usable ones only) to coins: forward containment and whole-word ticker. */
  private readonly byTicker: Postings = new Map();
  /** Normalised full name (usable ones only) to coins: whole-word name. */
  private readonly byName: Postings = new Map();
  /** 3-character runs of every ticker: finds tickers that contain a given one. */
  private readonly tickerTri: Postings = new Map();
  /** Name trigrams of the stop-word-stripped name: name similarity. */
  private readonly nameTri: Postings = new Map();

  constructor(
    coins: Iterable<ParentCoin>,
    private readonly minAthUsd = LISTED_MIN_ATH_USD,
    private readonly maxConsidered = MAX_CONSIDERED,
  ) {
    // Listed and launch time known; a coin with no launch time is never a candidate. Positions
    // are the rank order (larger ATH, earlier launch, address), so a smaller position is a better
    // coin and any set of positions sorts into rank order with a plain numeric sort. The result
    // does not depend on the order the coins arrive in.
    const kept = [...coins].filter(
      (c) => c.launched_at !== null && (c.ath_market_cap_usd ?? -1) >= minAthUsd,
    );
    kept.sort(
      (a, b) =>
        (b.ath_market_cap_usd ?? 0) - (a.ath_market_cap_usd ?? 0) ||
        a.launched_at! - b.launched_at! ||
        (a.address < b.address ? -1 : a.address > b.address ? 1 : 0),
    );
    for (const c of kept) {
      const i = this.addr.length;
      const ticker = normTicker(c.ticker);
      const name = normName(c.name);
      this.addr.push(c.address);
      this.rawTicker.push(c.ticker);
      this.rawName.push(c.name);
      this.tickerN.push(ticker);
      this.nameN.push(name);
      this.launch.push(c.launched_at!);
      this.ath.push(c.ath_market_cap_usd ?? 0);
      this.athAt.push(c.ath_at);
      if (usableTicker(ticker)) add(this.byTicker, ticker, i);
      if (usableName(name) && words(name).length <= MAX_NAME_WORDS) add(this.byName, name, i);
      if (ticker.length >= MIN_TICKER_CHARS)
        for (const g of ticker3grams(ticker)) add(this.tickerTri, g, i);
      for (const g of trigrams(coreName(name))) add(this.nameTri, g, i);
    }
  }

  get size(): number {
    return this.addr.length;
  }

  private eligible(i: number, child: ParentCoin): boolean {
    return (
      child.launched_at !== null &&
      this.launch[i]! < child.launched_at &&
      this.addr[i] !== child.address
    );
  }

  /**
   * Adds the eligible members of a posting list. Lists are in position (rank) order, and the best
   * `maxConsidered` of a union are always among the best `maxConsidered` of one of its lists, so
   * each list is read only until it has given that many.
   */
  private addAll(into: Set<number>, list: number[] | undefined, child: ParentCoin): void {
    if (!list) return;
    let taken = 0;
    for (const i of list) {
      if (!this.eligible(i, child)) continue;
      into.add(i);
      if (++taken >= this.maxConsidered) return;
    }
  }

  private addTickersContaining(out: Set<number>, t: string, child: ParentCoin): void {
    let best: number[] | undefined;
    for (const g of ticker3grams(t)) {
      const l = this.tickerTri.get(g);
      if (!l) return;
      if (!best || l.length < best.length) best = l;
    }
    if (!best) return;
    let taken = 0;
    for (const i of best) {
      if (!this.eligible(i, child) || !this.tickerN[i]!.includes(t)) continue;
      out.add(i);
      if (++taken >= this.maxConsidered) return;
    }
  }

  /** Everything that might have evidence. Over-inclusive is fine: scoring decides. */
  private gather(child: ParentCoin, p: PreparedCoin): Set<number> {
    const out = new Set<number>();
    const t = p.ticker;
    // 1a. Parent ticker inside the coin's ticker: every substring of 3 or more characters.
    for (let a = 0; a + MIN_TICKER_CHARS <= t.length; a++)
      for (let b = a + MIN_TICKER_CHARS; b <= t.length; b++) {
        const s = t.slice(a, b);
        if (!STOP_WORDS.has(s)) this.addAll(out, this.byTicker.get(s), child);
      }
    // 1b. The coin's ticker inside a parent's ticker: start from its rarest 3-character run.
    if (usableTicker(t)) this.addTickersContaining(out, t, child);
    // 2. Whole-word ticker, and 3. whole-word name phrase, in the name and the description.
    for (const w of [p.nameWords, p.descWords]) {
      for (const word of w)
        if (usableTicker(word)) this.addAll(out, this.byTicker.get(word), child);
      for (let a = 0; a < w.length; a++)
        for (let n = 1; n <= MAX_NAME_WORDS && a + n <= w.length; n++)
          this.addAll(out, this.byName.get(w.slice(a, a + n).join(' ')), child);
    }
    // 4. Name similarity. Jaccard >= t needs a shared trigram among the rarest
    //    |A| - ceil(t|A|) + 1 of the coin's trigrams (prefix filter), so only those are scanned.
    const grams = [...trigrams(p.core)];
    if (grams.length > 0) {
      const lists = grams
        .map((g) => ({ g, l: this.nameTri.get(g) }))
        .sort((x, y) => (x.l?.length ?? 0) - (y.l?.length ?? 0) || (x.g < y.g ? -1 : 1));
      const keep = grams.length - Math.ceil(NAME_SIMILARITY_MIN * grams.length) + 1;
      for (const { l } of lists.slice(0, keep)) this.addAll(out, l, child);
    }
    return out;
  }

  private preparedAt(i: number): PreparedCoin {
    const name = this.nameN[i]!;
    return {
      ticker: this.tickerN[i]!,
      name,
      nameWords: [],
      descWords: [],
      nameHay: '',
      descHay: '',
      core: coreName(name),
    };
  }

  /** Up to `limit` earlier listed coins on this chain that could be the parent, best first. */
  candidatesFor(child: ChildCoin, limit = MAX_CANDIDATES): ParentCandidate[] {
    if (child.launched_at === null) return [];
    const p = prepareCoin(child);
    if (p.ticker === '' && p.name === '') return [];
    // Positions are rank order, so the cap keeps the largest ATHs: sort numbers, take the first.
    let ids: number[] | Int32Array = Int32Array.from(this.gather(child, p)).sort();
    if (ids.length > this.maxConsidered) ids = ids.subarray(0, this.maxConsidered);
    const ranked: Array<RankKey & { i: number }> = [];
    for (const i of ids) {
      const s = scoreParent(p, this.preparedAt(i), {
        childLaunchedAt: child.launched_at,
        parentAthAt: this.athAt[i] ?? null,
      });
      if (s)
        ranked.push({
          i,
          score: s.score,
          ath: this.ath[i]!,
          launchedAt: this.launch[i]!,
          address: this.addr[i]!,
        });
    }
    ranked.sort(compareRanked);
    return ranked.slice(0, Math.min(limit, MAX_CANDIDATES)).map(({ i }) => ({
      address: this.addr[i]!,
      name: this.rawName[i],
      ticker: this.rawTicker[i],
      launched_at: new Date(this.launch[i]!).toISOString(),
      ath_market_cap_usd: this.ath[i]!,
    }));
  }
}

// ---- Provider ----------------------------------------------------------------------------------

export interface ParentProviderOptions {
  /** ATH at or above which a coin is listed. Default LISTED_MIN_ATH_USD. */
  listedMinAthUsd?: number;
  /** Candidates scored per coin. Default MAX_CONSIDERED. */
  maxConsidered?: number;
  /** Candidates returned per coin, at most MAX_CANDIDATES. */
  limit?: number;
}

const ms = (d: Date | null): number | null => (d === null ? null : d.getTime());

/** Reads the listed coins (SELECT only) into one ParentIndex per chain. */
export async function loadParentIndexes(
  db: Kysely<Database>,
  minAthUsd = LISTED_MIN_ATH_USD,
  maxConsidered = MAX_CONSIDERED,
): Promise<Map<string, ParentIndex>> {
  const rows = await db
    .selectFrom('coins')
    .select(['chain', 'address', 'ticker', 'name', 'launched_at', 'ath_market_cap_usd', 'ath_at'])
    .where('ath_market_cap_usd', '>=', minAthUsd)
    .where('launched_at', 'is not', null)
    .orderBy('id')
    .execute();
  const byChain = new Map<string, ParentCoin[]>();
  for (const r of rows) {
    const c: ParentCoin = {
      address: r.address,
      ticker: r.ticker,
      name: r.name,
      launched_at: ms(r.launched_at),
      ath_market_cap_usd: r.ath_market_cap_usd,
      ath_at: ms(r.ath_at),
    };
    const l = byChain.get(r.chain);
    if (l) l.push(c);
    else byChain.set(r.chain, [c]);
  }
  rows.length = 0;
  const out = new Map<string, ParentIndex>();
  for (const [chain, coins] of byChain)
    out.set(chain, new ParentIndex(coins, minAthUsd, maxConsidered));
  return out;
}

/**
 * An ExtrasProvider that fills `parent_candidates` and nothing else. The index is loaded on first
 * use and kept for the life of the provider. The batch's own coins are read by id (they may be
 * unlisted, so they are not necessarily in the index).
 */
export function createParentCandidateProvider(
  db: Kysely<Database>,
  options: ParentProviderOptions = {},
): ExtrasProvider {
  let loading: Promise<Map<string, ParentIndex>> | undefined;
  const indexes = (): Promise<Map<string, ParentIndex>> => {
    loading ??= loadParentIndexes(db, options.listedMinAthUsd, options.maxConsidered).catch(
      (err: unknown) => {
        loading = undefined;
        throw err;
      },
    );
    return loading;
  };
  return async (rows) => {
    const out = new Map<number, Pick<CoinInput, 'parent_candidates' | 'research'>>();
    if (rows.length === 0) return out;
    const idx = await indexes();
    const ids = rows.map((r) => r.id);
    for (let s = 0; s < ids.length; s += 1000) {
      const part = await db
        .selectFrom('coins')
        .select([
          'id',
          'chain',
          'address',
          'ticker',
          'name',
          'description',
          'launched_at',
          'ath_market_cap_usd',
          'ath_at',
        ])
        .where('id', 'in', ids.slice(s, s + 1000))
        .execute();
      for (const r of part) {
        const index = idx.get(r.chain);
        out.set(r.id, {
          parent_candidates: index
            ? index.candidatesFor(
                {
                  address: r.address,
                  ticker: r.ticker,
                  name: r.name,
                  description: r.description,
                  launched_at: ms(r.launched_at),
                  ath_market_cap_usd: r.ath_market_cap_usd,
                  ath_at: ms(r.ath_at),
                },
                options.limit,
              )
            : [],
        });
      }
    }
    return out;
  };
}

/** Runs both providers and merges their entries per coin; where both set a field, `b` wins. */
export function combineExtras(a: ExtrasProvider, b: ExtrasProvider): ExtrasProvider {
  return async (rows) => {
    const [ma, mb] = await Promise.all([a(rows), b(rows)]);
    const out = new Map<number, Pick<CoinInput, 'parent_candidates' | 'research'>>();
    for (const id of new Set([...ma.keys(), ...mb.keys()])) {
      const merged: Pick<CoinInput, 'parent_candidates' | 'research'> = {
        ...ma.get(id),
        ...definedOnly(mb.get(id)),
      };
      out.set(id, merged);
    }
    return out;
  };
}

function definedOnly<T extends object>(o: T | undefined): Partial<T> {
  if (!o) return {};
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
