// Read-only probe of the Codex.io GraphQL API for pump.fun candle coverage.
// Plain Node (>=20), no dependencies.
//
//   node --env-file=.env probes/codex-probe.mjs --used 27 [--only SYMBOL,SYMBOL]
//
// Reads probes/coins.json, writes probes/codex-probe-results.json.
// The key is read from CODEX_API_KEY and is never printed or written.
// --used N: requests already spent on Codex before this run (hard cap is 400 in total).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KEY = process.env.CODEX_API_KEY;
if (!KEY) { console.error('CODEX_API_KEY not set (use node --env-file=.env)'); process.exit(1); }
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const CAP = 400;
let used = Number(arg('used', 0));
const only = arg('only', '') ? arg('only').split(',').map(s => s.trim().toLowerCase()) : null;
const NET = 1399811149;
const SUPPLY = 1e9; // fixed pump.fun supply used for market cap, as specified in the brief
const WSOL = 'So11111111111111111111111111111111111111112';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let lastCall = 0;

async function cx(query) {
  if (used >= CAP) throw new Error('request cap reached');
  used++;
  const wait = 250 - (Date.now() - lastCall); // stay under the 5 req/s free-tier limit
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  const r = await fetch('https://graph.codex.io/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: KEY },
    body: JSON.stringify({ query }),
  });
  const txt = await r.text();
  if (r.status === 429 || r.status === 402 || /quota|billing|rate.?limit/i.test(txt)) {
    console.error('STOPPING: quota/billing/rate-limit signal', r.status, txt.slice(0, 200));
    process.exit(3);
  }
  let json; try { json = JSON.parse(txt); } catch { json = { errors: [{ message: 'non-json ' + txt.slice(0, 120) }] }; }
  return { status: r.status, json };
}
const cuOf = j => Number(j?.data?.usageData?.total?.computeUnits || 0) / 1e6;
const iso = s => (s == null ? null : new Date(s * 1000).toISOString());

// Normalise a bars response into row objects.
function rows(b) {
  if (!b || !b.t) return [];
  return b.t.map((t, i) => ({
    t, o: b.o[i], h: b.h[i], l: b.l[i], c: b.c[i],
    volume: b.volume?.[i] == null ? null : Number(b.volume[i]),
    tx: b.transactions?.[i], buyers: b.buyers?.[i], sellers: b.sellers?.[i],
    traders: b.traders?.[i], liq: b.liquidity?.[i] == null ? null : Number(b.liquidity[i]),
  }));
}
const BARF = 't o h l c volume buyers sellers buys sells traders transactions liquidity';

async function bars(fn, symbol, from, to, res, extra = '') {
  const q = `{ ${fn}(symbol:"${symbol}", from:${from}, to:${to}, resolution:"${res}" ${extra}) { ${BARF} s } usageData{ total{computeUnits} } }`;
  const r = await cx(q);
  const err = r.json.errors?.[0]?.message;
  return { rows: rows(r.json.data?.[fn]), err, cu: cuOf(r.json), status: r.json.data?.[fn]?.s };
}

async function probeCoin(coin) {
  const out = { mint: coin.mint, symbol: coin.symbol, era: coin.era, notes: [] };
  const grad = coin.codexMigratedAt;
  out.codexGraduationTime = iso(grad);

  // 1. Pairs Codex knows.
  const lp = await cx(`{ listPairsWithMetadataForToken(tokenAddress:"${coin.mint}", networkId:${NET}, limit:250){ results{ liquidity volume quoteToken backingToken{address symbol} exchange{name} pair{ address createdAt protocol exchangeHash token0 token1 } } } usageData{ total{computeUnits} } }`);
  const pairs = (lp.json.data?.listPairsWithMetadataForToken?.results || []).map(x => ({
    address: x.pair.address, createdAt: x.pair.createdAt, createdAtIso: iso(x.pair.createdAt),
    exchange: x.exchange?.name, protocol: x.pair.protocol, liquidityUsd: Number(x.liquidity), volume: x.volume,
    quote: x.backingToken?.symbol || x.backingToken?.address,
  })).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  out.pairsError = lp.json.errors?.[0]?.message;
  out.pairs = pairs;
  if (!pairs.length) out.notes.push('no pairs returned by listPairsWithMetadataForToken');

  // 2. Pick graduation pool: non-curve pair created closest to the graduation time.
  const isCurve = p => /pump/i.test(p.protocol || '') && !/amm/i.test(p.protocol || '') && !/amm|swap|raydium/i.test(p.exchange || '');
  const cands = pairs.filter(p => p.createdAt && !isCurve(p));
  cands.sort((a, b) => Math.abs(a.createdAt - grad) - Math.abs(b.createdAt - grad));
  let gp = cands[0];
  if (!gp && coin.pool) gp = { address: coin.pool, createdAt: grad, exchange: 'unknown (from filterTokens)' };
  out.graduationPool = gp ? { ...gp, deltaToCodexMigratedAtSec: gp.createdAt - grad } : null;
  const curvePair = pairs.find(isCurve);
  out.curvePair = curvePair || null;
  if (!gp) { out.notes.push('no graduation pool found'); return out; }
  const created = gp.createdAt;

  // 3. 1-minute bars from pool creation.
  const first = await bars('getBars', `${gp.address}:${NET}`, created - 120, created + 3600, '1', 'removeEmptyBars:true');
  out.first60 = { err: first.err, cu: first.cu, status: first.status };
  const t0 = Math.floor(created / 60) * 60; // minute bucket containing pool creation
  const fr = first.rows.filter(r => r.t >= t0 && r.t < t0 + 3600);
  out.first60.barsReturned = fr.length;
  out.first60.barsWithVolume = fr.filter(r => (r.volume || 0) > 0).length;
  out.first60.barsWithTx = fr.filter(r => (r.tx || 0) > 0).length;
  out.first60.firstBarTime = fr[0] ? iso(fr[0].t) : null;
  out.first60.gapPoolCreationToFirstBarSec = fr[0] ? fr[0].t - created : null;
  out.first60.firstBarsSample = fr.slice(0, 3);
  out.first60.fields = fr[0] ? {
    volume: fr[0].volume != null, tx: fr[0].tx != null, buyers: fr[0].buyers != null,
    sellers: fr[0].sellers != null, liquidity: fr[0].liq != null,
  } : null;

  // 4. ATH from bars: daily bars over the whole pool life, then 1m bars on the ATH day.
  const now = Math.floor(Date.now() / 1000);
  const daily = await bars('getBars', `${gp.address}:${NET}`, created - 86400, now, '1D', 'removeEmptyBars:true');
  out.daily = { err: daily.err, n: daily.rows.length };
  if (daily.rows.length) {
    const hi = daily.rows.reduce((m, r) => (r.h > m.h ? r : m));
    const cl = daily.rows.reduce((m, r) => (r.c > m.c ? r : m));
    out.athFromDaily = {
      highMcap: hi.h * SUPPLY, highDay: iso(hi.t), maxDailyCloseMcap: cl.c * SUPPLY, maxDailyCloseDay: iso(cl.t),
      highDayVolumeUsd: hi.volume, highDayTx: hi.tx, highDayLiquidity: hi.liq,
    };
    const d0 = hi.t, d1 = hi.t + 86400;
    const m1 = await bars('getBars', `${gp.address}:${NET}`, d0, d1 - 1, '1', 'removeEmptyBars:true');
    out.athDay1m = { err: m1.err, n: m1.rows.length };
    if (m1.rows.length) {
      const h1 = m1.rows.reduce((m, r) => (r.h > m.h ? r : m));
      const c1 = m1.rows.reduce((m, r) => (r.c > m.c ? r : m));
      out.ath1m = {
        highMcap: h1.h * SUPPLY, highTime: iso(h1.t), highBar: h1,
        closeMcap: c1.c * SUPPLY, closeTime: iso(c1.t), closeBar: c1,
        minutesAfterPoolCreation: Math.round((h1.t - created) / 60),
      };
    }
  }

  // 4b. Token-level (all pools) daily bars: highest daily high, i.e. an ATH not tied to one pool.
  const tdaily = await bars('getTokenBars', `${coin.mint}:${NET}`, created - 86400, now, '1D', 'removeEmptyBars:true');
  out.tokenDaily = { err: tdaily.err, n: tdaily.rows.length };
  if (tdaily.rows.length) {
    const th = tdaily.rows.reduce((m, r) => (r.h > m.h ? r : m));
    out.tokenDaily.highMcap = th.h * SUPPLY; out.tokenDaily.highDay = iso(th.t);
    out.tokenDaily.firstDay = iso(tdaily.rows[0].t);
  }

  // 5. Bonding-curve phase: separate pair and/or token-level series.
  if (curvePair && curvePair.createdAt) {
    // Codex's own pair createdAt for the curve pair can be later than the graduation, so always window on the 1400 minutes before it.
    const cb = await bars('getBars', `${curvePair.address}:${NET}`, Math.max(curvePair.createdAt - 60, created - 1400 * 60), created, '1', 'removeEmptyBars:true');
    out.curveBars = { pair: curvePair.address, err: cb.err, n: cb.rows.length, firstBar: cb.rows[0] ? iso(cb.rows[0].t) : null, lastBar: cb.rows.length ? iso(cb.rows[cb.rows.length - 1].t) : null, withVolume: cb.rows.filter(r => (r.volume || 0) > 0).length, curveWindowIsTruncated: cb.rows.length >= 1 && curvePair.createdAt < created - 1400 * 60 };
  }
  const tb = await bars('getTokenBars', `${coin.mint}:${NET}`, created - 3 * 3600, created + 3600, '1', 'removeEmptyBars:true');
  const pre = tb.rows.filter(r => r.t < created - 60);
  out.tokenBars = {
    err: tb.err, nTotal: tb.rows.length, nBeforeGraduation: pre.length,
    firstBar: tb.rows[0] ? iso(tb.rows[0].t) : null, firstBarGapSec: tb.rows[0] ? tb.rows[0].t - created : null,
    barsInFirst60AfterGrad: tb.rows.filter(r => r.t >= created - 60 && r.t <= created + 3600).length,
  };

  // 6. GeckoTerminal cross-check for coins younger than ~170 days (keyless limit is 180 days).
  if (now - created < 170 * 86400 && out.first60.barsReturned) {
    try {
      const url = `https://api.geckoterminal.com/api/v2/networks/solana/pools/${gp.address}/ohlcv/minute?aggregate=1&limit=100&before_timestamp=${created + 3600}&currency=usd`;
      const gr = await fetch(url, { headers: { accept: 'application/json' } });
      const gj = await gr.json();
      const list = gj?.data?.attributes?.ohlcv_list || [];
      const byT = new Map(list.map(x => [x[0], x]));
      out.geckoCheck = { status: gr.status, n: list.length, compared: fr.slice(0, 3).map(r => ({ t: r.t, codex: [r.o, r.h, r.l, r.c, r.volume], gecko: byT.get(r.t) || null })) };
    } catch (e) { out.geckoCheck = { error: String(e) }; }
  }
  return out;
}

const coins = JSON.parse(fs.readFileSync(path.join(HERE, 'coins.json'), 'utf8'));
const results = [];
for (const c of coins) {
  if (only && !only.includes(String(c.symbol).trim().toLowerCase())) continue;
  try {
    const r = await probeCoin(c);
    results.push(r);
    console.log(`${String(c.symbol).trim().padEnd(10)} used=${used} first60=${r.first60?.barsReturned ?? '-'} gap=${r.first60?.gapPoolCreationToFirstBarSec ?? '-'}s ath1m=${r.ath1m ? Math.round(r.ath1m.highMcap) : '-'}`);
  } catch (e) {
    console.error('error', c.symbol, String(e));
    results.push({ mint: c.mint, symbol: c.symbol, error: String(e) });
  }
}
fs.writeFileSync(path.join(HERE, 'codex-probe-results.json'), JSON.stringify({ requestsUsedTotal: used, results }, null, 2) + '\n');
console.log('done; total Codex requests used (including prior):', used);
