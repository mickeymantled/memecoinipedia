import { sql, type Kysely } from 'kysely';
import type { Database } from './types.js';

/**
 * Synthetic coins for load tests. Deterministic for a given seed.
 *
 * The shape is meant to stress search the way the real data will: heavy
 * repetition of popular words (hundreds of "PEPE" variants), a long tail of
 * made-up tickers, an ATH distribution with a heavy tail, about 12% of coins
 * below the $100k listing line, some unclassified coins and some without a
 * launch time. Nothing here resembles a real token.
 */
export interface SyntheticOptions {
  count: number;
  seed?: number;
  /** Rows per INSERT. */
  batchSize?: number;
}

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const NARRATIVES = [
  'ai',
  'tech',
  'animal',
  'celebrity',
  'political',
  'news_event',
  'culture_meme',
  'gaming',
  'derivative',
  'utility',
  'other',
];
// Rough weights: animals and culture dominate memecoins.
const NARRATIVE_WEIGHTS = [8, 5, 28, 8, 5, 6, 22, 5, 7, 2, 4];
const STATUSES = ['alive', 'dead', 'rugged', 'unknown'];
const STATUS_WEIGHTS = [6, 62, 28, 4];

const WORDS = [
  'pepe',
  'doge',
  'shib',
  'wif',
  'bonk',
  'cat',
  'dog',
  'frog',
  'moon',
  'rocket',
  'trump',
  'elon',
  'ai',
  'gpt',
  'sol',
  'pump',
  'baby',
  'inu',
  'chad',
  'wojak',
  'based',
  'degen',
  'ape',
  'monkey',
  'banana',
  'pizza',
  'cheese',
  'king',
  'queen',
  'dragon',
  'wolf',
  'bear',
  'bull',
  'penguin',
  'hamster',
  'duck',
  'goat',
  'fish',
  'whale',
  'shark',
  'robot',
  'alien',
  'ghost',
  'gold',
  'diamond',
  'hands',
  'fart',
  'butt',
  'coin',
  'token',
  'cash',
  'money',
  'rich',
  'poor',
  'sad',
  'happy',
  'angry',
  'lord',
  'god',
  'devil',
  'angel',
  'sigma',
  'alpha',
  'beta',
  'meme',
  'lol',
  'wow',
  'much',
  'very',
  'such',
  'zoo',
  'farm',
  'house',
  'war',
  'peace',
  'love',
  'hate',
  'fire',
  'ice',
  'sun',
  'star',
  'galaxy',
  'planet',
  'mars',
  'jupiter',
  'bitcoin',
  'eth',
  'solana',
];
const SYLLABLES = [
  'ba',
  'be',
  'bi',
  'bo',
  'bu',
  'da',
  'de',
  'di',
  'do',
  'du',
  'ga',
  'ge',
  'gi',
  'go',
  'gu',
  'ka',
  'ke',
  'ki',
  'ko',
  'ku',
  'la',
  'le',
  'li',
  'lo',
  'lu',
  'ma',
  'me',
  'mi',
  'mo',
  'mu',
  'na',
  'ne',
  'ni',
  'no',
  'nu',
  'pa',
  'pe',
  'pi',
  'po',
  'pu',
  'ra',
  're',
  'ri',
  'ro',
  'ru',
  'sa',
  'se',
  'si',
  'so',
  'su',
  'ta',
  'te',
  'ti',
  'to',
  'tu',
  'za',
  'ze',
  'zi',
  'zo',
  'zu',
  'x',
  'y',
  'q',
];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function weighted(rand: () => number, weights: number[]): number {
  const total = weights.reduce((a, b) => a + b, 0);
  let x = rand() * total;
  for (let i = 0; i < weights.length; i++) {
    x -= weights[i]!;
    if (x < 0) return i;
  }
  return weights.length - 1;
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export interface SyntheticCoin {
  address: string;
  ticker: string;
  name: string;
  launchedAt: Date | null;
  ath: number | null;
  athAt: Date | null;
  secondsToAth: number | null;
  currentMarketCap: number | null;
  status: string;
  primary: string | null;
  secondary: string[];
  sensitive: boolean;
  description: string | null;
  summary: string | null;
}

const T0 = Date.UTC(2024, 0, 1);
const T1 = Date.UTC(2026, 10, 1);

/** Pure generator: coin number `i` of the stream for `seed`. */
export function* syntheticCoins(count: number, seed = 1): Generator<SyntheticCoin> {
  const rand = mulberry32(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
  // Zipf-ish: a few words are very common.
  const word = () => WORDS[Math.min(WORDS.length - 1, Math.floor(WORDS.length * rand() ** 2.2))]!;
  const madeUp = () => {
    const n = 2 + Math.floor(rand() * 3);
    let s = '';
    for (let i = 0; i < n; i++) s += pick(SYLLABLES);
    return s;
  };
  const used = new Set<string>();
  for (let i = 0; i < count; i++) {
    let address: string;
    do {
      address = '';
      for (let j = 0; j < 40; j++) address += BASE58[Math.floor(rand() * 58)];
      address += 'pump';
    } while (used.has(address));
    used.add(address);

    const kind = rand();
    let nameWords: string[];
    if (kind < 0.45) nameWords = [word()];
    else if (kind < 0.75) nameWords = [word(), word()];
    else if (kind < 0.85) nameWords = [word(), madeUp()];
    else nameWords = [madeUp()];
    const base = nameWords.join('');
    const suffix = rand() < 0.15 ? String(Math.floor(rand() * 100)) : '';
    const ticker = (base.length > 8 ? base.slice(0, 3 + Math.floor(rand() * 4)) : base) + suffix;
    const name =
      nameWords.map(capitalise).join(rand() < 0.5 ? ' ' : '') +
      (rand() < 0.1 ? ' ' + capitalise(word()) + ' Coin' : '');

    const launched = rand() < 0.97 ? new Date(Math.floor(T0 + rand() * (T1 - T0))) : null;
    // Log-normal-ish ATH: median ~ 150k; 12% under the $100k line, 1% have no metrics yet.
    const m = rand();
    let ath: number | null;
    if (m < 0.01) ath = null;
    else {
      const u1 = Math.max(rand(), 1e-12);
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * rand());
      ath = Math.max(5000, Math.exp(Math.log(150_000) + 1.15 * z));
      if (m < 0.13) ath = Math.min(ath, 99_999);
      else ath = Math.max(ath, 100_000);
      ath = Math.round(ath * 100) / 100;
    }
    const secondsToAth = ath === null ? null : Math.floor(rand() ** 3 * 30 * 86400) + 60;
    const athAt =
      ath === null || !launched ? null : new Date(launched.getTime() + secondsToAth! * 1000);

    const classified = rand() < 0.95;
    const primary = classified ? NARRATIVES[weighted(rand, NARRATIVE_WEIGHTS)]! : null;
    const secondary: string[] = [];
    if (classified) {
      const k = weighted(rand, [60, 25, 10, 5]);
      while (secondary.length < k) {
        const s = NARRATIVES[weighted(rand, NARRATIVE_WEIGHTS)]!;
        if (s !== primary && !secondary.includes(s)) secondary.push(s);
      }
    }
    yield {
      address,
      ticker,
      name,
      launchedAt: launched,
      ath,
      athAt,
      secondsToAth,
      currentMarketCap: ath === null ? null : Math.round(ath * rand() ** 2 * 100) / 100,
      status: STATUSES[weighted(rand, STATUS_WEIGHTS)]!,
      primary,
      secondary,
      sensitive: rand() < 0.02,
      description: rand() < 0.8 ? `${name}: ${pick(WORDS)} ${pick(WORDS)} ${pick(WORDS)}` : null,
      summary: classified ? `${name} is a synthetic coin used for load tests.` : null,
    };
  }
}

/** Inserts `count` synthetic coins with `unnest` batches, then vacuums and analyzes. Returns the count. */
export async function insertSyntheticCoins(
  db: Kysely<Database>,
  options: SyntheticOptions,
): Promise<number> {
  const batchSize = options.batchSize ?? 10_000;
  let batch: SyntheticCoin[] = [];
  let total = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    const col = <T>(f: (c: SyntheticCoin) => T) => batch.map(f);
    await sql`
      INSERT INTO coins (
        chain, address, ticker, name, launchpad, launched_at,
        ath_market_cap_usd, ath_at, seconds_to_ath, current_market_cap_usd, status,
        primary_narrative, secondary_narratives, sensitive, description, summary
      )
      SELECT 'solana', a, t, n, 'pump.fun', l, m, aa, s, cm, st, p, sec::text[], se, d, su
      FROM unnest(
        ${col((c) => c.address)}::text[],
        ${col((c) => c.ticker)}::text[],
        ${col((c) => c.name)}::text[],
        ${col((c) => c.launchedAt?.toISOString() ?? null)}::timestamptz[],
        ${col((c) => c.ath)}::double precision[],
        ${col((c) => c.athAt?.toISOString() ?? null)}::timestamptz[],
        ${col((c) => c.secondsToAth)}::bigint[],
        ${col((c) => c.currentMarketCap)}::double precision[],
        ${col((c) => c.status)}::text[],
        ${col((c) => c.primary)}::text[],
        ${col((c) => `{${c.secondary.join(',')}}`)}::text[],
        ${col((c) => c.sensitive)}::boolean[],
        ${col((c) => c.description)}::text[],
        ${col((c) => c.summary)}::text[]
      ) AS u(a, t, n, l, m, aa, s, cm, st, p, sec, se, d, su)`.execute(db);
    total += batch.length;
    batch = [];
  };
  for (const coin of syntheticCoins(options.count, options.seed ?? 1)) {
    batch.push(coin);
    if (batch.length >= batchSize) await flush();
  }
  await flush();
  // What autovacuum would do on a settled table: sets the visibility map (index-only
  // scans) and refreshes statistics.
  await sql`VACUUM (ANALYZE) coins`.execute(db);
  return total;
}
