import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CANDIDATE_GATEWAYS,
  gatewayBase,
  median,
  parseCidList,
  probeOnce,
  runProbe,
} from '../../scripts/lib/gateway-probe.js';

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../../scripts/gateway-probe.ts', import.meta.url));

// Every CID below is a made-up name that the fake server maps to a behaviour. Only a local server
// is ever asked.
const OK = 'bafyokokokokokokok';
const OK_PATH = 'bafyokokokokokokok/metadata.json';
const MISSING = 'bafynotfoundnotfound';
const BUSY = 'bafyratelimitedlimited';
const SLOW = 'bafyslowslowslowslow';
const HTML = 'bafyhtmlhtmlhtmlhtml';
const MOVED = 'bafymovedmovedmoved';
const HUGE = 'bafyhugehugehugehuge';
const BROKEN = 'bafybrokenbrokenbroken';

describe('gateway probe, against a local fake server', () => {
  let server: Server;
  let base: string;
  const seen: Array<{ url: string; ua: string | undefined; method: string | undefined }> = [];
  const sent = { huge: 0 };

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res) => {
      seen.push({ url: req.url ?? '', ua: req.headers['user-agent'], method: req.method });
      const path = (req.url ?? '').replace(/^\/ipfs\//, '');
      if (path.startsWith(OK)) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"name":"x"}');
      } else if (path === MISSING) {
        res.writeHead(404).end('nope');
      } else if (path === BUSY) {
        res.writeHead(429).end('slow down');
      } else if (path === SLOW) {
        // Never answers within the test's timeout.
        setTimeout(() => res.end('{}'), 2000);
      } else if (path === HTML) {
        res.writeHead(200, { 'content-type': 'text/html' }).end('<html></html>');
      } else if (path === MOVED) {
        res.writeHead(302, { location: '/ipfs/' + OK }).end();
      } else if (path === HUGE) {
        res.writeHead(200, { 'content-type': 'application/json' });
        const chunk = Buffer.alloc(16 * 1024, 0x20);
        let n = 0;
        const timer = setInterval(() => {
          if (res.destroyed || n++ >= 200) {
            clearInterval(timer);
            res.end();
            return;
          }
          sent.huge += chunk.length;
          res.write(chunk);
        }, 1);
        res.on('close', () => clearInterval(timer));
      } else if (path === BROKEN) {
        req.socket.destroy();
      } else {
        res.writeHead(500).end();
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  it('classifies each kind of answer', async () => {
    const o = { timeoutMs: 300 };
    expect((await probeOnce(base, OK, o)).result).toBe('json');
    expect((await probeOnce(base, OK_PATH, o)).result).toBe('json');
    expect((await probeOnce(base, MISSING, o)).result).toBe('not_found');
    expect((await probeOnce(base, BUSY, o)).result).toBe('rate_limited');
    expect((await probeOnce(base, SLOW, o)).result).toBe('timeout');
    expect((await probeOnce(base, HTML, o)).result).toBe('other');
    expect((await probeOnce(base, MOVED, o)).result).toBe('other'); // redirect not followed
    expect((await probeOnce(base, BROKEN, o)).result).toBe('other');
    expect((await probeOnce(base, 'bafyunknownunknownx', o)).result).toBe('other'); // a 500
  });

  it('sends a GET with a generic user agent, and does not follow a redirect', async () => {
    seen.length = 0;
    await probeOnce(base, MOVED, { timeoutMs: 300 });
    expect(seen).toHaveLength(1); // the redirect target was not requested
    expect(seen[0]).toMatchObject({ method: 'GET', ua: 'gateway-probe/1.0' });
  });

  it('reads at most 64 KB of the body and drops the rest', async () => {
    sent.huge = 0;
    const out = await probeOnce(base, HUGE, { timeoutMs: 2000 });
    expect(out.result).toBe('other'); // cut off: not a complete JSON answer
    expect(sent.huge).toBeLessThan(200 * 16 * 1024); // the stream was cancelled early
  });

  it('tallies per gateway and takes the median latency of the JSON answers', async () => {
    seen.length = 0;
    const clock = { t: 0 };
    const tallies = await runProbe({
      gateways: [base, `${base}/`],
      cids: [OK, MISSING, BUSY, HTML, OK_PATH],
      minIntervalMs: 0,
      timeoutMs: 300,
    });
    for (const t of tallies) {
      expect(t).toMatchObject({ json: 2, notFound: 1, rateLimited: 1, timeout: 0, other: 1 });
      expect(t.medianLatencyMs).not.toBeNull();
    }
    expect(seen).toHaveLength(10);
    void clock;
  });

  it('asks each gateway at most once a second', async () => {
    const t = { now: 0 };
    const starts: number[] = [];
    await runProbe({
      gateways: [base],
      cids: [OK, OK, OK, OK],
      minIntervalMs: 1000,
      now: () => t.now,
      sleep: async (ms) => {
        t.now += ms;
      },
      fetch: (async () => {
        starts.push(t.now);
        t.now += 100; // each answer takes 100 ms
        return new Response('{}', { status: 200 });
      }) as typeof fetch,
    });
    expect(starts).toEqual([0, 1000, 2000, 3000]);
  });

  it('does not request anything without --confirm, and says what it would ask', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'probe-'));
    const file = join(dir, 'cids.txt');
    await writeFile(file, `# comment\n${OK}\n\n${OK_PATH}\n`);
    seen.length = 0;
    const { stdout } = await run(
      process.execPath,
      ['--import', 'tsx', SCRIPT, '--file', file, '--gateway', base],
      { env: { PATH: process.env['PATH'] ?? '' } },
    );
    expect(seen).toHaveLength(0);
    expect(stdout).toMatch(/dry run/i);
    expect(stdout).toContain(`2 CIDs x ${CANDIDATE_GATEWAYS.length + 1} gateways`);
    expect(stdout).toContain('--confirm');
  });
});

describe('gateway probe helpers', () => {
  it('lists the candidates the issue names', () => {
    expect(CANDIDATE_GATEWAYS).toEqual([
      'ipfs.filebase.io',
      'gateway.pinata.cloud',
      'ipfs.io',
      'dweb.link',
      'w3s.link',
      'nftstorage.link',
      '4everland.io',
      'gateway.lighthouse.storage',
    ]);
  });
  it('turns a host into an https base and keeps a full URL', () => {
    expect(gatewayBase('ipfs.io')).toBe('https://ipfs.io');
    expect(gatewayBase('http://127.0.0.1:8080/')).toBe('http://127.0.0.1:8080');
  });
  it('reads a CID list and refuses anything that is not a CID or cid/path', () => {
    expect(
      parseCidList(
        '# c\nbafyaaaaaaaaaa\n\nQmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG/1.json\n',
      ),
    ).toEqual(['bafyaaaaaaaaaa', 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG/1.json']);
    expect(() => parseCidList('https://evil.example/x')).toThrow(/Line 1/);
  });
  it('median', () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
});
