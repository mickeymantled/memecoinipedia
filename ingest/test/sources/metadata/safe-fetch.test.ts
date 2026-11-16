import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BlockedAddressError,
  MetadataFetcher,
  UnsafeUrlError,
  assertSafeUrl,
  createSafeFetch,
  createSafeLookup,
} from '../../../src/sources/metadata/index.js';

describe('assertSafeUrl', () => {
  const ok = [
    'https://example.com/a',
    'http://example.com:8080/a',
    'https://8.8.8.8/x',
    'https://[2606:4700:4700::1111]/',
  ];
  for (const u of ok)
    it(`allows ${u}`, () => expect(() => assertSafeUrl(new URL(u))).not.toThrow());

  const blocked = [
    'http://127.0.0.1/',
    'http://127.1/', // normalised by the URL parser
    'http://2130706433/', // decimal form of 127.0.0.1
    'http://0x7f.0.0.1/',
    'http://localhost/',
    'http://foo.localhost/',
    'http://10.1.2.3/',
    'http://172.20.0.1/',
    'http://192.168.0.10/',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:a9fe:a9fe]/',
    'http://[fe80::1]/',
    'http://[fd00::1]/',
    'http://0.0.0.0/',
  ];
  for (const u of blocked) {
    it(`blocks ${u}`, () => {
      expect(() => assertSafeUrl(new URL(u))).toThrow(BlockedAddressError);
    });
  }

  it('refuses other schemes and credentials', () => {
    expect(() => assertSafeUrl(new URL('file:///etc/passwd'))).toThrow(UnsafeUrlError);
    expect(() => assertSafeUrl(new URL('ftp://example.com/'))).toThrow(UnsafeUrlError);
    expect(() => assertSafeUrl(new URL('https://user:pw@example.com/'))).toThrow(UnsafeUrlError);
    expect(() => assertSafeUrl(new URL('https://user@example.com/'))).toThrow(UnsafeUrlError);
  });
});

function lookup(resolver: Parameters<typeof createSafeLookup>[0], options = {}) {
  return new Promise<{ err: Error | null; address: unknown; family: unknown }>((resolve) => {
    createSafeLookup(resolver)('some.name', options, (err, address, family) =>
      resolve({ err, address, family }),
    );
  });
}

describe('createSafeLookup (the check at connection time)', () => {
  it('passes a public answer through', async () => {
    const r = await lookup(async () => [{ address: '93.184.216.34', family: 4 }]);
    expect(r.err).toBeNull();
    expect(r.address).toBe('93.184.216.34');
    expect(r.family).toBe(4);
  });

  it('returns the list when the caller asks for all addresses', async () => {
    const r = await lookup(async () => [{ address: '93.184.216.34', family: 4 }], { all: true });
    expect(r.address).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('rejects a name that resolves to a private address', async () => {
    const r = await lookup(async () => [{ address: '10.0.0.5', family: 4 }]);
    expect(r.err).toBeInstanceOf(BlockedAddressError);
  });

  it('rejects when any one of several answers is blocked', async () => {
    const r = await lookup(
      async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '::ffff:127.0.0.1', family: 6 },
      ],
      { all: true },
    );
    expect(r.err).toBeInstanceOf(BlockedAddressError);
  });

  it('rejects a name that resolves to loopback, link-local or unique-local', async () => {
    for (const address of ['127.0.0.1', '169.254.169.254', '::1', 'fd00::1', 'fe80::1']) {
      const r = await lookup(async () => [{ address, family: address.includes(':') ? 6 : 4 }]);
      expect(r.err, address).toBeInstanceOf(BlockedAddressError);
    }
  });

  it('passes a resolver failure on as an error', async () => {
    const r = await lookup(async () => {
      throw new Error('ENOTFOUND');
    });
    expect(r.err?.message).toBe('ENOTFOUND');
  });
});

describe('the real connection path, against a local server', () => {
  let server: http.Server;
  let port: number;
  let hits = 0;

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      hits++;
      res.setHeader('content-type', 'application/json');
      res.end('{"name":"internal"}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('a name that resolves to 127.0.0.1 is refused at connect time, and the server sees nothing', async () => {
    hits = 0;
    // Rebinding: the name looks fine to a URL check, then resolves to loopback.
    const safe = createSafeFetch(async () => [{ address: '127.0.0.1', family: 4 }]);
    const err = await safe(`http://rebind.example.test:${port}/x`, {
      method: 'GET',
      headers: {},
      redirect: 'manual',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BlockedAddressError);
    expect(hits).toBe(0);
  });

  it('the fetcher reports a loopback IP-literal URI as unsupported and sends nothing', async () => {
    hits = 0;
    const r = await new MetadataFetcher().fetch(`http://127.0.0.1:${port}/meta.json`);
    expect(r.outcome).toBe('unsupported_uri');
    expect(r.attempts[0]?.result).toBe('blocked');
    expect(hits).toBe(0);
  });

  it('the fetcher refuses a rebinding name through the default connection path', async () => {
    hits = 0;
    const r = await new MetadataFetcher({
      resolver: async () => [{ address: '127.0.0.1', family: 4 }],
    }).fetch(`http://rebind.example.test:${port}/meta.json`);
    expect(r.outcome).toBe('unsupported_uri');
    expect(r.attempts[0]?.result).toBe('blocked');
    expect(r.attempts[0]?.requests).toBe(1);
    expect(hits).toBe(0);
  });
});
