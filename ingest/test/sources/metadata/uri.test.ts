import { describe, expect, it } from 'vitest';
import { isCid, parseMetadataUri } from '../../../src/sources/metadata/uri.js';

const V0 = 'QmYfe8zVGHA1heej47AkBX3Nnetg2h2kqj5yymz1xyKeHb';
const V1 = 'bafkreicauvgfgkzpt66rewh6fih2by3mkqugwcx6zlgkx52gzkzohnreye';
const AR = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ'; // 43 base64url characters

describe('isCid', () => {
  it('knows CIDv0 and CIDv1', () => {
    expect(V0).toHaveLength(46);
    expect(isCid(V0)).toBe(true);
    expect(isCid(V1)).toBe(true);
    expect(isCid('bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi')).toBe(true);
  });
  it('rejects the wrong length or alphabet', () => {
    expect(isCid(V0.slice(0, 45))).toBe(false);
    expect(isCid(V0 + 'a')).toBe(false);
    expect(isCid('Qm' + '0'.repeat(44))).toBe(false); // 0 is not base58
    expect(isCid('bafk' + 'A'.repeat(50))).toBe(false); // base32 here is lowercase
    expect(isCid('hello')).toBe(false);
  });
});

describe('parseMetadataUri', () => {
  it('ipfs:// with CIDv0 and CIDv1', () => {
    expect(parseMetadataUri(`ipfs://${V0}`)).toEqual({
      kind: 'ipfs',
      cid: V0,
      path: '',
      originalOrigin: null,
      originalUrl: null,
    });
    expect(parseMetadataUri(`ipfs://${V1}`)).toMatchObject({ kind: 'ipfs', cid: V1 });
  });

  it('ipfs:// with a path, and the ipfs://ipfs/ form', () => {
    expect(parseMetadataUri(`ipfs://${V0}/meta.json`)).toMatchObject({
      cid: V0,
      path: '/meta.json',
    });
    expect(parseMetadataUri(`ipfs://ipfs/${V0}/a/b.json`)).toMatchObject({
      cid: V0,
      path: '/a/b.json',
    });
  });

  it('path gateways, with and without a path', () => {
    expect(parseMetadataUri(`https://ipfs.io/ipfs/${V0}`)).toEqual({
      kind: 'ipfs',
      cid: V0,
      path: '',
      originalOrigin: 'https://ipfs.io',
      originalUrl: expect.any(String),
    });
    expect(parseMetadataUri(`https://cf-ipfs.com/ipfs/${V0}/x.json`)).toMatchObject({
      cid: V0,
      path: '/x.json',
      originalOrigin: 'https://cf-ipfs.com',
      originalUrl: expect.any(String),
    });
    expect(parseMetadataUri(`https://gateway.ipfs.io/ipfs/${V1}`)).toMatchObject({ cid: V1 });
  });

  it('subdomain gateways', () => {
    expect(parseMetadataUri(`https://${V1}.ipfs.dweb.link/`)).toEqual({
      kind: 'ipfs',
      cid: V1,
      path: '',
      originalOrigin: `https://${V1}.ipfs.dweb.link`,
      originalUrl: expect.any(String),
    });
    expect(parseMetadataUri(`https://${V1}.ipfs.w3s.link/data.json`)).toMatchObject({
      cid: V1,
      path: '/data.json',
    });
  });

  it('Arweave: ar:// and arweave.net', () => {
    expect(parseMetadataUri(`ar://${AR}`)).toEqual({
      kind: 'arweave',
      id: AR,
      path: '',
      originalOrigin: null,
      originalUrl: null,
    });
    expect(parseMetadataUri(`https://arweave.net/${AR}`)).toEqual({
      kind: 'arweave',
      id: AR,
      path: '',
      originalOrigin: 'https://arweave.net',
      originalUrl: expect.any(String),
    });
    expect(parseMetadataUri(`https://arweave.net/${AR}/x`)).toMatchObject({ path: '/x' });
  });

  it('plain https and http', () => {
    expect(parseMetadataUri('https://example.com/meta.json')).toEqual({
      kind: 'http',
      url: 'https://example.com/meta.json',
    });
    expect(parseMetadataUri('http://example.com/meta.json')).toMatchObject({ kind: 'http' });
    // /ipfs/ with something that is not a CID is just a URL.
    expect(parseMetadataUri('https://example.com/ipfs/notacid')).toMatchObject({ kind: 'http' });
  });

  it('trims surrounding whitespace', () => {
    expect(parseMetadataUri(`  ipfs://${V0}\n`)).toMatchObject({ kind: 'ipfs' });
  });

  const unsupported: Array<[string, string]> = [
    ['', 'empty'],
    ['   ', 'empty'],
    ['ftp://example.com/x', 'scheme'],
    ['file:///etc/passwd', 'scheme'],
    ['data:application/json;base64,e30=', 'scheme'],
    ['javascript:alert(1)', 'scheme'],
    ['gopher://example.com/', 'scheme'],
    ['justsometext', 'absolute'],
    ['/relative/path.json', 'absolute'],
    ['ipfs://not-a-cid', 'CID'],
    [`ipfs://${V0.slice(0, 40)}`, 'CID'],
    ['ar://tooshort', 'Arweave'],
    ['https://user:pw@example.com/x', 'credentials'],
    ['https://user@example.com/x', 'credentials'],
    [`ipfs://${V0}/../secret`, 'path'],
    ['https://example.com/a b', 'whitespace'],
    [`https://example.com/${'a'.repeat(3000)}`, 'long'],
  ];
  for (const [uri, hint] of unsupported) {
    it(`unsupported: ${uri.slice(0, 40) || '(empty)'}`, () => {
      const r = parseMetadataUri(uri);
      expect(r.kind).toBe('unsupported');
      if (r.kind === 'unsupported') expect(r.reason.toLowerCase()).toContain(hint.toLowerCase());
    });
  }
});
