/**
 * The private-address block, in two parts.
 *
 * 1. `assertSafeUrl` runs before each request (and each redirect hop): scheme
 *    http or https only, no credentials, and an IP-literal host must not be a
 *    loopback, private, link-local, unique-local or otherwise non-public
 *    address (IPv4 and IPv6, IPv4-mapped IPv6 included). Node does not call
 *    the DNS lookup for an IP literal, so this check is the only one that sees
 *    those hosts.
 * 2. `createSafeLookup` is the DNS lookup of the HTTP agent. It runs at
 *    connection time, on the exact addresses the socket is about to use, so a
 *    name cannot pass a check and then resolve somewhere else (DNS rebinding).
 *    One blocked address among the answers rejects the whole lookup.
 */
import dns from 'node:dns';
import type { LookupFunction } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import type { GetFetchLike } from '../http.js';
import { classifyAddress, isBlockedAddress, isIpLiteral, type AddressClass } from './address.js';

export class BlockedAddressError extends Error {
  readonly retryable = false;
  readonly host: string;
  readonly reason: string;

  constructor(host: string, reason: string) {
    super(`Refusing to connect to ${host}: ${reason}`);
    this.name = 'BlockedAddressError';
    this.host = host;
    this.reason = reason;
  }
}

/** The URL itself is not allowed (scheme, credentials). Distinct from a blocked address. */
export class UnsafeUrlError extends Error {
  readonly retryable = false;
  readonly reason: string;

  constructor(reason: string) {
    super(`Unsafe URL: ${reason}`);
    this.name = 'UnsafeUrlError';
    this.reason = reason;
  }
}

/** Throws `UnsafeUrlError` or `BlockedAddressError` when the URL must not be requested. */
export function assertSafeUrl(url: URL): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeUrlError(`scheme ${url.protocol} is not allowed`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new UnsafeUrlError('credentials in the URL are not allowed');
  }
  const host = url.hostname;
  if (host === '') throw new UnsafeUrlError('no host');
  if (isIpLiteral(host)) {
    const kind: AddressClass = classifyAddress(host);
    if (kind !== 'public') throw new BlockedAddressError(host, `${kind} address`);
    return;
  }
  const lower = host.toLowerCase().replace(/\.$/, '');
  if (lower === 'localhost' || lower.endsWith('.localhost')) {
    throw new BlockedAddressError(host, 'loopback name');
  }
}

export type Resolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

const systemResolver: Resolver = async (hostname) =>
  dns.promises.lookup(hostname, { all: true, verbatim: true });

/**
 * A `lookup` function for `net.connect`. It resolves the name, rejects when any
 * answer is a non-public address, and otherwise hands the addresses to the socket.
 */
export function createSafeLookup(resolver: Resolver = systemResolver): LookupFunction {
  return (hostname, options, callback) => {
    resolver(hostname).then(
      (answers) => {
        if (answers.length === 0) {
          callback(
            Object.assign(new Error(`No address for ${hostname}`), { code: 'ENOTFOUND' }),
            [],
          );
          return;
        }
        const bad = answers.find((a) => isBlockedAddress(a.address));
        if (bad) {
          callback(
            new BlockedAddressError(
              hostname,
              `resolves to a ${classifyAddress(bad.address)} address`,
            ),
            [],
          );
          return;
        }
        const wanted =
          options.family === 4 || options.family === 'IPv4'
            ? 4
            : options.family === 6 || options.family === 'IPv6'
              ? 6
              : 0;
        const usable = wanted === 0 ? answers : answers.filter((a) => a.family === wanted);
        if (usable.length === 0) {
          callback(
            Object.assign(new Error(`No address for ${hostname}`), { code: 'ENOTFOUND' }),
            [],
          );
          return;
        }
        if (options.all) callback(null, usable);
        else callback(null, usable[0]!.address, usable[0]!.family);
      },
      (err: unknown) => callback(err instanceof Error ? err : new Error('DNS lookup failed'), []),
    );
  };
}

/**
 * A GET fetch whose connections go through the safe lookup. Redirects are never
 * followed here (`getFollowingRedirects` does that, checking every hop).
 */
export function createSafeFetch(resolver?: Resolver): GetFetchLike {
  const agent = new Agent({ connect: { lookup: createSafeLookup(resolver) } });
  return async (input, init) => {
    try {
      const res = await undiciFetch(input, {
        method: 'GET',
        headers: init.headers,
        signal: init.signal,
        redirect: 'manual',
        dispatcher: agent,
      });
      return { status: res.status, headers: res.headers, body: res.body };
    } catch (err) {
      // undici wraps a lookup failure as `TypeError: fetch failed`. Surface a refusal as itself.
      const cause = err instanceof Error ? err.cause : undefined;
      if (cause instanceof BlockedAddressError) throw cause;
      throw err;
    }
  };
}
