import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, RELEVANCE_OFFSET_CAP } from '../src/cursor.js';
import { ApiError } from '../src/errors.js';
import { escapeLike } from '../src/coins.js';
import { paramsHash, parseListParams, type ListParams } from '../src/params.js';

const parse = (query: Record<string, string | undefined>) => parseListParams((name) => query[name]);

const paramError = (query: Record<string, string | undefined>) => {
  try {
    parse(query);
  } catch (err) {
    if (err instanceof ApiError) return { code: err.code, param: err.param };
    throw err;
  }
  return null;
};

describe('parseListParams', () => {
  it('applies the contract defaults', () => {
    expect(parse({})).toEqual({
      q: null,
      mode: 'keyword',
      narrative: null,
      narrativeScope: 'primary',
      status: null,
      athMin: null,
      athMax: null,
      launchedFrom: null,
      launchedTo: null,
      sort: 'ath_desc',
      limit: 25,
      cursor: null,
    } satisfies ListParams);
    expect(parse({ q: 'pepe' }).sort).toBe('relevance');
    expect(parse({ q: 'pepe', sort: 'ath_asc' }).sort).toBe('ath_asc');
  });

  it('trims q and treats an empty q as absent', () => {
    expect(parse({ q: '  pepe  ' }).q).toBe('pepe');
    expect(parse({ q: '   ' }).q).toBeNull();
    expect(parse({ q: '' }).sort).toBe('ath_desc');
  });

  it('ignores unknown parameters', () => {
    expect(parse({ colour: 'red' })).toEqual(parse({}));
  });

  it('reads lists, bounds and times', () => {
    const p = parse({
      narrative: 'ai,animal,ai',
      narrative_scope: 'any',
      status: 'alive,dead',
      ath_min: '1e6',
      ath_max: '2500000.5',
      launched_from: '2025-01-01',
      launched_to: '2025-02-01T12:30:00+02:00',
      limit: '100',
    });
    expect(p.narrative).toEqual(['ai', 'animal']);
    expect(p.narrativeScope).toBe('any');
    expect(p.status).toEqual(['alive', 'dead']);
    expect([p.athMin, p.athMax]).toEqual([1_000_000, 2_500_000.5]);
    expect(p.launchedFrom).toBe('2025-01-01T00:00:00.000Z');
    expect(p.launchedTo).toBe('2025-02-01T10:30:00.000Z');
    expect(p.limit).toBe(100);
  });

  it.each([
    [{ q: 'x'.repeat(101) }, 'q'],
    [{ q: 'a\u0000b' }, 'q'],
    [{ mode: 'vector' }, 'mode'],
    [{ narrative: 'dogs' }, 'narrative'],
    [{ narrative: 'ai,' }, 'narrative'],
    [{ narrative: '' }, 'narrative'],
    [{ narrative_scope: 'secondary' }, 'narrative_scope'],
    [{ status: 'alive,zombie' }, 'status'],
    [{ ath_min: '-1' }, 'ath_min'],
    [{ ath_min: 'abc' }, 'ath_min'],
    [{ ath_min: '' }, 'ath_min'],
    [{ ath_max: '1e999' }, 'ath_max'],
    [{ launched_from: 'yesterday' }, 'launched_from'],
    [{ launched_from: '2025-02-30' }, 'launched_from'],
    [{ launched_to: '2025-01-01T00:00:00' }, 'launched_to'],
    [{ sort: 'newest' }, 'sort'],
    [{ sort: 'relevance' }, 'sort'],
    [{ q: '   ', sort: 'relevance' }, 'sort'],
    [{ limit: '0' }, 'limit'],
    [{ limit: '101' }, 'limit'],
    [{ limit: '2.5' }, 'limit'],
    [{ limit: 'ten' }, 'limit'],
    [{ mode: 'semantic' }, 'q'],
    [{ mode: 'semantic', q: 'dog', sort: 'ath_desc' }, 'sort'],
  ])('rejects %j as invalid_parameter for %s', (query, param) => {
    expect(paramError(query)).toEqual({ code: 'invalid_parameter', param });
  });

  it('accepts semantic mode with q and no sort', () => {
    expect(parse({ mode: 'semantic', q: 'dog' }).mode).toBe('semantic');
    expect(parse({ mode: 'semantic', q: 'dog', sort: 'relevance' }).sort).toBe('relevance');
  });
});

describe('paramsHash', () => {
  const base = parse({ q: 'pepe', narrative: 'ai,animal' });
  it('ignores limit, cursor and the order of a list', () => {
    expect(paramsHash(parse({ q: 'pepe', narrative: 'animal,ai', limit: '5', cursor: 'x' }))).toBe(
      paramsHash(base),
    );
  });
  it.each([
    { q: 'pepe2', narrative: 'ai,animal' },
    { q: 'pepe', narrative: 'ai' },
    { q: 'pepe', narrative: 'ai,animal', narrative_scope: 'any' },
    { q: 'pepe', narrative: 'ai,animal', status: 'dead' },
    { q: 'pepe', narrative: 'ai,animal', ath_min: '1' },
    { q: 'pepe', narrative: 'ai,animal', launched_to: '2025-01-01' },
    { q: 'pepe', narrative: 'ai,animal', sort: 'ath_desc' },
  ])('changes with %j', (query) => {
    expect(paramsHash(parse(query))).not.toBe(paramsHash(base));
  });
});

describe('cursors', () => {
  const h = 'abcdefghijklmnop';
  const code = (
    cursor: string,
    hash = h,
    sort: Parameters<typeof decodeCursor>[2] = 'ath_desc',
  ) => {
    try {
      decodeCursor(cursor, hash, sort);
    } catch (err) {
      return err instanceof ApiError ? err.code : String(err);
    }
    return 'ok';
  };

  it('round-trips each kind of position', () => {
    expect(decodeCursor(encodeCursor(h, [1267575.15, 12]), h, 'ath_desc')).toEqual({
      kind: 'ath',
      ath: 1267575.15,
      id: 12,
    });
    const at = '2025-03-01T00:00:00.123456Z';
    expect(decodeCursor(encodeCursor(h, [0, at, 9]), h, 'launched_asc')).toEqual({
      kind: 'launched',
      phase: 0,
      at,
      id: 9,
    });
    expect(decodeCursor(encodeCursor(h, [1, null, 9]), h, 'launched_desc')).toEqual({
      kind: 'launched',
      phase: 1,
      id: 9,
    });
    expect(decodeCursor(encodeCursor(h, [50]), h, 'relevance')).toEqual({
      kind: 'offset',
      offset: 50,
    });
  });

  it('rejects cursors the API did not issue', () => {
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    for (const bad of [
      '',
      'not a cursor',
      'b2Zmc2V0OjI1',
      '!!!',
      'x'.repeat(500),
      b64({ v: 2, h, k: [1, 2] }),
      b64({ v: 1, h: 'other', k: [1, 2] }),
      b64({ v: 1, h, k: [1] }),
      b64({ v: 1, h, k: ['1', 2] }),
      b64({ v: 1, h, k: [1, -4] }),
      b64({ v: 1, h, k: [1, 1.5] }),
      b64(['a']),
      b64(null),
    ]) {
      expect(code(bad), bad).toBe('invalid_cursor');
    }
  });

  it('rejects a position of the wrong kind for the sort, or past the relevance cap', () => {
    expect(code(encodeCursor(h, [5]), h, 'ath_desc')).toBe('invalid_cursor');
    expect(code(encodeCursor(h, [5, 7]), h, 'relevance')).toBe('invalid_cursor');
    expect(code(encodeCursor(h, [RELEVANCE_OFFSET_CAP]), h, 'relevance')).toBe('invalid_cursor');
    expect(code(encodeCursor(h, [0]), h, 'relevance')).toBe('invalid_cursor');
    expect(code(encodeCursor(h, [1, 7, 9]), h, 'launched_asc')).toBe('invalid_cursor');
  });
});

describe('escapeLike', () => {
  it('escapes LIKE metacharacters', () => {
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\');
  });
});

describe('SQL is never built by concatenation', () => {
  const dir = join(import.meta.dirname, '../src');
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));

  it.each(files)('%s uses no raw SQL helpers', (file) => {
    const text = readFileSync(join(dir, file), 'utf8');
    // Kysely escape hatches that put a string into the query text.
    expect(text).not.toMatch(/sql\.(raw|lit|id|ref|table|join)\b/);
    expect(text).not.toMatch(/\.(raw|unsafe)\(/);
    expect(text).not.toMatch(/sql<[^>]*>\s*\(/);
    // No SQL keyword followed by a `+` or a template with an unparameterised piece.
    expect(text).not.toMatch(/['"`]\s*(select|where|order by|from)\b[^'"`]*['"`]\s*\+/i);
  });
});
