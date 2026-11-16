/**
 * Reads the fields we keep out of a token metadata JSON. The JSON is written
 * by whoever made the coin, so every field is checked and anything of the
 * wrong type becomes null. The untouched JSON is returned next to this by the
 * fetcher, for `coins.metadata_raw`.
 */

export interface TokenMetadata {
  name: string | null;
  symbol: string | null;
  description: string | null;
  /** As written in the JSON when it is an http(s), ipfs or ar URI; otherwise null. */
  image: string | null;
  /** Normalised to an `https` URL. Null when missing or not a valid http(s) URL. */
  twitter: string | null;
  telegram: string | null;
  website: string | null;
}

/** Postgres rejects the NUL character in both text and jsonb, so it is removed everywhere. */
export const stripNul = (s: string): string => s.replaceAll('\u0000', '');

/** Metadata JSON may nest at most this many containers (objects and arrays) deep. */
export const MAX_JSON_DEPTH = 64;

export class JsonTooDeepError extends Error {
  readonly maxDepth: number;

  constructor(maxDepth: number) {
    super(`JSON is nested more than ${maxDepth} levels deep`);
    this.name = 'JsonTooDeepError';
    this.maxDepth = maxDepth;
  }
}

const isContainer = (v: unknown): v is object => v !== null && typeof v === 'object';

/**
 * A deep copy with NUL removed from every string value and every object key, at any
 * depth. Numbers, booleans and null are untouched. If two keys become the same after
 * stripping, the later one wins.
 *
 * The walk is iterative and stops at `maxDepth` containers (the outermost object or
 * array is level 1): it throws `JsonTooDeepError` as soon as it would go deeper, without
 * descending further, so it is safe on a value nested 100,000 levels deep.
 */
export function stripNulDeep(value: unknown, maxDepth = MAX_JSON_DEPTH): unknown {
  if (typeof value === 'string') return stripNul(value);
  if (!isContainer(value)) return value;
  if (maxDepth < 1) throw new JsonTooDeepError(maxDepth);

  const root: unknown = Array.isArray(value) ? [] : {};
  const stack: Array<{ src: object; dst: object; depth: number }> = [
    { src: value, dst: root as object, depth: 1 },
  ];
  while (stack.length > 0) {
    const { src, dst, depth } = stack.pop()!;
    const put = (key: string, v: unknown): void => {
      let out = v;
      if (typeof v === 'string') out = stripNul(v);
      else if (isContainer(v)) {
        if (depth + 1 > maxDepth) throw new JsonTooDeepError(maxDepth);
        out = Array.isArray(v) ? [] : {};
        stack.push({ src: v, dst: out as object, depth: depth + 1 });
      }
      if (Array.isArray(dst)) dst.push(out);
      // defineProperty keeps a "__proto__" key as plain data.
      else
        Object.defineProperty(dst, key, {
          value: out,
          enumerable: true,
          writable: true,
          configurable: true,
        });
    };
    if (Array.isArray(src)) for (const v of src) put('', v);
    else for (const [k, v] of Object.entries(src)) put(stripNul(k), v);
  }
  return root;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? stripNul(v) : null);

/**
 * `http` becomes `https`. Anything that is not a valid `http(s)` URL, or that
 * carries credentials, is dropped. A bare domain or a handle is not a URL.
 */
export function normalizeSocialUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = stripNul(value).trim();
  if (trimmed === '' || trimmed.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  if (url.hostname === '') return null;
  url.protocol = 'https:';
  return url.toString();
}

function imageValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = stripNul(value).trim();
  if (trimmed === '' || trimmed.length > 2048) return null;
  try {
    const url = new URL(trimmed);
    if (['http:', 'https:', 'ipfs:', 'ar:'].includes(url.protocol)) return trimmed;
  } catch {
    // fall through
  }
  return null;
}

export function parseTokenMetadata(json: Record<string, unknown>): TokenMetadata {
  return {
    name: str(json['name']),
    symbol: str(json['symbol']),
    description: str(json['description']),
    image: imageValue(json['image']),
    twitter: normalizeSocialUrl(json['twitter']),
    telegram: normalizeSocialUrl(json['telegram']),
    website: normalizeSocialUrl(json['website']),
  };
}
