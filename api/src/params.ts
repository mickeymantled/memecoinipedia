import { createHash } from 'node:crypto';
import { z } from 'zod';
import { invalidParameter } from './errors.js';

export const NARRATIVES = [
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
] as const;
export type Narrative = (typeof NARRATIVES)[number];

export const STATUSES = ['alive', 'dead', 'rugged', 'unknown'] as const;
export type Status = (typeof STATUSES)[number];

export const SORTS = ['relevance', 'ath_desc', 'ath_asc', 'launched_desc', 'launched_asc'] as const;
export type Sort = (typeof SORTS)[number];

export interface ListParams {
  q: string | null;
  mode: 'keyword' | 'semantic';
  narrative: Narrative[] | null;
  narrativeScope: 'primary' | 'any';
  status: Status[] | null;
  athMin: number | null;
  athMax: number | null;
  /** ISO timestamps, inclusive lower and exclusive upper bound. */
  launchedFrom: string | null;
  launchedTo: string | null;
  /** The sort in effect, after applying the default. */
  sort: Sort;
  limit: number;
  cursor: string | null;
}

type Raw = (name: string) => string | undefined;

const NUMBER = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function parseTime(s: string): string | null {
  const d = DATE.exec(s) ?? DATETIME.exec(s);
  if (!d) return null;
  const [y, m, day] = [Number(d[1]), Number(d[2]), Number(d[3])];
  const check = new Date(Date.UTC(y, m - 1, day));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== day) {
    return null;
  }
  const t = Date.parse(DATE.test(s) ? `${s}T00:00:00Z` : s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

const nonNegative = z.string().regex(NUMBER).transform(Number).pipe(z.number().finite().min(0));

function list<T extends string>(values: readonly T[]) {
  return z
    .string()
    .transform((s) => s.split(','))
    .pipe(z.array(z.enum(values as [T, ...T[]])).min(1))
    .transform((xs) => [...new Set(xs)]);
}

/** Validates the query string of `GET /coins`. Throws `invalid_parameter`. */
export function parseListParams(raw: Raw): ListParams {
  const get = <S extends z.ZodType>(
    name: string,
    schema: S,
    message: string,
  ): z.output<S> | null => {
    const value = raw(name);
    if (value === undefined) return null;
    const r = schema.safeParse(value);
    if (!r.success) throw invalidParameter(name, message);
    return r.data;
  };

  let q: string | null = null;
  const rawQ = raw('q');
  if (rawQ !== undefined) {
    const t = rawQ.trim();
    if (t.length > 100) throw invalidParameter('q', 'q must be 1 to 100 characters');
    if (t.includes('\u0000')) throw invalidParameter('q', 'q must not contain a null character');
    q = t === '' ? null : t;
  }

  const mode = get('mode', z.enum(['keyword', 'semantic']), 'mode must be keyword or semantic');
  const narrative = get(
    'narrative',
    list(NARRATIVES),
    `narrative must be one or more of ${NARRATIVES.join(', ')}, separated by commas`,
  );
  const narrativeScope = get(
    'narrative_scope',
    z.enum(['primary', 'any']),
    'narrative_scope must be primary or any',
  );
  const status = get(
    'status',
    list(STATUSES),
    `status must be one or more of ${STATUSES.join(', ')}, separated by commas`,
  );
  const athMin = get('ath_min', nonNegative, 'ath_min must be a number of 0 or more');
  const athMax = get('ath_max', nonNegative, 'ath_max must be a number of 0 or more');
  const time = z.string().transform((s, ctx) => {
    const t = parseTime(s);
    if (t === null) ctx.issues.push({ code: 'custom', message: 'bad time', input: s });
    return t as string;
  });
  const launchedFrom = get(
    'launched_from',
    time,
    'launched_from must be a date (2025-01-01) or a time (2025-01-01T00:00:00Z)',
  );
  const launchedTo = get(
    'launched_to',
    time,
    'launched_to must be a date (2025-01-01) or a time (2025-01-01T00:00:00Z)',
  );
  const sortRaw = get('sort', z.enum(SORTS), `sort must be one of ${SORTS.join(', ')}`);
  const limit = get(
    'limit',
    z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(100)),
    'limit must be a whole number from 1 to 100',
  );

  const resolvedMode = mode ?? 'keyword';
  if (resolvedMode === 'semantic') {
    if (q === null) throw invalidParameter('q', 'q is required when mode is semantic');
    if (sortRaw !== null && sortRaw !== 'relevance') {
      throw invalidParameter('sort', 'sort must be absent or relevance when mode is semantic');
    }
  } else if (sortRaw === 'relevance' && q === null) {
    throw invalidParameter('sort', 'sort=relevance needs q');
  }

  return {
    q,
    mode: resolvedMode,
    narrative,
    narrativeScope: narrativeScope ?? 'primary',
    status,
    athMin,
    athMax,
    launchedFrom,
    launchedTo,
    sort: sortRaw ?? (q === null ? 'ath_desc' : 'relevance'),
    limit: limit ?? 25,
    cursor: raw('cursor') ?? null,
  };
}

/**
 * A short hash of every parameter that changes which rows a result set holds
 * or how they are ordered. `limit` is left out: a cursor stays valid when the
 * page size changes. Equivalent spellings (narrative order, duplicates) hash
 * the same because the values are normalised first.
 */
export function paramsHash(p: ListParams): string {
  const norm = [
    p.q,
    p.mode,
    p.narrative ? [...p.narrative].sort() : null,
    p.narrative ? p.narrativeScope : null,
    p.status ? [...p.status].sort() : null,
    p.athMin,
    p.athMax,
    p.launchedFrom,
    p.launchedTo,
    p.sort,
  ];
  return createHash('sha256').update(JSON.stringify(norm)).digest('base64url').slice(0, 16);
}
