import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Kysely } from 'kysely';
import { upsertCoin } from './coins.js';
import type { Database } from './types.js';

export const DEFAULT_SEED_FILE = fileURLToPath(new URL('../seed/coins.json', import.meta.url));

interface SeedCoin {
  mint: string;
  symbol: string;
  name: string;
}

/** Loads db/seed/coins.json (the 20 probe coins). Safe to run repeatedly. */
export async function seed(db: Kysely<Database>, file = DEFAULT_SEED_FILE): Promise<number> {
  const coins = JSON.parse(await readFile(file, 'utf8')) as SeedCoin[];
  for (const c of coins) {
    await upsertCoin(db, {
      chain: 'solana',
      address: c.mint,
      ticker: c.symbol,
      name: c.name,
      launchpad: 'pump.fun',
    });
  }
  return coins.length;
}
