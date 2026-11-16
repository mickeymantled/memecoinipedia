/**
 * The coin list for `backfill run --refresh-pools --coins FILE`: one coin id (digits) or mint
 * address per line. Blank lines and lines starting with `#` are ignored, and so is anything after
 * the first whitespace or comma on a line (so a CSV with the coin in its first column works).
 */
import { readFile } from 'node:fs/promises';
import {
  resolveCoinRefs,
  selectCoinsByRule,
  type CoinRule,
  type Database,
} from '@memecoinipedia/db';
import type { Kysely } from 'kysely';
import { DEFAULT_PLAN_LIMITS } from '../candles/plan.js';

export function parseCoinRefs(text: string): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const ref = line.split(/[\s,]/)[0]!;
    if (!/^(\d+|[1-9A-HJ-NP-Za-km-z]{32,44})$/.test(ref)) {
      throw new Error(`Not a coin id or a mint address: "${ref.slice(0, 50)}"`);
    }
    if (!seen.has(ref)) {
      seen.add(ref);
      refs.push(ref);
    }
  }
  return refs;
}

/** The coins of a refresh: ids, a file of ids and addresses, or a rule that reads the database. */
export type RefreshSelection =
  { coinIds: readonly number[] } | { coinsFile: string } | { rule: CoinRule };

/**
 * The coin ids of a refresh. A rule reads stored data only and asks no provider; its distance is
 * the candle plan's `maxGraduationPoolDelaySeconds`.
 */
export async function resolveRefreshCoins(
  db: Kysely<Database>,
  selection: RefreshSelection,
): Promise<readonly number[]> {
  if ('coinIds' in selection) return selection.coinIds;
  if ('coinsFile' in selection) return readCoinIds(db, selection.coinsFile);
  return selectCoinsByRule(db, selection.rule, {
    maxDelaySeconds: DEFAULT_PLAN_LIMITS.maxGraduationPoolDelaySeconds,
  });
}

/** Reads the file and resolves it to coin ids; every reference must match a coin. */
export async function readCoinIds(db: Kysely<Database>, file: string): Promise<number[]> {
  const refs = parseCoinRefs(await readFile(file, 'utf8'));
  if (refs.length === 0) throw new Error('The coin list is empty');
  const { ids, unknown } = await resolveCoinRefs(db, refs);
  if (unknown.length > 0) {
    throw new Error(
      `${unknown.length} of ${refs.length} coins in the list are not in the database (first: ${unknown[0]})`,
    );
  }
  return ids;
}
