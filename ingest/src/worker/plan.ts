/**
 * The plan for an ingest run and its cost estimate. Planning reads the
 * database (counts only) and the sample file, and makes no network call and no
 * write, so it is what a run without `--confirm` prints.
 */
import { listCoinsNotDone, type Database, type StageName } from '@memecoinipedia/db';
import type { Kysely } from 'kysely';
import { DEFAULT_IPFS_GATEWAYS } from '../sources/metadata/fetch.js';
import { GET_ASSET_BATCH_CREDITS, MAX_ASSETS_PER_REQUEST } from '../sources/helius/costs.js';
import { JUPITER_MAX_MINTS_PER_REQUEST } from '../sources/jupiter/client.js';
import type { ParsedSample, SampleCoinInfo } from './seed.js';
import { requirementOf } from './stage.js';

export interface ProviderEstimate {
  /** Absent when the provider's request count cannot be estimated (Codex.io is estimated in units). */
  requests?: number;
  /** Credits (Helius). Absent for providers that charge none. */
  credits?: number;
  /** Compute units (Codex.io). */
  units?: number;
  /** The most requests the run could make if every coin used every fallback. */
  maxRequests?: number;
  note?: string;
}

export interface Estimate {
  helius?: ProviderEstimate;
  jupiter?: ProviderEstimate;
  'metadata-fetch'?: ProviderEstimate;
  codex?: ProviderEstimate;
}

/**
 * Compute units one coin costs the candles stage, by sampling cell, from the
 * plan's estimate (A5c). Probe coins are the large, hard ones. A coin whose cell
 * is missing or unknown is counted at the highest figure so the estimate is
 * never low because of a gap in the file.
 */
export const CANDLE_UNITS_BY_CELL: Readonly<Record<string, number>> = {
  '30k-50k': 16,
  '50k-100k': 18,
  '100k-1M': 20,
  '1M-10M': 35,
  '10M+': 80,
};
export const CANDLE_UNITS_PROBE = 42;
export const CANDLE_UNITS_UNKNOWN_CELL = 80;

export interface CandleEstimateRow {
  /** The cell, `probe` for probe coins, or `unknown`. */
  label: string;
  coins: number;
  unitsPerCoin: number;
  units: number;
}

export interface CandleEstimate {
  coins: number;
  rows: CandleEstimateRow[];
  totalUnits: number;
}

export function estimateCandleUnits(
  coins: readonly (SampleCoinInfo | undefined)[],
): CandleEstimate {
  const by = new Map<string, CandleEstimateRow>();
  for (const info of coins) {
    let label: string;
    let per: number;
    if (info?.probe) {
      label = 'probe';
      per = CANDLE_UNITS_PROBE;
    } else if (info && CANDLE_UNITS_BY_CELL[info.cell] !== undefined) {
      label = info.cell;
      per = CANDLE_UNITS_BY_CELL[info.cell]!;
    } else {
      label = 'unknown';
      per = CANDLE_UNITS_UNKNOWN_CELL;
    }
    const row = by.get(label) ?? { label, coins: 0, unitsPerCoin: per, units: 0 };
    row.coins += 1;
    row.units += per;
    by.set(label, row);
  }
  const order = [...Object.keys(CANDLE_UNITS_BY_CELL), 'probe', 'unknown'];
  const rows = order.flatMap((l) => (by.has(l) ? [by.get(l)!] : []));
  return {
    coins: coins.length,
    rows,
    totalUnits: rows.reduce((sum, r) => sum + r.units, 0),
  };
}

export interface IngestPlan {
  file: string;
  /** Host and database name only; never the password. */
  database: string | null;
  rowsRead: number;
  validCoins: number;
  invalidRows: number;
  duplicateRows: number;
  stages: StageName[];
  /** Coins in the file not yet discovered in the database. */
  toSeed: number;
  /** Coins each stage would run for. */
  stageWork: Partial<Record<StageName, number>>;
  estimate: Estimate;
  /** The candles estimate by cell, when the candles stage is selected. */
  candles: CandleEstimate | null;
  maxHeliusCredits: number | null;
  maxCodexUnits: number | null;
  /** False when the Helius estimate is above the ceiling. */
  withinCeiling: boolean;
  /** False when the Codex.io estimate is above the unit ceiling. */
  withinCodexCeiling: boolean;
  nothingToDo: boolean;
}

export function estimateMetadata(coins: number, gateways = DEFAULT_IPFS_GATEWAYS.length): Estimate {
  if (coins <= 0) return {};
  const heliusRequests = Math.ceil(coins / MAX_ASSETS_PER_REQUEST);
  return {
    helius: {
      requests: heliusRequests,
      credits: heliusRequests * GET_ASSET_BATCH_CREDITS,
      note: 'one getAssetBatch request per 1,000 coins, 10 credits each',
    },
    jupiter: {
      requests: Math.ceil(coins / JUPITER_MAX_MINTS_PER_REQUEST),
      note: 'one request per 100 coins; no credits',
    },
    'metadata-fetch': {
      requests: coins,
      maxRequests: coins * gateways,
      note: 'one request per coin that has a metadata URI; each unanswered gateway adds one',
    },
  };
}

export function describeDatabase(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return `${u.hostname}${u.port ? `:${u.port}` : ''}/${u.pathname.replace(/^\//, '')}`;
  } catch {
    return '(unreadable DATABASE_URL)';
  }
}

async function existingAddresses(db: Kysely<Database>, addresses: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < addresses.length; i += 5000) {
    const rows = await db
      .selectFrom('coins')
      .select('address')
      .where('chain', '=', 'solana')
      .where('address', 'in', addresses.slice(i, i + 5000))
      .execute();
    for (const r of rows) found.add(r.address);
  }
  return found;
}

/** Addresses whose `stage` is failed with `maxAttempts` or more attempts: left failed by a run. */
async function failedForGood(
  db: Kysely<Database>,
  stage: StageName,
  addresses: string[],
  maxAttempts: number,
): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < addresses.length; i += 5000) {
    const rows = await db
      .selectFrom('coin_stages as s')
      .innerJoin('coins', 'coins.id', 's.coin_id')
      .select('coins.address')
      .where('s.stage', '=', stage)
      .where('s.status', '=', 'failed')
      .where('s.attempts', '>=', maxAttempts)
      .where('coins.chain', '=', 'solana')
      .where('coins.address', 'in', addresses.slice(i, i + 5000))
      .execute();
    for (const r of rows) out.add(r.address);
  }
  return out;
}

export interface PlanInput {
  file: string;
  sample: ParsedSample;
  stages: readonly StageName[];
  /** Null when no database is configured: everything counts as to do. */
  db: Kysely<Database> | null;
  databaseUrl?: string | undefined;
  maxHeliusCredits?: number | null | undefined;
  maxCodexUnits?: number | null | undefined;
  /** Failed stages with this many attempts are left alone. Default 3. */
  maxAttempts?: number;
  /** Count failed stages as work even when their attempts are used up (they will be requeued). */
  retryFailed?: boolean;
  /** Current versions of the stages, by name. Default 1 each. */
  versions?: Partial<Record<StageName, number>>;
}

export async function planIngest(input: PlanInput): Promise<IngestPlan> {
  const addresses = input.sample.coins.map((c) => c.address);
  const wants = (s: StageName) => input.stages.includes(s);
  const version = (s: StageName) => input.versions?.[s] ?? 1;
  const attempts = input.retryFailed ? {} : { maxAttempts: input.maxAttempts ?? 3 };

  let toSeed = addresses.length;
  const stageWork: Partial<Record<StageName, number>> = {};
  let candleAddresses: string[] = addresses;
  if (input.db === null) {
    for (const s of input.stages) stageWork[s] = addresses.length;
  } else {
    const db = input.db;
    const existing = await existingAddresses(db, addresses);
    const absent = addresses.length - existing.size;
    const notDiscovered = await listCoinsNotDone(db, 'discovered', {
      addresses,
      version: version('discovered'),
      ...attempts,
    });
    toSeed = absent + notDiscovered.length;
    for (const s of input.stages) {
      if (s === 'discovered') {
        stageWork[s] = toSeed;
        continue;
      }
      // A stage needs the one it requires done. Coins not yet seeded count when this run seeds them.
      const prev = requirementOf(s) ?? undefined;
      const rows = await listCoinsNotDone(db, s, {
        addresses,
        version: version(s),
        ...attempts,
        ...(prev && !wants(prev) ? { requires: prev } : {}),
      });
      // Coins not yet in the table appear only if this run seeds them.
      // A coin whose required stage failed and is left failed (attempts used up) cannot run this
      // one either, so it is not work. With --retry-failed that stage is requeued, so it counts.
      const blocked =
        prev && wants(prev) && !input.retryFailed
          ? await failedForGood(db, prev, addresses, input.maxAttempts ?? 3)
          : new Set<string>();
      const workable = rows.filter((r) => !blocked.has(r.address));
      stageWork[s] = workable.length + (prev && wants(prev) ? absent : 0);
      if (s === 'candles') {
        const unseeded = prev && wants(prev) ? addresses.filter((a) => !existing.has(a)) : [];
        candleAddresses = [...workable.map((r) => r.address), ...unseeded];
      }
    }
  }

  const metadataWork = stageWork['metadata'] ?? 0;
  const estimate = wants('metadata') ? estimateMetadata(metadataWork) : {};
  const ceiling = input.maxHeliusCredits ?? null;
  const credits = estimate.helius?.credits ?? 0;
  let candles: CandleEstimate | null = null;
  if (wants('candles')) {
    candles = estimateCandleUnits(candleAddresses.map((a) => input.sample.info.get(a)));
    estimate.codex = { units: candles.totalUnits, note: 'candles stage, by sampling cell' };
  }
  const codexCeiling = input.maxCodexUnits ?? null;
  return {
    file: input.file,
    database: describeDatabase(input.databaseUrl),
    rowsRead: input.sample.rowsRead,
    validCoins: addresses.length,
    invalidRows: input.sample.problems.length,
    duplicateRows: input.sample.duplicates,
    stages: [...input.stages],
    toSeed: wants('discovered') ? toSeed : 0,
    stageWork,
    estimate,
    candles,
    maxHeliusCredits: ceiling,
    maxCodexUnits: codexCeiling,
    withinCeiling: ceiling === null || credits <= ceiling,
    withinCodexCeiling: codexCeiling === null || (candles?.totalUnits ?? 0) <= codexCeiling,
    nothingToDo: input.stages.every((s) => (stageWork[s] ?? 0) === 0),
  };
}

const fmt = (n: number) => n.toLocaleString('en-US');

export function formatPlan(plan: IngestPlan, confirmed: boolean): string {
  const lines: string[] = [];
  lines.push(`Sample file: ${plan.file}`);
  lines.push(
    `  ${fmt(plan.rowsRead)} rows read: ${fmt(plan.validCoins)} valid coins, ` +
      `${fmt(plan.invalidRows)} rows rejected, ${fmt(plan.duplicateRows)} repeated mints`,
  );
  lines.push(`Database: ${plan.database ?? '(none configured)'}`);
  lines.push(`Stages: ${plan.stages.join(', ')}`);
  lines.push('Work:');
  for (const s of plan.stages) lines.push(`  ${s}: ${fmt(plan.stageWork[s] ?? 0)} coins`);
  lines.push('Estimate:');
  const e = plan.estimate;
  if (e.helius) {
    lines.push(
      `  helius: ${fmt(e.helius.requests ?? 0)} requests, ${fmt(e.helius.credits ?? 0)} credits` +
        (plan.maxHeliusCredits === null ? '' : ` (ceiling ${fmt(plan.maxHeliusCredits)})`),
    );
  }
  if (e.jupiter) lines.push(`  jupiter: ${fmt(e.jupiter.requests ?? 0)} requests, no credits`);
  if (e['metadata-fetch']) {
    const m = e['metadata-fetch'];
    lines.push(
      `  metadata gateways: about ${fmt(m.requests ?? 0)} requests, at most ${fmt(m.maxRequests ?? m.requests ?? 0)}`,
    );
  }
  if (plan.candles) {
    const c = plan.candles;
    lines.push(
      `  codex.io: about ${fmt(Math.round(c.totalUnits))} compute units for ${fmt(c.coins)} coins` +
        (plan.maxCodexUnits === null
          ? ' (no ceiling set)'
          : ` (ceiling ${fmt(plan.maxCodexUnits)})`),
    );
    for (const r of c.rows) {
      lines.push(
        `    ${r.label.padEnd(8)} ${fmt(r.coins).padStart(5)} coins x ${String(r.unitsPerCoin).padStart(3)} = ${fmt(Math.round(r.units))} units`,
      );
    }
  }
  if (Object.keys(e).length === 0) lines.push('  no provider calls');
  if (!plan.candles) lines.push('  codex.io: none.');
  lines.push('  dune: none.');
  if (!plan.withinCeiling) {
    lines.push(
      `WARNING: the Helius estimate is above --max-helius-credits; the run would stop at the ceiling.`,
    );
  }
  if (!plan.withinCodexCeiling) {
    lines.push(
      `WARNING: the Codex.io estimate is above --max-codex-units; the run would stop at the ceiling.`,
    );
  }
  if (plan.nothingToDo) lines.push('Nothing to do: every coin is already through these stages.');
  else if (!confirmed)
    lines.push('Dry run: no call was made and nothing was written. Pass --confirm to run.');
  return lines.join('\n');
}
