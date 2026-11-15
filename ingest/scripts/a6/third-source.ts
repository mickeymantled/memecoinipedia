/**
 * Third-source checks for the A6a outlier review. Every request is cached on disk under the work
 * directory (outside the repo), so a repeat run makes no request, and Codex.io spend is counted
 * in a ledger with a hard cap.
 *
 *   CODEX_API_KEY=... pnpm -C ingest exec node --import tsx scripts/a6/third-source.ts COMMAND --work DIR [args]
 *
 * Commands (all read DIR/features.json made by features.ts):
 *   gt-ath            GeckoTerminal public minute OHLCV around each coin's ATH (coins whose ATH is
 *                     inside the public 180-day window).
 *   gt-dune           GeckoTerminal minute OHLCV for the hour Dune names, for each non-curve pool.
 *   codex-dune-hour   Codex.io 1-minute bars of the Dune hour for coins Dune values far above ours.
 *   codex-pairs GROUP Codex.io pool list of each coin of GROUP, then the Dune hour on pools the run
 *                     did not fetch (at most two per coin).
 *   codex-wick-day    Codex.io 1-minute bars of the whole UTC day of a daily wick.
 *   codex-events GROUP [TICKER_REGEX]
 *                     Codex.io raw swaps of the ATH minute (coins GeckoTerminal cannot cover).
 *   codex-wick-events MINT_PREFIX [LIMIT]
 *                     Codex.io raw swaps of the minute of one coin's stored wick bar.
 *   coingecko         CoinGecko public ATH by contract for the probe coins.
 *
 * Public sources: a generic User-Agent, GeckoTerminal at one request every 7 seconds (its public
 * limit is 10 a minute), CoinGecko the same. GeckoTerminal's public API serves 180 days only.
 */
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const CODEX_CAP_UNITS = 2_900; // the task's cap is 3,000; stop early.
const NETWORK = 1399811149;
const UA = 'ohlcv-check/1.0';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const GT_CUTOFF = Date.parse('2026-05-20T00:00:00Z') / 1000;

let work = '';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Feat = Record<string, any>;

async function readJson<T>(name: string, fallback: T): Promise<T> {
  const p = join(work, name);
  return existsSync(p) ? (JSON.parse(await readFile(p, 'utf8')) as T) : fallback;
}
const writeJson = (name: string, v: unknown): Promise<void> => writeFile(join(work, name), JSON.stringify(v));

// ---- Codex.io ------------------------------------------------------------------------------

async function ledgerTotal(): Promise<number> {
  const p = join(work, 'cdx-ledger.jsonl');
  if (!existsSync(p)) return 0;
  return (await readFile(p, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .reduce((s, l) => s + (JSON.parse(l) as { units: number }).units, 0);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function cdx(query: string, label: string): Promise<any> {
  const key = process.env['CODEX_API_KEY'];
  if (!key) throw new Error('CODEX_API_KEY is not set');
  await mkdir(join(work, 'cdx-cache'), { recursive: true });
  const f = join(work, 'cdx-cache', createHash('sha1').update(query).digest('hex') + '.json');
  if (existsSync(f)) return JSON.parse(await readFile(f, 'utf8'));
  if ((await ledgerTotal()) > CODEX_CAP_UNITS - 15) throw new Error('Codex.io cap guard reached');
  const q = query.replace(/\}\s*$/, ' usageData{ total{computeUnits} } }');
  const r = await fetch('https://graph.codex.io/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: key },
    body: JSON.stringify({ query: q }),
  });
  const j = (await r.json()) as { data?: { usageData?: { total?: { computeUnits?: number } } }; errors?: unknown };
  const micro = j.data?.usageData?.total?.computeUnits;
  await appendFile(
    join(work, 'cdx-ledger.jsonl'),
    JSON.stringify({ label, units: micro != null ? micro / 1e6 : 4, status: r.status, est: micro == null }) + '\n',
  );
  await writeFile(f, JSON.stringify(j));
  return j;
}

const barsQuery = (pool: string, from: number, to: number, res: string): string =>
  `{ getBars(symbol:"${pool}:${NETWORK}", from:${from}, to:${to}, resolution:"${res}" removeEmptyBars:true){ t o h l c volume traders transactions liquidity } }`;

interface Cols { t: number[]; o: number[]; h: number[]; l: number[]; c: number[]; volume: number[]; traders: number[]; transactions: number[]; liquidity: number[] }
const peakOf = (g: Cols, i: number): number => Math.max(g.o[i]!, g.h[i]!, g.l[i]!, g.c[i]!) * 1e9;

// ---- GeckoTerminal ---------------------------------------------------------------------------

let lastGt = 0;
async function gtMinutes(pool: string, from: number, to: number, label: string) {
  const limit = Math.min(1000, Math.ceil((to - from) / 60) + 1);
  const url = `https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool}/ohlcv/minute?aggregate=1&before_timestamp=${to + 1}&limit=${limit}&currency=usd&token=base`;
  await mkdir(join(work, 'http'), { recursive: true });
  const f = join(work, 'http', createHash('sha1').update(url).digest('hex') + '.json');
  if (existsSync(f)) return JSON.parse(await readFile(f, 'utf8')) as Feat;
  for (let attempt = 0; attempt < 4; attempt++) {
    const wait = 7_000 - (Date.now() - lastGt);
    if (wait > 0) await sleep(wait);
    lastGt = Date.now();
    const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } });
    if (r.status === 429) {
      await sleep(60_000);
      continue;
    }
    const text = await r.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text.slice(0, 200) };
    }
    const out = { status: r.status, label, pool, from, to, body };
    if ([200, 401, 404].includes(r.status)) await writeFile(f, JSON.stringify(out));
    return out as Feat;
  }
  return { status: 429, label, pool, from, to } as Feat;
}

function gtCandles(res: Feat): { t: number; o: number; h: number; l: number; c: number; v: number }[] {
  const list = (res['body']?.data?.attributes?.ohlcv_list ?? []) as number[][];
  return list.map(([t, o, h, l, c, v]) => ({ t: t!, o: o!, h: h!, l: l!, c: c!, v: v! }));
}

async function cmdGt(kind: 'ath' | 'dune'): Promise<void> {
  const feats = await readJson<Feat[]>('features.json', []);
  const results = await readJson<Feat>('gt-results.json', {});
  for (const x of feats) {
    const jobs: { pool: string; from: number; to: number }[] = [];
    if (kind === 'ath' && x['stored'].athAt > GT_CUTOFF)
      jobs.push({ pool: x['athWin'].pool, from: x['stored'].athAt - 1500, to: x['stored'].athAt + 900 });
    const duneT = Date.parse(x['dune'].peak_at) / 1000;
    if (kind === 'dune' && duneT > GT_CUTOFF)
      for (const p of x['pools'] as Feat[]) if (p['dex'] !== 'Pump') jobs.push({ pool: p['addr'], from: duneT, to: duneT + 3599 });
    for (const j of jobs) {
      const key = `${x['mint']}|${kind}|${j.pool}`;
      if (results[key]) continue;
      const res = await gtMinutes(j.pool, j.from, j.to, key);
      const c = gtCandles(res).sort((a, b) => a.t - b.t);
      results[key] = {
        status: res['status'],
        n: c.length,
        hi: c.length ? Math.max(...c.map((k) => Math.max(k.o, k.h, k.l, k.c))) * 1e9 : null,
        vol: c.reduce((s, k) => s + k.v, 0),
        lastClose: c.length ? c[c.length - 1]!.c * 1e9 : null,
        candles: c,
      };
      await writeJson('gt-results.json', results);
      console.log(key.slice(0, 8), kind, j.pool.slice(0, 6), 'status', res['status'], 'n', c.length);
    }
  }
}

// ---- Codex commands ---------------------------------------------------------------------------

async function cmdCodexDuneHour(): Promise<void> {
  const feats = await readJson<Feat[]>('features.json', []);
  const out = await readJson<Feat>('cx-dune-hour.json', {});
  for (const x of feats) {
    const duneT = Date.parse(x['dune'].peak_at) / 1000;
    const far = x['dune'].peak_p999_usd > 1.5 * Math.max(x['stored'].wick ?? 0, x['stored'].ath ?? 0);
    if (!far || duneT > GT_CUTOFF) continue;
    for (const p of x['pools'] as Feat[]) {
      if (p['dex'] === 'Pump' || out[`${x['mint']}|${p['addr']}`]) continue;
      const j = await cdx(barsQuery(p['addr'], duneT, duneT + 3599, '1'), 'dune-hour ' + String(x['mint']).slice(0, 6));
      const g = j?.data?.getBars as Cols | undefined;
      const n = g?.t?.length ?? 0;
      out[`${x['mint']}|${p['addr']}`] = {
        n,
        hi: n ? Math.max(...g!.t.map((_, i) => peakOf(g!, i))) : null,
        vol: n ? g!.volume.reduce((s, v) => s + v, 0) : 0,
      };
      await writeJson('cx-dune-hour.json', out);
    }
  }
}

async function cmdCodexPairs(group: string): Promise<void> {
  const feats = await readJson<Feat[]>('features.json', []);
  const out = await readJson<Feat>('cx-pairs.json', {});
  for (const x of feats) {
    if (!(x['groups'] as string[]).includes(group) || out[x['mint']]) continue;
    const duneT = Date.parse(x['dune'].peak_at) / 1000;
    const pj = await cdx(
      `{ listPairsWithMetadataForToken(tokenAddress:"${x['mint']}", networkId:${NETWORK}, limit:250){ results{ liquidity volume exchange{name} pair{ address createdAt } } } }`,
      'pairs ' + String(x['mint']).slice(0, 6),
    );
    const res = (pj?.data?.listPairsWithMetadataForToken?.results ?? []) as Feat[];
    const known = new Set((x['pools'] as Feat[]).map((p) => p['addr']));
    const others = res.filter((r) => !known.has(r['pair'].address)).sort((a, b) => Number(b['volume']) - Number(a['volume']));
    const entry: Feat = { total: res.length, unknown: others.length, checked: [] };
    for (const o of others.slice(0, 2)) {
      const j = await cdx(barsQuery(o['pair'].address, duneT, duneT + 3599, '1'), 'pairs-hour ' + String(x['mint']).slice(0, 6));
      const g = j?.data?.getBars as Cols | undefined;
      const n = g?.t?.length ?? 0;
      entry['checked'].push({ pool: o['pair'].address, ex: o['exchange']?.name, n, hi: n ? Math.max(...g!.t.map((_, i) => peakOf(g!, i))) : null });
    }
    out[x['mint']] = entry;
    await writeJson('cx-pairs.json', out);
  }
}

async function cmdCodexWickDay(): Promise<void> {
  const feats = await readJson<Feat[]>('features.json', []);
  const out = await readJson<Feat>('cx-wick-day.json', {});
  for (const x of feats) {
    if (!x['wickBar'] || x['wickRes'] !== '86400' || out[x['mint']]) continue;
    if (!(x['stored'].wick > 3 * (x['stored'].ath ?? 0))) continue;
    const day = x['stored'].wickAt as number;
    const j = await cdx(barsQuery(x['wickBar'].pool, day, day + 86_399, '1'), 'wick-day ' + String(x['mint']).slice(0, 6));
    const g = j?.data?.getBars as Cols | undefined;
    const n = g?.t?.length ?? 0;
    let best: Feat | null = null;
    for (let i = 0; i < n; i++) {
      const hi = peakOf(g!, i);
      if (!best || hi > best['hi'])
        best = { t: g!.t[i], hi, c: g!.c[i]! * 1e9, vol: g!.volume[i], tr: g!.transactions[i], u: g!.traders[i], liq: g!.liquidity[i] };
    }
    out[x['mint']] = { n, best, wick: x['stored'].wick };
    await writeJson('cx-wick-day.json', out);
  }
}

async function swaps(pool: string, from: number, to: number, limit: number, label: string) {
  const q = `{ getTokenEvents(query:{address:"${pool}", networkId:${NETWORK}, timestamp:{from:${from}, to:${to}}, eventType:Swap}, limit:${limit}, direction:ASC){ cursor items{ timestamp maker transactionHash token0Address token1Address data{ ... on SwapEventData{ amount0 amount1 priceUsd priceBaseToken type } } } } }`;
  const j = await cdx(q, label);
  return (j?.data?.getTokenEvents?.items ?? []) as Feat[];
}

function summarise(items: Feat[]): Feat {
  if (!items.length) return { n: 0 };
  const px = items.map((i) => Number(i['data'].priceUsd) * 1e9).sort((a, b) => a - b);
  return {
    n: items.length,
    makers: new Set(items.map((i) => i['maker'])).size,
    pxMin: Math.round(px[0]!),
    pxMed: Math.round(px[Math.floor(px.length / 2)]!),
    pxMax: Math.round(px[px.length - 1]!),
    pxLast: Math.round(Number(items[items.length - 1]!['data'].priceUsd) * 1e9),
  };
}

async function cmdCodexEvents(group: string, tickerRegex?: string): Promise<void> {
  const feats = await readJson<Feat[]>('features.json', []);
  const out = await readJson<Feat>('ev-results.json', {});
  for (const x of feats) {
    if (tickerRegex && !new RegExp(tickerRegex).test(String(x['ticker']))) continue;
    if (!(x['groups'] as string[]).includes(group) || !x['stored'].athAt || x['stored'].athAt > GT_CUTOFF) continue;
    if (out[`${x['mint']}|ath`]) continue;
    const items = await swaps(x['athWin'].pool, x['stored'].athAt, x['stored'].athAt + 59, 200, 'ath-minute ' + String(x['mint']).slice(0, 6));
    out[`${x['mint']}|ath`] = {
      ...summarise(items),
      truncated: items.length >= 200,
      barClose: x['athWin'].closes[x['athWin'].closes.length - 1],
      ath: x['stored'].ath,
    };
    await writeJson('ev-results.json', out);
  }
}

async function cmdCodexWickEvents(prefix: string, limit: number): Promise<void> {
  const feats = await readJson<Feat[]>('features.json', []);
  const x = feats.find((y) => String(y['mint']).startsWith(prefix));
  if (!x) throw new Error('no such coin');
  const items = await swaps(x['wickBar'].pool, x['stored'].wickAt, x['stored'].wickAt + 59, limit, 'wick-minute ' + prefix);
  const out = await readJson<Feat>('wick-events.json', {});
  out[x['mint']] = summarise(items);
  await writeJson('wick-events.json', out);
  console.log(x['ticker'], JSON.stringify(out[x['mint']]));
}

async function cmdCoinGecko(): Promise<void> {
  const feats = await readJson<Feat[]>('features.json', []);
  const out = await readJson<Feat>('cg-results.json', {});
  for (const x of feats) {
    if (!(x['groups'] as string[]).includes('8_probe') || out[x['mint']]) continue;
    await sleep(7_000);
    const r = await fetch(
      `https://api.coingecko.com/api/v3/coins/solana/contract/${x['mint']}?localization=false&tickers=false&community_data=false&developer_data=false&sparkline=false`,
      { headers: { 'user-agent': UA, accept: 'application/json' } },
    );
    if (r.status === 429) {
      await sleep(60_000);
      continue;
    }
    const j = (await r.json().catch(() => ({}))) as Feat;
    out[x['mint']] = { status: r.status, id: j['id'], athUsd: j['market_data']?.ath?.usd ?? null, athDate: j['market_data']?.ath_date?.usd ?? null };
    await writeJson('cg-results.json', out);
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ options: { work: { type: 'string' } }, allowPositionals: true, strict: true });
  if (!values.work) throw new Error('--work DIR is required');
  work = values.work;
  const [cmd, a, b] = positionals;
  switch (cmd) {
    case 'gt-ath': return cmdGt('ath');
    case 'gt-dune': return cmdGt('dune');
    case 'codex-dune-hour': return cmdCodexDuneHour();
    case 'codex-pairs': return cmdCodexPairs(a ?? '1_dune_far_above');
    case 'codex-wick-day': return cmdCodexWickDay();
    case 'codex-events': return cmdCodexEvents(a ?? '3_above_3x', b);
    case 'codex-wick-events': return cmdCodexWickEvents(a ?? '', Number(b ?? 40));
    case 'coingecko': return cmdCoinGecko();
    default:
      throw new Error('Commands: gt-ath, gt-dune, codex-dune-hour, codex-pairs, codex-wick-day, codex-events, codex-wick-events, coingecko');
  }
}

main().catch((e: unknown) => {
  const text = e instanceof Error ? e.message : String(e);
  console.error('third-source failed:', text.split(process.env['CODEX_API_KEY'] ?? '\u0000').join('[redacted]'));
  process.exit(1);
});
