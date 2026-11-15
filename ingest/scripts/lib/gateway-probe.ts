/**
 * The logic of `scripts/gateway-probe.ts`: ask each candidate IPFS gateway for each CID once, and
 * count what came back. It writes nothing to any database and changes no code path of the worker.
 *
 * Per gateway and CID: one GET with a timeout (10 seconds), redirects not followed, the body read up
 * to 64 KB and thrown away. Each gateway is asked at most once a second; the gateways are asked
 * side by side, so the run takes about as long as the CID list is long, in seconds.
 */

/** Gateways tried unless the caller says otherwise (hosts; the scheme is https). */
export const CANDIDATE_GATEWAYS: readonly string[] = [
  'ipfs.filebase.io',
  'gateway.pinata.cloud',
  'ipfs.io',
  'dweb.link',
  'w3s.link',
  'nftstorage.link',
  '4everland.io',
  'gateway.lighthouse.storage',
];

export const PROBE_TIMEOUT_MS = 10_000;
export const PROBE_MAX_BODY_BYTES = 64 * 1024;
export const PROBE_MIN_INTERVAL_MS = 1000;
export const PROBE_USER_AGENT = 'gateway-probe/1.0';

export type ProbeResult = 'json' | 'not_found' | 'rate_limited' | 'timeout' | 'other';

export interface ProbeOutcome {
  result: ProbeResult;
  /** Milliseconds from sending the request to the end of the read. */
  latencyMs: number;
}

export interface GatewayTally {
  gateway: string;
  json: number;
  notFound: number;
  rateLimited: number;
  timeout: number;
  other: number;
  /** Median latency over the answers that were valid JSON; null when there were none. */
  medianLatencyMs: number | null;
}

/** The base URL of a gateway: a host becomes `https://host`; a full http(s) URL is kept (no trailing slash). */
export function gatewayBase(gateway: string): string {
  const g = gateway.trim();
  const base = /^https?:\/\//i.test(g) ? g : `https://${g}`;
  return base.replace(/\/+$/, '');
}

/** One CID, or `cid/path`, per line. Blank lines and lines starting with `#` are skipped. */
export function parseCidList(text: string): string[] {
  const out: string[] = [];
  for (const [i, line] of text.split(/\r?\n/).entries()) {
    const l = line.trim();
    if (l === '' || l.startsWith('#')) continue;
    // Only a CID and an optional path: never a URL, so the list cannot point a request elsewhere.
    if (!/^[A-Za-z0-9]{10,}(\/[A-Za-z0-9._~%!$&'()*+,;=:@/-]*)?$/.test(l)) {
      throw new Error(`Line ${i + 1} is not a CID or "cid/path"`);
    }
    out.push(l);
  }
  return out;
}

/** Reads at most `max` bytes of the body and drops the rest. */
async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  max: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!body) return { bytes: new Uint8Array(0), truncated: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
    if (total > max) {
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  const all = new Uint8Array(Math.min(total, max));
  let at = 0;
  for (const c of chunks) {
    const take = Math.min(c.byteLength, all.byteLength - at);
    all.set(c.subarray(0, take), at);
    at += take;
    if (at >= all.byteLength) break;
  }
  return { bytes: all, truncated };
}

export interface ProbeOneOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxBodyBytes?: number;
  now?: () => number;
}

/** One GET of `<base>/ipfs/<cidPath>`. Never throws. */
export async function probeOnce(
  base: string,
  cidPath: string,
  o: ProbeOneOptions = {},
): Promise<ProbeOutcome> {
  const doFetch = o.fetch ?? fetch;
  const now = o.now ?? (() => performance.now());
  const started = now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), o.timeoutMs ?? PROBE_TIMEOUT_MS);
  const finish = (result: ProbeResult): ProbeOutcome => ({ result, latencyMs: now() - started });
  try {
    const res = await doFetch(`${base}/ipfs/${cidPath}`, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'user-agent': PROBE_USER_AGENT, accept: 'application/json' },
    });
    if (res.status === 404 || res.status === 410) {
      await res.body?.cancel().catch(() => undefined);
      return finish('not_found');
    }
    if (res.status === 429) {
      await res.body?.cancel().catch(() => undefined);
      return finish('rate_limited');
    }
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => undefined);
      return finish('other'); // includes a redirect, which is not followed
    }
    const { bytes, truncated } = await readCapped(res.body, o.maxBodyBytes ?? PROBE_MAX_BODY_BYTES);
    if (truncated) return finish('other');
    try {
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      return finish('other');
    }
    return finish('json');
  } catch (err) {
    if (controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
      return finish('timeout');
    }
    return finish('other');
  } finally {
    clearTimeout(timer);
  }
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export interface RunProbeOptions extends ProbeOneOptions {
  gateways: readonly string[];
  cids: readonly string[];
  /** Least time between the starts of two requests to one gateway. Default 1,000 ms. */
  minIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (done: number, total: number) => void;
}

/** Asks every gateway for every CID, each gateway at its own pace, and tallies the answers. */
export async function runProbe(o: RunProbeOptions): Promise<GatewayTally[]> {
  const interval = o.minIntervalMs ?? PROBE_MIN_INTERVAL_MS;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? (() => performance.now());
  const total = o.gateways.length * o.cids.length;
  let completed = 0;
  return Promise.all(
    o.gateways.map(async (gateway) => {
      const base = gatewayBase(gateway);
      const tally: GatewayTally = {
        gateway,
        json: 0,
        notFound: 0,
        rateLimited: 0,
        timeout: 0,
        other: 0,
        medianLatencyMs: null,
      };
      const latencies: number[] = [];
      let lastStart = -Infinity;
      for (const cid of o.cids) {
        const wait = lastStart + interval - now();
        if (wait > 0) await sleep(wait);
        lastStart = now();
        const out = await probeOnce(base, cid, o);
        if (out.result === 'json') {
          tally.json++;
          latencies.push(out.latencyMs);
        } else if (out.result === 'not_found') tally.notFound++;
        else if (out.result === 'rate_limited') tally.rateLimited++;
        else if (out.result === 'timeout') tally.timeout++;
        else tally.other++;
        o.onProgress?.(++completed, total);
      }
      tally.medianLatencyMs = median(latencies);
      return tally;
    }),
  );
}

/** What a run would ask, for the dry run. */
export function describePlan(gateways: readonly string[], cids: readonly string[]): string {
  const requests = gateways.length * cids.length;
  const seconds = cids.length * (PROBE_MIN_INTERVAL_MS / 1000);
  return [
    `Gateway probe (dry run: nothing was requested).`,
    `  ${cids.length} CIDs x ${gateways.length} gateways = ${requests} GET requests, one a second per gateway,`,
    `  gateways asked side by side: about ${Math.ceil(seconds)} seconds plus the slowest answers.`,
    `  Each request: ${PROBE_TIMEOUT_MS / 1000} s timeout, redirects not followed, first ${PROBE_MAX_BODY_BYTES / 1024} KB of the body read and thrown away, user agent ${PROBE_USER_AGENT}.`,
    `  Gateways: ${gateways.join(', ')}`,
    `Add --confirm to send them. Nothing is written to any database.`,
  ].join('\n');
}

export function formatTallies(tallies: readonly GatewayTally[], cidCount: number): string {
  const lines: string[] = [];
  lines.push(`Per gateway, over ${cidCount} CIDs (median latency is over the valid-JSON answers):`);
  lines.push(
    `${'gateway'.padEnd(30)} ${'json'.padStart(5)} ${'not found'.padStart(10)} ${'rate limited'.padStart(13)} ${'timed out'.padStart(10)} ${'other'.padStart(6)} ${'median ms'.padStart(10)}`,
  );
  for (const t of tallies) {
    lines.push(
      `${t.gateway.padEnd(30)} ${String(t.json).padStart(5)} ${String(t.notFound).padStart(10)} ${String(t.rateLimited).padStart(13)} ${String(t.timeout).padStart(10)} ${String(t.other).padStart(6)} ${(t.medianLatencyMs === null ? '-' : String(Math.round(t.medianLatencyMs))).padStart(10)}`,
    );
  }
  return lines.join('\n');
}
