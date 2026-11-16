/**
 * Raw swaps of one coin for a few minutes from Dune's `dex_solana.trades`, summarised per minute
 * (swaps, wallets, USD, lowest / median / highest price as a market cap). Spends Dune credits:
 * the review capped the whole task at 40 and used two runs of about 3.9 credits each.
 *
 *   node --env-file=.env --import tsx ingest/scripts/a6/dune-trades.ts OUT.csv MINT YYYY-MM YYYY-MM-DD HH:MM HH:MM
 *
 * The query filters on the partition column (`block_month`), the day and the minute range, and on the
 * coin, so it reads a few minutes of one day, not the table. It reads the credit balance (a free
 * call) before and after and prints only the difference.
 */
import { readFileSync } from 'node:fs';
import { DuneClient, duneApiKeyFromEnv, duneErrorMessage } from '../../src/sources/dune/index.js';
import { UnitBudget } from '../../src/sources/budget.js';

const [out, mint, month, day, from, to] = process.argv.slice(2);
if (!out || !mint || !month || !day || !from || !to) throw new Error('Usage: OUT.csv MINT YYYY-MM YYYY-MM-DD HH:MM HH:MM');
if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) throw new Error('mint is not a base58 address');
if (!/^\d{4}-\d{2}$/.test(month) || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{2}:\d{2}$/.test(from) || !/^\d{2}:\d{2}$/.test(to))
  throw new Error('bad date or time');

const client = new DuneClient({ apiKey: duneApiKeyFromEnv(process.env), budget: new UnitBudget({ ceilingUnits: 40 }) });
const sql =
  `SELECT block_time, project, version, token_bought_mint_address, token_sold_mint_address, token_bought_amount, ` +
  `token_sold_amount, amount_usd, trader_id FROM dex_solana.trades WHERE block_month = DATE '${month}-01' AND ` +
  `block_date = DATE '${day}' AND block_time >= TIMESTAMP '${day} ${from}:00' AND block_time < TIMESTAMP '${day} ${to}:00' ` +
  `AND (token_bought_mint_address = '${mint}' OR token_sold_mint_address = '${mint}') ORDER BY block_time`;

function summarise(path: string): void {
  const [head, ...rows] = readFileSync(path, 'utf8').trim().split(/\r?\n/);
  const cols = head!.split(',');
  const byMinute = new Map<string, { px: number; usd: number; who: string }[]>();
  for (const r of rows) {
    const cells = r.split(',');
    const c = Object.fromEntries(cols.map((k, i) => [k, cells[i] ?? '']));
    const amount = Number(c['token_bought_mint_address'] === mint ? c['token_bought_amount'] : c['token_sold_amount']);
    const usd = Number(c['amount_usd']);
    if (!(amount > 0) || !(usd > 0)) continue;
    const minute = String(c['block_time']).slice(11, 16);
    const list = byMinute.get(minute) ?? [];
    list.push({ px: (usd / amount) * 1e9, usd, who: String(c['trader_id']) });
    byMinute.set(minute, list);
  }
  for (const [minute, a] of byMinute) {
    const px = a.map((x) => x.px).sort((p, q) => p - q);
    console.log(
      minute,
      `swaps ${a.length} wallets ${new Set(a.map((x) => x.who)).size} usd ${Math.round(a.reduce((s, x) => s + x.usd, 0))}`,
      `mcap min/med/max ${Math.round(px[0]!)} ${Math.round(px[Math.floor(px.length / 2)]!)} ${Math.round(px[px.length - 1]!)}`,
    );
  }
}

async function main(): Promise<void> {
  const u0 = await client.usage();
  const started = await client.executeSql(sql, { maxCredits: 15, performance: 'medium' });
  if (started.status !== 'started') throw new Error('dry run');
  const w = await client.waitForExecution(started.executionId, { timeLimitMs: 4 * 60_000 });
  console.log('outcome', w.outcome, 'rows', 'rowCount' in w ? w.rowCount : null);
  if (w.outcome === 'completed' && (w.rowCount ?? 0) > 0) {
    await client.downloadCsv(started.executionId, out!, { limit: 5000 });
    summarise(out!);
  }
  const u1 = await client.usage();
  if (u0?.creditsRemaining != null && u1?.creditsRemaining != null)
    console.log('credits spent by this run:', (u0.creditsRemaining - u1.creditsRemaining).toFixed(2));
}

main().catch((e: unknown) => {
  console.error('dune-trades failed:', duneErrorMessage(e));
  process.exit(1);
});
