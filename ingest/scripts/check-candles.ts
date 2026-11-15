/**
 * Candle fetch plan and live check for pump.fun mints.
 *
 *   tsx --env-file=/path/to/.env ingest/scripts/check-candles.ts MINT [MINT ...] \
 *       [--confirm --max-units N] [--json out.json] [--verify-rerun] \
 *       [--plan staged|exhaustive] [--dune-csv file.csv]
 *
 * `--plan` picks the fetch plan (default staged; exhaustive is the earlier,
 * costlier plan). `--dune-csv` is a Dune sample file with `mint` and
 * `peak_p999_usd` columns: each coin's value is stored as
 * `rough_ath_market_cap_usd` before its fetch, so the escalation rule is exercised.
 *
 * Without --confirm: looks up each mint's launch info (and, when the plan needs
 * it, its pool list), about 4 to 9 compute units a coin, capped at 200 units in
 * all, then prints what the plan asks for first. Nothing is stored.
 *
 * With --confirm and --max-units N: fetches the candles and computes the metrics
 * for every mint, storing them in a throwaway `mcp_test_<hex>` database on the
 * server TEST_DATABASE_ADMIN_URL points at (created, migrated and dropped by
 * this script; no other database is touched). N is a hard ceiling on Codex.io
 * compute units for the whole run. Prints, per coin, the path taken, the ATH, the
 * wick, the pool and minute each came from, the flags and the units spent.
 *
 * The API key is read from CODEX_API_KEY and handed to the client; it is never
 * printed or written.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_PLAN_LIMITS,
  EXHAUSTIVE_PLAN_LIMITS,
  estimateCoinUnits,
  planBaseRequests,
  selectPools,
  type PlanLimits,
  type PlanPool,
} from '../src/candles/index.js';
import { UnitBudget } from '../src/sources/budget.js';
import { CodexClient } from '../src/sources/codex/index.js';
import { RateLimiter } from '../src/sources/ratelimit.js';
import {
  checkCoin,
  printRow,
  symbolsFromProbe,
  withThrowawayDb,
  type CheckRow,
} from './lib/candle-check.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLAN_MODE_CEILING = 200;

/** `mint` to `peak_p999_usd`, from a Dune sample CSV (no quoted fields in these files). */
function readDunePeaks(file: string): Map<string, number> {
  const [header, ...lines] = fs.readFileSync(file, 'utf8').trim().split('\n');
  const cols = (header ?? '').split(',');
  const mintAt = cols.indexOf('mint');
  const peakAt = cols.indexOf('peak_p999_usd');
  if (mintAt < 0 || peakAt < 0) {
    throw new Error('The Dune CSV needs mint and peak_p999_usd columns.');
  }
  const out = new Map<string, number>();
  for (const line of lines) {
    const f = line.split(',');
    const v = Number(f[peakAt]);
    const mint = f[mintAt];
    if (mint && Number.isFinite(v)) out.set(mint, v);
  }
  return out;
}

function parseArgs(argv: string[]) {
  const mints: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--confirm' || a === '--verify-rerun') flags.set(a, true);
    else if (
      a === '--max-units' ||
      a === '--json' ||
      a === '--probe' ||
      a === '--plan' ||
      a === '--dune-csv'
    )
      flags.set(a, argv[++i] ?? '');
    else if (a.startsWith('--')) throw new Error(`Unknown option ${a}`);
    else mints.push(a);
  }
  return { mints, flags };
}

async function main(): Promise<void> {
  const { mints, flags } = parseArgs(process.argv.slice(2));
  if (mints.length === 0) throw new Error('Give at least one mint address.');
  const key = process.env['CODEX_API_KEY'];
  if (!key) throw new Error('CODEX_API_KEY is not set. Run with --env-file.');

  const confirm = flags.get('--confirm') === true;
  const maxUnits = flags.has('--max-units') ? Number(flags.get('--max-units')) : null;
  if (confirm && (maxUnits === null || !(maxUnits > 0))) {
    throw new Error('--confirm needs --max-units N (a positive number of compute units).');
  }
  const symbols = symbolsFromProbe(
    typeof flags.get('--probe') === 'string'
      ? (flags.get('--probe') as string)
      : path.join(HERE, '..', '..', 'probes', 'coins.json'),
  );
  const plan = flags.get('--plan') ?? 'staged';
  if (plan !== 'staged' && plan !== 'exhaustive')
    throw new Error('--plan is staged or exhaustive.');
  const limits: Partial<PlanLimits> = plan === 'exhaustive' ? EXHAUSTIVE_PLAN_LIMITS : {};
  const duneFile = flags.get('--dune-csv');
  const dune =
    typeof duneFile === 'string' && duneFile ? readDunePeaks(duneFile) : new Map<string, number>();
  const budget = new UnitBudget({ ceilingUnits: confirm ? maxUnits! : PLAN_MODE_CEILING });
  const client = new CodexClient({
    apiKey: key,
    budget,
    limiter: new RateLimiter({ maxPerSecond: 10, burst: 1 }),
  });

  if (!confirm) {
    await planMode(client, mints, symbols, limits, dune);
    const s = client.spend();
    console.log(
      `\nLookups spent ${s.units.toFixed(2)} units in ${s.requests} requests. Nothing was fetched or stored.`,
    );
    console.log('Add --confirm --max-units N to fetch and compute.');
    return;
  }

  const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
  if (!adminUrl) throw new Error('TEST_DATABASE_ADMIN_URL is not set.');
  console.log(
    `Fetching ${mints.length} coin(s) with the ${plan} plan. Hard ceiling: ${maxUnits} units.`,
  );
  const rows: CheckRow[] = [];
  await withThrowawayDb(adminUrl, async (t) => {
    console.log(`Database: ${t.name} (dropped at the end)`);
    for (const mint of mints) {
      // One fixed observation time per coin, so a second fetch is an exact rerun.
      const at = new Date();
      const row = await checkCoin({
        t,
        client,
        mint,
        symbol: symbols.get(mint) ?? null,
        clock: () => at,
        verifyRerun: flags.get('--verify-rerun') === true,
        limits,
        roughAthUsd: dune.get(mint) ?? null,
      });
      rows.push(row);
      printRow(row);
      if (row.failure?.reason === 'budget_exhausted') {
        console.log('Budget ceiling reached; stopping.');
        break;
      }
    }
  });
  const s = client.spend();
  console.log(
    `\nTotal: ${s.units.toFixed(2)} units in ${s.requests} requests ` +
      `(${s.estimatedUnits.toFixed(2)} units estimated because a response reported none).`,
  );
  const json = flags.get('--json');
  if (typeof json === 'string' && json) {
    fs.writeFileSync(
      json,
      JSON.stringify({ totalUnits: s.units, totalRequests: s.requests, rows }, null, 2) + '\n',
    );
    console.log(`Wrote ${json}`);
  }
}

async function planMode(
  client: CodexClient,
  mints: string[],
  symbols: Map<string, string>,
  limits: Partial<PlanLimits>,
  dune: Map<string, number>,
): Promise<void> {
  const asOf = Math.floor(Date.now() / 1000);
  const staged = limits.staged !== false;
  for (const mint of mints) {
    const launch = await client.getLaunchInfo(mint);
    if (!launch) {
      console.log(`${symbols.get(mint) ?? mint}: Codex.io does not know this token`);
      continue;
    }
    console.log(`${symbols.get(mint) ?? mint} (${mint})`);
    if (staged && launch.migratedPoolAddress !== null) {
      // Stage 0 needs launch info alone: the first request is the screen.
      const pools: PlanPool[] = [
        { address: launch.migratedPoolAddress, role: 'graduation', createdAt: null },
      ];
      const first = planBaseRequests({
        asOf,
        launchedAt: launch.createdAt,
        graduatedAt: launch.migratedAt,
        pools,
        coverage: {},
        daily: {},
        roughAthUsd: dune.get(mint) ?? null,
      });
      console.log(
        `  stage 1, screen: ${first.requests.length} request of daily bars on the graduation pool = ` +
          `${first.estimatedUnits} units; what follows depends on W (screened out under ` +
          `$${DEFAULT_PLAN_LIMITS.screenBelowUsd.toLocaleString('en-US')})`,
      );
      continue;
    }
    const listing = await client.getPools(mint);
    const sel = selectPools({
      pools: listing,
      migratedPoolAddress: launch.migratedPoolAddress,
      migratedAt: launch.migratedAt,
      migrated: launch.migrated,
      minSecondaryPoolLiquidityUsd: DEFAULT_PLAN_LIMITS.minSecondaryPoolLiquidityUsd,
      maxSecondaryPools: 8,
    });
    const pools: PlanPool[] = [];
    if (sel.curve)
      pools.push({ address: sel.curve.address, role: 'curve', createdAt: sel.curve.createdAt });
    if (sel.graduation) {
      pools.push({
        address: sel.graduation.address,
        role: 'graduation',
        createdAt: sel.graduation.pool?.createdAt ?? null,
      });
    }
    for (const p of sel.others)
      pools.push({ address: p.address, role: 'other', createdAt: p.createdAt });
    const state = {
      asOf,
      launchedAt: launch.createdAt,
      graduatedAt: launch.migratedAt,
      pools,
      coverage: {},
      daily: {},
      poolsListed: true,
      roughAthUsd: dune.get(mint) ?? null,
      limits,
    };
    const first = planBaseRequests(state);
    const est = estimateCoinUnits(state);
    const byReason = new Map<string, number>();
    for (const r of first.requests) byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + 1);

    console.log(
      `  pools listed ${listing.pools.length}${listing.truncated ? ' (cut off at 250)' : ''}; ` +
        `curve ${sel.curve ? 'yes' : 'no'}, graduation ${sel.graduation ? `${sel.graduation.source}${sel.graduation.unverified ? ' (unverified)' : ''}` : 'NOT FOUND'}, ` +
        `others ${sel.others.length} (+${sel.skippedOthers} skipped)`,
    );
    console.log(
      `  first phase: ${first.requests.length} requests (${[...byReason].map(([k, v]) => `${k} ${v}`).join(', ')}) = ${est.initialUnits} units`,
    );
    console.log(
      `  hourly: ${est.hourlyIsUpperBound ? 'up to ' : ''}${est.hourlyRequests} requests = ${est.hourlyUnits} units; ` +
        `refinement cap ${est.refinementCapUnits} units`,
    );
    console.log(
      `  estimate: typical ${est.typicalUnits} units, upper bound ${est.upperBoundUnits} units (lookups already spent)`,
    );
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
