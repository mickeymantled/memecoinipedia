import { describe, expect, it } from 'vitest';
import { normalizeSocialUrl, parseTokenMetadata } from '../../../src/sources/metadata/parse.js';
import { fixture } from '../net-helpers.js';

describe('normalizeSocialUrl', () => {
  it('turns http into https and keeps the rest', () => {
    expect(normalizeSocialUrl('http://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(normalizeSocialUrl('https://x.com/foo')).toBe('https://x.com/foo');
    expect(normalizeSocialUrl('  https://t.me/foo  ')).toBe('https://t.me/foo');
  });

  it('drops anything that is not a valid http(s) URL', () => {
    for (const v of [
      '',
      'x.com/foo',
      '@foo',
      'javascript:alert(1)',
      'ftp://x.com',
      'ipfs://abc',
      'data:text/html,hi',
      'https://',
      'not a url',
      'https://u:p@x.com/',
      12,
      null,
      {},
      ['https://x.com'],
    ]) {
      expect(normalizeSocialUrl(v), String(v)).toBeNull();
    }
    expect(normalizeSocialUrl(`https://example.com/${'a'.repeat(3000)}`)).toBeNull();
  });
});

describe('parseTokenMetadata', () => {
  it('reads a 2024 coin with socials', () => {
    const json = fixture('metadata', 'token-2024');
    expect(parseTokenMetadata(json)).toEqual({
      name: 'Vincent Van Goat',
      symbol: 'VANGOAT',
      description: json.description,
      image: 'https://cf-ipfs.com/ipfs/QmTNWvHkup5HUtpwkQ2Hut1z3fGBgBFVD4w9GEaCA8ZNHC',
      twitter: 'https://x.com/TheVincentVanG',
      telegram: 'https://t.me/VanGoatPortal',
      website: 'https://oncyber.io/vangoat',
    });
  });

  it('reads 2025 and 2026 coins that lack some socials', () => {
    const a = parseTokenMetadata(fixture('metadata', 'token-2025'));
    expect(a.twitter).toBeNull();
    expect(a.telegram).toBeNull();
    expect(a.website).toMatch(/^https:\/\/www\.ndtv\.com\//);
    const b = parseTokenMetadata(fixture('metadata', 'token-2026'));
    expect(b.name).toBe('MissRose');
    expect(b.twitter).toMatch(/^https:\/\/x\.com\//);
    expect(b.telegram).toBeNull();
  });

  it('turns fields of the wrong type into null', () => {
    const m = parseTokenMetadata({
      name: 5,
      symbol: ['x'],
      description: null,
      image: { a: 1 },
      twitter: 7,
    });
    expect(m).toEqual({
      name: null,
      symbol: null,
      description: null,
      image: null,
      twitter: null,
      telegram: null,
      website: null,
    });
  });

  it('keeps an ipfs:// image, drops a script image', () => {
    expect(parseTokenMetadata({ image: 'ipfs://bafkreiabc' }).image).toBe('ipfs://bafkreiabc');
    expect(parseTokenMetadata({ image: 'javascript:alert(1)' }).image).toBeNull();
    expect(parseTokenMetadata({ image: 'data:image/png;base64,AAAA' }).image).toBeNull();
  });
});
