/**
 * Shared by check-candles.ts and record-candle-fixtures.ts: fetch, compute and
 * summarise coins against a throwaway `mcp_test_` database.
 *
 * Nothing here prints or stores the API key. The client holds it; this file
 * never reads it.
 */
import fs from 'node:fs';
import { upsertCoin } from '@memecoinipedia/db';
import { createTestDatabase, type TestDatabase } from '@memecoinipedia/db/testing';
import {
  computeMetricsForCoin,
  fetchCandlesForCoin,
  type PlanLimits,
} from '../../src/candles/index.js';
import type { CandleFailure } from '../../src/candles/errors.js';
import type { CandleFetchSummary } from '../../src/candles/types.js';
import type { CodexClient } from '../../src/sources/codex/index.js';

export interface CheckRow {
  mint: string;
  symbol: string | null;
  ok: boolean;
  failure: CandleFailure | null;
  /** `screened_out`, `light`, `full` or `exhaustive` (see CandleFetchSummary.path). */
  path: string;
  /** W: the highest daily high as a market cap, USD. */
  w: number | null;
  escalated: boolean;
  /** `coins.rough_ath_market_cap_usd` as set for this run. */
  roughAthUsd: number | null;
  athMarketCapUsd: number | null;
  athAt: string | null;
  athPool: string | null;
  athWickMarketCapUsd: number | null;
  athWickAt: string | null;
  athWickPool: string | null;
  rugPattern: boolean | null;
  status: string | null;
  secondsAbove: number[] | null;
  maxDrawdownPct: number | null;
  flags: string[];
  /** Compute units spent on this coin: lookups and bars. */
  units: number;
  requests: number;
  lookupRequests: number;
  refinementRounds: number;
  hourlyCapHit: boolean;
  issues: string[];
  pools: number;
  skippedOtherPools: number;
  barsStored: CandleFetchSummary['barsStored'];
  estimatedUpperBoundUnits: number | null;
  /** Requests and units of a second fetch at the same clock (should be 0 and 0). */
  rerun: { requests: number; units: number } | null;
}

export function symbolsFromProbe(file: string): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const coins = JSON.parse(fs.readFileSync(file, 'utf8')) as { mint: string; symbol: string }[];
    for (const c of coins) out.set(c.mint, c.symbol.trim());
  } catch {
    // The probe list is optional.
  }
  return out;
}

const iso = (s: number | null): string | null =>
  s === null ? null : new Date(s * 1000).toISOString();

/** Runs `fn` with a fresh migrated `mcp_test_` database that is dropped afterwards. */
export async function withThrowawayDb<T>(
  adminUrl: string,
  fn: (t: TestDatabase) => Promise<T>,
): Promise<T> {
  const t = await createTestDatabase(adminUrl);
  try {
    return await fn(t);
  } finally {
    await t.drop();
  }
}

/** Fetches and computes one coin and returns the row the check prints. */
export async function checkCoin(args: {
  t: TestDatabase;
  client: CodexClient;
  mint: string;
  symbol: string | null;
  clock: () => Date;
  verifyRerun?: boolean;
  /** Plan limits: `{ staged: false }` is the exhaustive plan. Default: the staged plan. */
  limits?: Partial<PlanLimits>;
  /** Stored as `coins.rough_ath_market_cap_usd` before the fetch, so escalation can be exercised. */
  roughAthUsd?: number | null;
}): Promise<CheckRow> {
  const { t, client, mint, symbol, clock } = args;
  const id = await upsertCoin(t.db, {
    chain: 'solana',
    address: mint,
    ticker: symbol,
    launchpad: 'pump.fun',
  });
  if (args.roughAthUsd !== undefined && args.roughAthUsd !== null) {
    await t.db
      .updateTable('coins')
      .set({ rough_ath_market_cap_usd: args.roughAthUsd })
      .where('id', '=', id)
      .execute();
  }
  const deps = { db: t.db, codex: client, clock };
  const options = args.limits ? { limits: args.limits } : {};
  const fetched = await fetchCandlesForCoin(deps, { id, address: mint }, options);
  const row: CheckRow = {
    mint,
    symbol,
    ok: fetched.ok,
    failure: fetched.ok
      ? null
      : { reason: fetched.reason, retry: fetched.retry, message: fetched.message },
    path: fetched.summary.path,
    w: fetched.summary.w,
    escalated: fetched.summary.escalated,
    roughAthUsd: args.roughAthUsd ?? null,
    athMarketCapUsd: null,
    athAt: null,
    athPool: null,
    athWickMarketCapUsd: null,
    athWickAt: null,
    athWickPool: null,
    rugPattern: null,
    status: null,
    secondsAbove: null,
    maxDrawdownPct: null,
    flags: fetched.summary.flags,
    units: fetched.summary.units,
    requests: fetched.summary.requests,
    lookupRequests: fetched.summary.lookupRequests,
    refinementRounds: fetched.summary.refinementRounds,
    hourlyCapHit: fetched.summary.hourlyCapHit,
    issues: fetched.summary.issues,
    pools: fetched.summary.pools.length,
    skippedOtherPools: fetched.summary.skippedOtherPools,
    barsStored: fetched.summary.barsStored,
    estimatedUpperBoundUnits: fetched.summary.estimate?.upperBoundUnits ?? null,
    rerun: null,
  };
  if (!fetched.ok) return row;

  const computed = await computeMetricsForCoin(deps, { id });
  if (computed.ok) {
    const r = computed.result;
    row.athMarketCapUsd = r.athMarketCapUsd;
    row.athAt = iso(r.athAt);
    row.athPool = r.athPoolAddress;
    row.athWickMarketCapUsd = r.athWickMarketCapUsd;
    row.athWickAt = iso(r.athWickAt);
    row.athWickPool = r.athWickPoolAddress;
    row.rugPattern = r.rugPattern;
    row.secondsAbove = r.secondsAbove;
    row.maxDrawdownPct = r.maxDrawdownPct;
    row.status = computed.status;
    row.flags = r.flags;
  }
  if (args.verifyRerun) {
    const again = await fetchCandlesForCoin(deps, { id, address: mint }, options);
    row.rerun = { requests: again.summary.requests, units: again.summary.units };
  }
  return row;
}

export function printRow(row: CheckRow): void {
  const usd = (n: number | null): string =>
    n === null ? '-' : `$${Math.round(n).toLocaleString('en-US')}`;
  const lines = [
    `${row.symbol ?? row.mint} (${row.mint})`,
    row.ok
      ? '  fetch: ok'
      : `  fetch: FAILED ${row.failure?.reason} retry=${row.failure?.retry}: ${row.failure?.message}`,
    `  ATH ${usd(row.athMarketCapUsd)} at ${row.athAt ?? '-'} in pool ${row.athPool ?? '-'}`,
    `  wick ${usd(row.athWickMarketCapUsd)} at ${row.athWickAt ?? '-'} in pool ${row.athWickPool ?? '-'}`,
    `  path ${row.path}${row.escalated ? ' (escalated)' : ''}, W ${usd(row.w)}, Dune peak ${usd(row.roughAthUsd)}`,
    `  status ${row.status ?? '-'}, rug pattern ${row.rugPattern}, flags [${row.flags.join(', ')}]`,
    `  units ${row.units.toFixed(2)} (bars requests ${row.requests}, lookups ${row.lookupRequests}, ` +
      `refinement rounds ${row.refinementRounds}), pools ${row.pools} (+${row.skippedOtherPools} skipped)`,
  ];
  if (row.issues.length > 0) lines.push(`  data issues: ${row.issues.join(', ')}`);
  if (row.rerun) lines.push(`  rerun: ${row.rerun.requests} requests, ${row.rerun.units} units`);
  console.log(lines.join('\n'));
}
