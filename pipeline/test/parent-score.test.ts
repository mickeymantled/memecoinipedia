import { describe, expect, it } from 'vitest';
import {
  NAME_SIMILARITY_MIN,
  STOP_WORDS,
  TIE_BUCKET,
  W_ATH_BEFORE_LAUNCH,
  W_NAME_SIMILARITY,
  W_TICKER_CONTAINS,
  W_TICKER_COVERAGE,
  W_WORD_IN_DESC,
  W_WORD_IN_NAME,
  compareRanked,
  jaccard,
  normName,
  normTicker,
  prepareCoin,
  scoreParent,
  trigrams,
} from '../src/classify/parent-score.js';

const none: { childLaunchedAt: number | null; parentAthAt: number | null } = {
  childLaunchedAt: null,
  parentAthAt: null,
};
const score = (
  child: Parameters<typeof prepareCoin>[0],
  parent: Parameters<typeof prepareCoin>[0],
  facts = none,
) => scoreParent(prepareCoin(child), prepareCoin(parent), facts);

describe('normalisation', () => {
  it('tickers: NFKC, upper case, leading $ dropped, only letters and digits', () => {
    expect(normTicker('$pnut')).toBe('PNUT');
    expect(normTicker('  $$Pnut-2! ')).toBe('PNUT2');
    expect(normTicker('ＰＮＵＴ')).toBe('PNUT'); // fullwidth
    expect(normTicker('＄pnut')).toBe('PNUT'); // fullwidth dollar
    expect(normTicker('🐕')).toBe('');
    expect(normTicker(null)).toBe('');
  });

  it('names keep single spaces between words', () => {
    expect(normName('  $Son   of\tPnut!! ')).toBe('SON OF PNUT');
    expect(normName('Moo-Deng 2')).toBe('MOO DENG 2');
    expect(normName('🐕🐕')).toBe('');
  });

  it('cuts huge input instead of choking on it', () => {
    expect(normTicker('A'.repeat(1_000_000)).length).toBeLessThanOrEqual(32);
    expect(normName('word '.repeat(1_000_000)).length).toBeLessThanOrEqual(64);
  });
});

describe('scoreParent evidence', () => {
  it('ticker containment, both directions, equal counts', () => {
    expect(
      score({ ticker: 'BABYPNUT', name: null }, { ticker: 'PNUT', name: null }),
    ).not.toBeNull();
    expect(
      score({ ticker: 'PNUT', name: null }, { ticker: 'BABYPNUT', name: null }),
    ).not.toBeNull();
    expect(score({ ticker: '$pnut', name: null }, { ticker: 'PNUT', name: null })).not.toBeNull();
  });

  it('tickers under 3 characters never count', () => {
    expect(score({ ticker: 'XYPNUT', name: null }, { ticker: 'XY', name: null })).toBeNull();
    expect(score({ ticker: 'XY', name: null }, { ticker: 'XYZZY', name: null })).toBeNull();
  });

  it('stop words alone give nothing: as ticker, as name, inside a longer ticker', () => {
    for (const w of ['AI', 'DOG', 'CAT', 'COIN', 'INU']) expect(STOP_WORDS.has(w)).toBe(true);
    expect(
      score({ ticker: 'BABYDOG', name: 'Baby Dog' }, { ticker: 'DOG', name: 'Dog' }),
    ).toBeNull();
    expect(score({ ticker: 'DOG', name: 'Dog' }, { ticker: 'DOG', name: 'Dog' })).toBeNull();
    expect(
      score({ ticker: 'COINAI', name: 'Coin AI' }, { ticker: 'COIN', name: 'AI Coin' }),
    ).toBeNull();
    expect(
      score(
        { ticker: 'X', name: 'my new coin', description: 'the dog and cat coin' },
        { ticker: 'CAT', name: 'Dog Coin' },
      ),
    ).toBeNull();
  });

  it('a stop word with a real word beside it still matches on the real word', () => {
    const s = score({ ticker: 'DOGPNUT', name: 'Dog Pnut' }, { ticker: 'PNUT', name: 'Pnut' });
    expect(s?.evidence.tickerContains).toBe(true);
  });

  it('whole word: ticker or full name in the name or the description, not inside a word', () => {
    const inName = score(
      { ticker: 'ZZZ', name: 'The real Bonk' },
      { ticker: 'BONK', name: 'Bonk' },
    );
    expect(inName?.evidence.wordInName).toBe(true);
    const phrase = score(
      { ticker: 'ZZZ', name: 'Sequel to Moo Deng' },
      { ticker: 'MD', name: 'Moo Deng' },
    );
    expect(phrase?.evidence.wordInName).toBe(true);
    const inDesc = score(
      { ticker: 'ZZZ', name: 'Other', description: 'a tribute to $BONK, the og' },
      { ticker: 'BONK', name: 'Bonk' },
    );
    expect(inDesc?.evidence).toMatchObject({ wordInName: false, wordInDescription: true });
    // "BONKERS" is not the word BONK; a different word and no similarity.
    expect(
      score({ ticker: 'ZZZ', name: 'Bonkers' }, { ticker: 'BONK', name: 'Bonk' })?.evidence
        .wordInName ?? false,
    ).toBe(false);
  });

  it('name similarity needs the threshold', () => {
    expect(NAME_SIMILARITY_MIN).toBe(0.5);
    const hit = score({ ticker: 'AAA', name: 'Pnut 2' }, { ticker: 'BBB', name: 'Pnut' });
    expect(hit?.evidence.nameSimilarity).toBeGreaterThanOrEqual(NAME_SIMILARITY_MIN);
    expect(
      score({ ticker: 'AAA', name: 'Catwifhat' }, { ticker: 'BBB', name: 'Dogwifhat' }),
    ).toBeNull();
  });

  it('no evidence, no candidate; empty text is safe', () => {
    expect(
      score({ ticker: 'QXVZMT', name: 'Qxvzmt' }, { ticker: 'PNUT', name: 'Peanut' }),
    ).toBeNull();
    expect(score({ ticker: null, name: null }, { ticker: null, name: null })).toBeNull();
    expect(score({ ticker: '🐕', name: '🐕' }, { ticker: '🐕', name: '🐕' })).toBeNull();
  });

  it('text that looks like a pattern is only data', () => {
    expect(() =>
      score({ ticker: '(a+)+$', name: '.*[' }, { ticker: '\\', name: '(?<x>' }),
    ).not.toThrow();
  });
});

describe('scoreParent weights', () => {
  it('weights keep the order: containment > whole word > similarity', () => {
    expect(W_TICKER_CONTAINS).toBeGreaterThan(W_WORD_IN_NAME + W_NAME_SIMILARITY);
    expect(W_WORD_IN_NAME).toBeGreaterThan(W_WORD_IN_DESC);
    expect(W_ATH_BEFORE_LAUNCH).toBeLessThan(W_WORD_IN_DESC);
  });

  it('computes the score from the evidence, exactly', () => {
    // Containment only: PNUT in BABYPNUT, names unrelated. coverage 4/8.
    const s = score({ ticker: 'BABYPNUT', name: 'Zzzz' }, { ticker: 'PNUT', name: 'Qqqq' });
    expect(s?.score).toBeCloseTo(W_TICKER_CONTAINS + W_TICKER_COVERAGE * 0.5);
    // Word in name only.
    const w = score({ ticker: 'ZZZ', name: 'Real Bonk' }, { ticker: 'BONK', name: 'Qqqq' });
    expect(w?.score).toBe(W_WORD_IN_NAME);
    // Word in description only.
    const d = score(
      { ticker: 'ZZZ', name: 'Other', description: 'about bonk' },
      { ticker: 'BONK', name: 'Qqqq' },
    );
    expect(d?.score).toBe(W_WORD_IN_DESC);
  });

  it('a closer ticker scores higher than a loose one', () => {
    const close = score({ ticker: 'PNUT2', name: null }, { ticker: 'PNUT', name: null });
    const loose = score(
      { ticker: 'SUPERMEGAPNUTCOIN', name: null },
      { ticker: 'PNUT', name: null },
    );
    expect(close!.score).toBeGreaterThan(loose!.score);
  });

  it('ATH before the coin launched adds a bonus; unknown times add nothing', () => {
    const c = { ticker: 'BABYPNUT', name: null };
    const p = { ticker: 'PNUT', name: null };
    const base = score(c, p)!.score;
    expect(score(c, p, { childLaunchedAt: 1000, parentAthAt: 500 })!.score).toBe(
      base + W_ATH_BEFORE_LAUNCH,
    );
    expect(score(c, p, { childLaunchedAt: 1000, parentAthAt: 1500 })!.score).toBe(base);
    expect(score(c, p, { childLaunchedAt: 1000, parentAthAt: null })!.score).toBe(base);
  });

  it('is a pure function: same input, same output', () => {
    const a = score({ ticker: 'BABYPNUT', name: 'Baby Pnut' }, { ticker: 'PNUT', name: 'Pnut' });
    const b = score({ ticker: 'BABYPNUT', name: 'Baby Pnut' }, { ticker: 'PNUT', name: 'Pnut' });
    expect(a).toEqual(b);
  });
});

describe('ranking order', () => {
  const k = (score: number, ath: number, launchedAt: number, address: string) => ({
    score,
    ath,
    launchedAt,
    address,
  });
  it('near-ties go to the larger ATH, then the earlier launch, then address', () => {
    const list = [
      k(80 + TIE_BUCKET - 1 - 0.5, 10, 5, 'a'), // same bucket as 80
      k(80, 20, 9, 'b'),
      k(80, 20, 3, 'c'),
      k(80, 20, 3, 'd'),
    ];
    expect(list.sort(compareRanked).map((x) => x.address)).toEqual(['c', 'd', 'b', 'a']);
  });
  it('a clearly higher score wins over a larger ATH', () => {
    expect(
      [k(60, 1e9, 1, 'a'), k(60 + 2 * TIE_BUCKET, 1, 1, 'b')].sort(compareRanked)[0]!.address,
    ).toBe('b');
  });
});

describe('trigram helpers', () => {
  it('pads words like pg_trgm and compares sets', () => {
    expect([...trigrams('A')].sort()).toEqual(['  a'.toUpperCase(), ' A '].sort());
    expect(jaccard(trigrams('PNUT'), trigrams('PNUT'))).toBe(1);
    expect(jaccard(trigrams('PNUT'), trigrams('ZZZZ'))).toBe(0);
    expect(jaccard(new Set(), trigrams('PNUT'))).toBe(0);
  });
});
