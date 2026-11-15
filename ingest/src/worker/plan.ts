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
import type { ParsedSample } from './seed.js';

export interface ProviderEstimate {
  requests: number;
  /** Credits (Helius). Absent for providers that charge none. */
  credits?: number;
  /** The most requests the run could make if every coin used every fallback. */
  maxRequests?: number;
  note?: string;
}

export interface Estimate {
  helius?: ProviderEstimate;
  jupiter?: ProviderEstimate;
  'metadata-fetch'?: ProviderEstimate;
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
  maxHeliusCredits: number | null;
  /** False when the Helius estimate is above the ceiling. */
  withinCeiling: boolean;
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

export interface PlanInput {
  file: string;
  sample: ParsedSample;
  stages: readonly StageName[];
  /** Null when no database is configured: everything counts as to do. */
  db: Kysely<Database> | null;
  databaseUrl?: string | undefined;
  maxHeliusCredits?: number | null | undefined;
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
      // A later stage needs the earlier one done. Coins not yet seeded count when this run seeds them.
      const prev = s === 'metadata' ? 'discovered' : undefined;
      const rows = await listCoinsNotDone(db, s, {
        addresses,
        version: version(s),
        ...attempts,
        ...(prev && !wants(prev) ? { requires: prev } : {}),
      });
      // Coins not yet in the table appear only if this run seeds them.
      stageWork[s] = rows.length + (prev && wants(prev) ? absent : 0);
    }
  }

  const metadataWork = stageWork['metadata'] ?? 0;
  const estimate = wants('metadata') ? estimateMetadata(metadataWork) : {};
  const ceiling = input.maxHeliusCredits ?? null;
  const credits = estimate.helius?.credits ?? 0;
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
    maxHeliusCredits: ceiling,
    withinCeiling: ceiling === null || credits <= ceiling,
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
      `  helius: ${fmt(e.helius.requests)} requests, ${fmt(e.helius.credits ?? 0)} credits` +
        (plan.maxHeliusCredits === null ? '' : ` (ceiling ${fmt(plan.maxHeliusCredits)})`),
    );
  }
  if (e.jupiter) lines.push(`  jupiter: ${fmt(e.jupiter.requests)} requests, no credits`);
  if (e['metadata-fetch']) {
    const m = e['metadata-fetch'];
    lines.push(
      `  metadata gateways: about ${fmt(m.requests)} requests, at most ${fmt(m.maxRequests ?? m.requests)}`,
    );
  }
  if (Object.keys(e).length === 0) lines.push('  no provider calls');
  lines.push('  codex.io: none. dune: none.');
  if (!plan.withinCeiling) {
    lines.push(
      `WARNING: the Helius estimate is above --max-helius-credits; the run would stop at the ceiling.`,
    );
  }
  if (plan.nothingToDo) lines.push('Nothing to do: every coin is already through these stages.');
  else if (!confirmed)
    lines.push('Dry run: no call was made and nothing was written. Pass --confirm to run.');
  return lines.join('\n');
}
