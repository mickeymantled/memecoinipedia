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

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/**
 * `http` becomes `https`. Anything that is not a valid `http(s)` URL, or that
 * carries credentials, is dropped. A bare domain or a handle is not a URL.
 */
export function normalizeSocialUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
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
  const trimmed = value.trim();
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
