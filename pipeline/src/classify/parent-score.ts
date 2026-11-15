/**
 * Parent-candidate evidence and score (task B5, issue #69).
 *
 * Everything here is a pure function of the two coins. Tickers, names and descriptions are written
 * by coin creators, so they are only ever compared as data: no regular expression is built from
 * them (the only regular expressions below are fixed), and nothing is logged.
 */

/** A coin's text and launch facts, as read from the database. Times are epoch milliseconds. */
export interface ParentCoin {
  address: string;
  ticker: string | null;
  name: string | null;
  description?: string | null;
  launched_at: number | null;
  ath_market_cap_usd: number | null;
  ath_at: number | null;
}

// ---- Constants: every number that shapes the ranking lives here --------------------------------

/** A coin is listed (and so can be a parent) at this ATH market cap or more. */
export const LISTED_MIN_ATH_USD = 100_000;
/** Shorter tickers are too common to mean anything (issue #69, evidence 1). */
export const MIN_TICKER_CHARS = 3;
/** Whole-word name matching needs at least this many characters in the normalised name. */
export const MIN_NAME_CHARS = 3;
/** Trigram (Jaccard) similarity of two names at or above this counts as evidence. 0.5 keeps
 * "PNUT 2" ~ "PNUT" (0.71) and drops names that only share a syllable (a shared 3-letter run of
 * two 8-letter names scores about 0.1). */
export const NAME_SIMILARITY_MIN = 0.5;

/** Words that are never evidence on their own: too common among memecoins. Matched on the
 * normalised form. A ticker or name made only of these produces no candidate by itself. */
export const STOP_WORDS: ReadonlySet<string> = new Set([
  'AI',
  'DOG',
  'CAT',
  'COIN',
  'INU',
  'TOKEN',
  'MEME',
  'MOON',
  'BABY',
  'SON',
  'OF',
  'THE',
  'AND',
  'SOL',
  'SOLANA',
  'PUMP',
  'FUN',
  'BOT',
  'KING',
  'GOD',
  'OFFICIAL',
]);

// Weights. Containment normally outranks a whole-word hit, which normally outranks name
// similarity (not always: containment alone can score 61.9, a whole-word hit with identical names
// and the ATH bonus 63). A tie within TIE_BUCKET points goes to the larger ATH.
/** A ticker inside the other ticker is the strongest sign of a derivative ("BABYPNUT"). */
export const W_TICKER_CONTAINS = 60;
/** Scaled by shorter/longer length, so "PNUT2" beats "SUPERMEGAPNUTCOIN" for parent PNUT. */
export const W_TICKER_COVERAGE = 20;
/** The parent's ticker or name is a word of the coin's name: creators name their coin after it. */
export const W_WORD_IN_NAME = 35;
/** The same in the description: weaker, descriptions are long and chatty. */
export const W_WORD_IN_DESC = 25;
/** Scaled by similarity (0.5 to 1): the weakest evidence, text overlap only. */
export const W_NAME_SIMILARITY = 20;
/** Its peak was over before this coin launched: a finished parent is likelier than a live rival. */
export const W_ATH_BEFORE_LAUNCH = 8;
/** Places in the returned list reserved by kind of evidence (the rest go to the best remaining).
 * One kind cannot take all ten: short fragments of a long ticker all contain, but only some of
 * them are the parent. Taken in this order, each kind's best by rank. */
export const RESERVED_CONTAINMENT = 5;
export const RESERVED_WHOLE_WORD = 3;
export const RESERVED_SIMILARITY = 2;
/** Scores in the same bucket of this many points count as near-ties (larger ATH, then earlier). */
export const TIE_BUCKET = 5;

/** Longest ticker kept after normalisation; caps the substrings enumerated per coin. */
export const MAX_TICKER_CHARS = 32;
export const MAX_NAME_CHARS = 64;
export const MAX_DESCRIPTION_CHARS = 1500;
export const MAX_DESCRIPTION_WORDS = 300;
/** Longest parent name (in words) that can match as a whole phrase. */
export const MAX_NAME_WORDS = 6;
/** Raw text is cut to this before Unicode normalisation, so a huge string costs nothing. */
const MAX_RAW_CHARS = 2000;

// ---- Normalisation -----------------------------------------------------------------------------

const NOT_ALNUM = /[^\p{L}\p{N}]+/gu;
const LEADING_DOLLAR = /^\s*\$+/u;

function fold(s: string | null | undefined): string {
  if (s === null || s === undefined) return '';
  return s.slice(0, MAX_RAW_CHARS).normalize('NFKC').toUpperCase().replace(LEADING_DOLLAR, '');
}

/** NFKC, upper case, leading `$` dropped, everything but letters and digits removed. */
export function normTicker(s: string | null | undefined): string {
  return fold(s).replace(NOT_ALNUM, '').slice(0, MAX_TICKER_CHARS);
}

/** The same, but single spaces between words are kept. */
export function normName(s: string | null | undefined, maxChars = MAX_NAME_CHARS): string {
  const rawCut = (s?.length ?? 0) > MAX_RAW_CHARS;
  let n = fold(s).replace(NOT_ALNUM, ' ').trim();
  const dropLastWord = (x: string): string => {
    const at = x.lastIndexOf(' ');
    return at < 0 ? '' : x.slice(0, at);
  };
  if (n.length > maxChars) {
    // A cut inside a word would leave half a word that could match as a whole word: drop it.
    const inside = n[maxChars] !== ' ' && n[maxChars - 1] !== ' ';
    n = n.slice(0, maxChars).trimEnd();
    if (inside) n = dropLastWord(n);
  } else if (rawCut) {
    n = dropLastWord(n);
  }
  return n.trim();
}

export function words(normalised: string): string[] {
  return normalised === '' ? [] : normalised.split(' ');
}

/** The name with stop words removed: what name similarity compares. */
export function coreName(normalisedName: string): string {
  return words(normalisedName)
    .filter((w) => !STOP_WORDS.has(w))
    .join(' ');
}

/** Pg_trgm style trigrams: each word padded with two spaces before and one after. */
export function trigrams(core: string): Set<string> {
  const out = new Set<string>();
  for (const w of words(core)) {
    const p = `  ${w} `;
    for (let i = 0; i + 3 <= p.length; i++) out.add(p.slice(i, i + 3));
  }
  return out;
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const t of small) if (big.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

/** A coin reduced to what the comparison reads. */
export interface PreparedCoin {
  ticker: string;
  name: string;
  nameWords: string[];
  descWords: string[];
  /** ` word word ` forms, so a whole-word test is a plain substring test. */
  nameHay: string;
  descHay: string;
  core: string;
  /** Trigrams of `core`, filled on first use. */
  grams?: Set<string>;
}

function hay(w: string[]): string {
  return w.length === 0 ? '' : ` ${w.join(' ')} `;
}

export function prepareCoin(c: {
  ticker: string | null;
  name: string | null;
  description?: string | null;
}): PreparedCoin {
  const name = normName(c.name);
  const nameWords = words(name);
  const descWords = words(normName(c.description, MAX_DESCRIPTION_CHARS)).slice(
    0,
    MAX_DESCRIPTION_WORDS,
  );
  return {
    ticker: normTicker(c.ticker),
    name,
    nameWords,
    descWords,
    nameHay: hay(nameWords),
    descHay: hay(descWords),
    core: coreName(name),
  };
}

/** True when a ticker is long enough and not a stop word, so it may be matched as a word. */
export function usableTicker(t: string): boolean {
  return t.length >= MIN_TICKER_CHARS && !STOP_WORDS.has(t);
}

/** True when a normalised name may be matched as a whole phrase. */
export function usableName(n: string): boolean {
  return n.length >= MIN_NAME_CHARS && coreName(n) !== '';
}

// ---- Evidence and score ------------------------------------------------------------------------

export interface Evidence {
  /** One ticker contains the other (equal counts). Neither is under 3 characters or a stop word. */
  tickerContains: boolean;
  /** The parent's ticker or full name is a whole word (phrase) in the coin's name. */
  wordInName: boolean;
  /** The same, in the description. */
  wordInDescription: boolean;
  /** Trigram similarity of the stop-word-stripped names, 0 when below NAME_SIMILARITY_MIN. */
  nameSimilarity: number;
}

export interface ParentScore {
  score: number;
  evidence: Evidence;
}

export function tickerContains(child: string, parent: string): { hit: boolean; coverage: number } {
  const [short, long] = child.length <= parent.length ? [child, parent] : [parent, child];
  if (!usableTicker(short) || !long.includes(short)) return { hit: false, coverage: 0 };
  return { hit: true, coverage: short.length / long.length };
}

export function evidenceFor(
  child: PreparedCoin,
  parent: PreparedCoin,
): Evidence & { coverage: number } {
  const tc = tickerContains(child.ticker, parent.ticker);
  const needles: string[] = [];
  if (usableTicker(parent.ticker)) needles.push(` ${parent.ticker} `);
  if (
    parent.name.length >= MIN_NAME_CHARS &&
    parent.core !== '' &&
    parent.name.split(' ').length <= MAX_NAME_WORDS
  )
    needles.push(` ${parent.name} `);
  const wordInName = needles.some((n) => child.nameHay.includes(n));
  const wordInDescription = needles.some((n) => child.descHay.includes(n));
  let nameSimilarity = 0;
  if (child.core !== '' && parent.core !== '') {
    child.grams ??= trigrams(child.core);
    const sim = jaccard(child.grams, trigrams(parent.core));
    if (sim >= NAME_SIMILARITY_MIN) nameSimilarity = sim;
  }
  return {
    tickerContains: tc.hit,
    wordInName,
    wordInDescription,
    nameSimilarity,
    coverage: tc.coverage,
  };
}

/**
 * Score one possible parent for one coin, or null when there is no evidence at all. Does not
 * check eligibility (chain, listing, launch order): that is the pool's job.
 */
export function scoreParent(
  child: PreparedCoin,
  parent: PreparedCoin,
  facts: { childLaunchedAt: number | null; parentAthAt: number | null },
): ParentScore | null {
  const { coverage, ...evidence } = evidenceFor(child, parent);
  if (
    !evidence.tickerContains &&
    !evidence.wordInName &&
    !evidence.wordInDescription &&
    evidence.nameSimilarity === 0
  )
    return null;
  let score = 0;
  if (evidence.tickerContains) score += W_TICKER_CONTAINS + W_TICKER_COVERAGE * coverage;
  if (evidence.wordInName) score += W_WORD_IN_NAME;
  else if (evidence.wordInDescription) score += W_WORD_IN_DESC;
  score += W_NAME_SIMILARITY * evidence.nameSimilarity;
  if (
    facts.childLaunchedAt !== null &&
    facts.parentAthAt !== null &&
    facts.parentAthAt < facts.childLaunchedAt
  )
    score += W_ATH_BEFORE_LAUNCH;
  return { score, evidence };
}

export interface RankKey {
  score: number;
  ath: number;
  launchedAt: number;
  address: string;
}

/** Best first: higher score bucket, then larger ATH, earlier launch, then address. Total order. */
export function compareRanked(a: RankKey, b: RankKey): number {
  const ba = Math.floor(a.score / TIE_BUCKET);
  const bb = Math.floor(b.score / TIE_BUCKET);
  if (ba !== bb) return bb - ba;
  if (a.ath !== b.ath) return b.ath - a.ath;
  if (a.launchedAt !== b.launchedAt) return a.launchedAt - b.launchedAt;
  return a.address < b.address ? -1 : a.address > b.address ? 1 : 0;
}
