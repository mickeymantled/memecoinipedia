/**
 * Reads a token's metadata URI into what to fetch. The URI is on-chain data
 * that anyone can write, so anything unexpected is `unsupported`.
 *
 * Forms understood:
 * - `ipfs://<cid>[/path]` (also the odd `ipfs://ipfs/<cid>`)
 * - path gateways: `https://<host>/ipfs/<cid>[/path]`
 * - subdomain gateways: `https://<cid>.ipfs.<host>[/path]`
 * - Arweave: `ar://<id>[/path]` and `https://arweave.net/<id>[/path]`
 * - any other `http` or `https` URL, fetched as it is
 *
 * CIDv0 is `Qm` plus 44 base58 characters (46 in all). CIDv1 here is `baf`
 * plus lowercase base32, which covers `bafy...` and `bafk...`.
 */

export type ParsedUri =
  | {
      kind: 'ipfs';
      cid: string;
      /** Empty, or starts with `/`. */
      path: string;
      /** Where the URI pointed (`https://host`), or null for `ipfs://`. */
      originalOrigin: string | null;
      /** The URI exactly as written when it is an http(s) gateway URL, else null. */
      originalUrl: string | null;
    }
  | {
      kind: 'arweave';
      id: string;
      path: string;
      originalOrigin: string | null;
      originalUrl: string | null;
    }
  | { kind: 'http'; url: string }
  | { kind: 'unsupported'; reason: string };

const CID_V0 = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const CID_V1 = /^baf[a-z2-7]{40,120}$/;
const ARWEAVE_ID = /^[A-Za-z0-9_-]{43}$/;
const MAX_URI_LENGTH = 2048;

export const isCid = (s: string): boolean => CID_V0.test(s) || CID_V1.test(s);

function cleanPath(path: string): string | null {
  if (path === '' || path === '/') return '';
  if (path.includes('\\')) return null;
  if (path.split('/').some((seg) => seg === '..' || seg === '.')) return null;
  return path;
}

/** True when the string holds a space or any control character (code 0x20 or below, or 0x7f). */
function hasControlOrSpace(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f) return true;
  }
  return false;
}

export function parseMetadataUri(input: string): ParsedUri {
  const uri = input.trim();
  if (uri === '') return { kind: 'unsupported', reason: 'empty URI' };
  if (uri.length > MAX_URI_LENGTH) return { kind: 'unsupported', reason: 'URI too long' };
  // Control characters and spaces never belong in one of these URIs.
  if (hasControlOrSpace(uri)) {
    return { kind: 'unsupported', reason: 'URI contains whitespace or control characters' };
  }

  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(uri)?.[1]?.toLowerCase();
  if (scheme === undefined) return { kind: 'unsupported', reason: 'not an absolute URI' };

  if (scheme === 'ipfs') {
    const m = /^ipfs:\/\/(?:ipfs\/)?([^/?#]+)([^?#]*)/i.exec(uri);
    if (!m) return { kind: 'unsupported', reason: 'malformed ipfs URI' };
    const cid = m[1]!;
    if (!isCid(cid)) return { kind: 'unsupported', reason: 'not a CIDv0 or CIDv1' };
    const path = cleanPath(m[2]!);
    if (path === null) return { kind: 'unsupported', reason: 'bad path' };
    return { kind: 'ipfs', cid, path, originalOrigin: null, originalUrl: null };
  }

  if (scheme === 'ar') {
    const m = /^ar:\/\/([^/?#]+)([^?#]*)/i.exec(uri);
    if (!m || !ARWEAVE_ID.test(m[1]!)) {
      return { kind: 'unsupported', reason: 'not an Arweave transaction id' };
    }
    const path = cleanPath(m[2]!);
    if (path === null) return { kind: 'unsupported', reason: 'bad path' };
    return { kind: 'arweave', id: m[1]!, path, originalOrigin: null, originalUrl: null };
  }

  if (scheme !== 'http' && scheme !== 'https') {
    return { kind: 'unsupported', reason: `scheme ${scheme} is not supported` };
  }

  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return { kind: 'unsupported', reason: 'not a valid URL' };
  }
  if (url.username !== '' || url.password !== '') {
    return { kind: 'unsupported', reason: 'credentials in the URL' };
  }
  if (url.hostname === '') return { kind: 'unsupported', reason: 'no host' };

  const host = url.hostname.toLowerCase();

  // Path gateway: /ipfs/<cid>[/path]
  const pathGateway = /^\/ipfs\/([^/]+)(\/.*)?$/.exec(url.pathname);
  if (pathGateway && isCid(pathGateway[1]!)) {
    const path = cleanPath(pathGateway[2] ?? '');
    if (path === null) return { kind: 'unsupported', reason: 'bad path' };
    return {
      kind: 'ipfs',
      cid: pathGateway[1]!,
      path,
      originalOrigin: url.origin,
      originalUrl: url.toString(),
    };
  }

  // Subdomain gateway: <cid>.ipfs.<host>[/path]
  const labels = host.split('.');
  if (labels.length >= 3 && labels[1] === 'ipfs' && isCid(labels[0]!)) {
    const path = cleanPath(url.pathname);
    if (path === null) return { kind: 'unsupported', reason: 'bad path' };
    return {
      kind: 'ipfs',
      cid: labels[0]!,
      path,
      originalOrigin: url.origin,
      originalUrl: url.toString(),
    };
  }

  // Arweave gateway: arweave.net/<id>[/path]
  if (host === 'arweave.net' || host === 'www.arweave.net') {
    const m = /^\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (m && ARWEAVE_ID.test(m[1]!)) {
      const path = cleanPath(m[2] ?? '');
      if (path === null) return { kind: 'unsupported', reason: 'bad path' };
      return {
        kind: 'arweave',
        id: m[1]!,
        path,
        originalOrigin: url.origin,
        originalUrl: url.toString(),
      };
    }
  }

  return { kind: 'http', url: url.toString() };
}
