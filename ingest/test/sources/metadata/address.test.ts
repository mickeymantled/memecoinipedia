import { describe, expect, it } from 'vitest';
import {
  classifyAddress,
  isBlockedAddress,
  isIpLiteral,
} from '../../../src/sources/metadata/address.js';

describe('classifyAddress', () => {
  const cases: Array<[string, string]> = [
    // IPv4
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['10.0.0.1', 'private'],
    ['10.255.255.255', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['172.15.255.255', 'public'],
    ['172.32.0.1', 'public'],
    ['192.168.1.1', 'private'],
    ['169.254.169.254', 'link-local'],
    ['0.0.0.0', 'unspecified'],
    ['100.64.0.1', 'carrier-grade-nat'],
    ['100.127.255.255', 'carrier-grade-nat'],
    ['100.128.0.1', 'public'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'reserved'],
    ['198.18.0.1', 'reserved'],
    ['8.8.8.8', 'public'],
    ['1.1.1.1', 'public'],
    ['93.184.216.34', 'public'],
    // IPv6
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['[::1]', 'loopback'],
    ['fe80::1', 'link-local'],
    ['febf::1', 'link-local'],
    ['fc00::1', 'unique-local'],
    ['fd12:3456:789a::1', 'unique-local'],
    ['ff02::1', 'multicast'],
    ['2001:db8::1', 'reserved'],
    ['2606:4700:4700::1111', 'public'],
    ['2001:4860:4860::8888', 'public'],
    // IPv4-mapped IPv6, dotted and hex
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:7f00:1', 'loopback'],
    ['::ffff:10.0.0.1', 'private'],
    ['::ffff:a00:1', 'private'],
    ['::ffff:169.254.169.254', 'link-local'],
    ['::ffff:a9fe:a9fe', 'link-local'],
    ['::ffff:192.168.0.1', 'private'],
    ['::ffff:8.8.8.8', 'public'],
    ['0:0:0:0:0:ffff:7f00:1', 'loopback'],
    // NAT64 and 6to4 carry an IPv4 address
    ['64:ff9b::7f00:1', 'loopback'],
    ['64:ff9b::808:808', 'public'],
    ['2002:7f00:1::1', 'loopback'],
    ['2002:808:808::1', 'public'],
    // junk
    ['not-an-ip', 'invalid'],
    ['999.1.1.1', 'invalid'],
    ['1.2.3', 'invalid'],
    ['', 'invalid'],
  ];
  for (const [ip, expected] of cases) {
    it(`${ip || '(empty)'} is ${expected}`, () => {
      expect(classifyAddress(ip)).toBe(expected);
    });
  }
});

describe('isBlockedAddress', () => {
  it('blocks everything but public addresses, and junk', () => {
    expect(isBlockedAddress('8.8.8.8')).toBe(false);
    expect(isBlockedAddress('2606:4700:4700::1111')).toBe(false);
    expect(isBlockedAddress('127.0.0.1')).toBe(true);
    expect(isBlockedAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedAddress('garbage')).toBe(true);
  });
});

describe('isIpLiteral', () => {
  it('recognises IPv4 and bracketed IPv6 literals only', () => {
    expect(isIpLiteral('127.0.0.1')).toBe(true);
    expect(isIpLiteral('[::1]')).toBe(true);
    expect(isIpLiteral('::1')).toBe(true);
    expect(isIpLiteral('example.com')).toBe(false);
    expect(isIpLiteral('localhost')).toBe(false);
  });
});
