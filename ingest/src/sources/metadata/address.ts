/**
 * Address classifier for the private-address block. The metadata URI comes
 * from on-chain data that anyone can write, so a coin can point us at
 * `http://169.254.169.254/` or at a name that resolves to an internal host.
 * `classifyAddress` says what an IP address is; `isBlockedAddress` is true for
 * everything that is not an ordinary public unicast address.
 *
 * IPv4-mapped IPv6 (`::ffff:10.0.0.1`, also written `::ffff:a00:1`), NAT64
 * (`64:ff9b::/96`) and 6to4 (`2002::/16`) addresses are judged by the IPv4
 * address they carry.
 */
import net from 'node:net';

export type AddressClass =
  | 'public'
  | 'loopback'
  | 'private'
  | 'link-local'
  | 'unique-local'
  | 'unspecified'
  | 'carrier-grade-nat'
  | 'multicast'
  | 'reserved'
  | 'invalid';

function parseIPv4(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

function classifyIPv4(o: readonly number[]): AddressClass {
  const [a, b, c] = o as [number, number, number, number];
  if (a === 0) return 'unspecified'; // 0.0.0.0/8
  if (a === 10) return 'private';
  if (a === 127) return 'loopback';
  if (a === 100 && b >= 64 && b <= 127) return 'carrier-grade-nat';
  if (a === 169 && b === 254) return 'link-local';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  if (a === 192 && b === 0 && c === 0) return 'reserved'; // IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return 'reserved'; // documentation
  if (a === 198 && (b === 18 || b === 19)) return 'reserved'; // benchmarking
  if (a === 198 && b === 51 && c === 100) return 'reserved'; // documentation
  if (a === 203 && b === 0 && c === 113) return 'reserved'; // documentation
  if (a >= 224 && a <= 239) return 'multicast';
  if (a >= 240) return 'reserved'; // includes 255.255.255.255
  return 'public';
}

/** Expands an IPv6 address to eight 16-bit groups, or null when it is not valid. */
function parseIPv6(input: string): number[] | null {
  let ip = input;
  const zone = ip.indexOf('%');
  if (zone >= 0) ip = ip.slice(0, zone);
  if (!net.isIPv6(input)) return null;

  // A trailing dotted IPv4 part stands for two groups.
  const lastColon = ip.lastIndexOf(':');
  const tail = ip.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIPv4(tail);
    if (!v4) return null;
    const hi = ((v4[0]! << 8) | v4[1]!).toString(16);
    const lo = ((v4[2]! << 8) | v4[3]!).toString(16);
    ip = `${ip.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  let groups: string[];
  if (halves.length === 2) {
    const missing = 8 - head.length - rest.length;
    if (missing < 0) return null;
    groups = [...head, ...Array<string>(missing).fill('0'), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const out: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out;
}

function v4FromGroups(hi: number, lo: number): number[] {
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
}

function classifyIPv6(g: readonly number[]): AddressClass {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const firstSixZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0;
  if (firstSixZero && g6 === 0 && g7 === 0) return 'unspecified'; // ::
  if (firstSixZero && g6 === 0 && g7 === 1) return 'loopback'; // ::1
  // IPv4-mapped ::ffff:a.b.c.d
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return classifyIPv4(v4FromGroups(g6, g7));
  }
  // IPv4-compatible ::a.b.c.d (deprecated) is never a legitimate public target.
  if (firstSixZero) return 'reserved';
  // NAT64 64:ff9b::/96 carries an IPv4 address.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return classifyIPv4(v4FromGroups(g6, g7));
  }
  // 6to4 2002::/16 carries an IPv4 address in the next 32 bits.
  if (g0 === 0x2002) return classifyIPv4(v4FromGroups(g1, g2));
  if ((g0 & 0xffc0) === 0xfe80) return 'link-local'; // fe80::/10
  if ((g0 & 0xfe00) === 0xfc00) return 'unique-local'; // fc00::/7
  if ((g0 & 0xff00) === 0xff00) return 'multicast'; // ff00::/8
  if (g0 === 0x2001 && g1 === 0x0db8) return 'reserved'; // documentation
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return 'reserved'; // discard-only
  return 'public';
}

export function classifyAddress(ip: string): AddressClass {
  // URL hostnames wrap IPv6 literals in brackets.
  const bare = ip.startsWith('[') && ip.endsWith(']') ? ip.slice(1, -1) : ip;
  if (net.isIPv4(bare)) {
    const o = parseIPv4(bare);
    return o ? classifyIPv4(o) : 'invalid';
  }
  const g = parseIPv6(bare);
  if (g) return classifyIPv6(g);
  return 'invalid';
}

/** True for anything that is not an ordinary public unicast address, and for anything unparseable. */
export function isBlockedAddress(ip: string): boolean {
  return classifyAddress(ip) !== 'public';
}

/** True when a URL hostname is an IP literal (IPv6 literals keep their brackets in `URL.hostname`). */
export function isIpLiteral(hostname: string): boolean {
  const bare =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  return net.isIP(bare) !== 0;
}
