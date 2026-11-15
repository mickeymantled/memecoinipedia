import { describe } from 'vitest';
import { discoverCoins, type Database, type DiscoveredCoin } from '@memecoinipedia/db';
import { getTestAdminUrl } from '@memecoinipedia/db/testing';
import { sql, type Kysely } from 'kysely';
import type { AssetInfo } from '../../src/sources/helius/client.js';
import type { JupiterToken } from '../../src/sources/jupiter/client.js';
import type { MetadataOutcome, MetadataResult } from '../../src/sources/metadata/fetch.js';
import { parseTokenMetadata, stripNulDeep } from '../../src/sources/metadata/parse.js';
import { consoleLogger, silentLogger, type Logger } from '../../src/worker/log.js';

export const adminUrl = getTestAdminUrl();
export const describeDb = describe.skipIf(!adminUrl);

if (!adminUrl) {
  process.stderr.write(
    '\n*** TEST_DATABASE_ADMIN_URL is not set: worker database tests are SKIPPED. ***\n\n',
  );
}

export const testLog: Logger = process.env['TEST_LOG'] ? consoleLogger() : silentLogger;

/** A syntactically valid mint: 44 base58 characters. */
export const mintN = (n: number): string =>
  `Mint${n
    .toString(9)
    .split('')
    .map((d) => String(Number(d) + 1))
    .join('')}`.padEnd(44, 'x');

export function coinRow(address: string, extra: Partial<DiscoveredCoin> = {}): DiscoveredCoin {
  return {
    chain: 'solana',
    address,
    launchpad: 'pump.fun',
    launchedAt: new Date('2024-05-21T04:58:06Z'),
    creatorWallet: null,
    graduatedAt: null,
    discoverySource: 'test',
    roughAthMarketCapUsd: 250_000,
    ...extra,
  };
}

/** Seeds coins (discovered stage done) and returns address to id. */
export async function seedCoins(
  db: Kysely<Database>,
  addresses: string[],
): Promise<Map<string, number>> {
  await discoverCoins(
    db,
    addresses.map((a) => coinRow(a)),
    { now: new Date() },
  );
  const rows = await db.selectFrom('coins').select(['id', 'address']).execute();
  return new Map(rows.map((r) => [r.address, r.id]));
}

export const SPL = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

export function asset(mint: string, extra: Partial<AssetInfo> = {}): AssetInfo {
  return {
    mint,
    found: true,
    name: `Name ${mint.slice(0, 6)}`,
    symbol: `T${mint.slice(4, 7)}`,
    uri: `https://example.test/${mint}.json`,
    description: null,
    image: null,
    layout: 'metaplex',
    tokenProgram: 'spl-token',
    tokenProgramId: SPL,
    decimals: 6,
    supply: '1000000000000000',
    assetInterface: 'FungibleToken',
    invalid: null,
    ...extra,
  };
}

export function token(mint: string, extra: Partial<JupiterToken> = {}): JupiterToken {
  return {
    mint,
    found: true,
    priceUsd: 0.0002,
    liquidityUsd: 1500,
    volume24hUsd: 300,
    holderCount: 10,
    marketCapUsd: 200_000,
    fdvUsd: 200_000,
    circulatingSupply: 1e9,
    totalSupply: 1e9,
    isVerified: false,
    updatedAt: '2026-11-15T00:00:00Z',
    website: null,
    twitter: null,
    telegram: null,
    invalid: null,
    ...extra,
  };
}

export function okResult(
  json: Record<string, unknown>,
  gateway = 'ipfs.filebase.io',
): MetadataResult {
  const raw = stripNulDeep(json) as Record<string, unknown>;
  return {
    outcome: 'ok',
    gateway,
    attempts: [{ gateway, result: 'ok', status: 200, requests: 1 }],
    metadata: parseTokenMetadata(raw),
    raw,
    detail: null,
  };
}

export function badResult(
  outcome: Exclude<MetadataOutcome, 'ok'>,
  detail: string | null = null,
): MetadataResult {
  const result = {
    not_found: 'not_found',
    unreachable: 'timeout',
    invalid: 'invalid',
    too_large: 'too_large',
    unsupported_uri: 'blocked',
  }[outcome] as 'not_found';
  return {
    outcome,
    gateway: outcome === 'unsupported_uri' ? null : 'ipfs.filebase.io',
    attempts:
      outcome === 'unsupported_uri'
        ? []
        : [
            { gateway: 'ipfs.filebase.io', result, status: null, requests: 1 },
            { gateway: 'gateway.pinata.cloud', result, status: null, requests: 1 },
          ],
    metadata: null,
    raw: null,
    detail,
  };
}

export async function tableCounts(db: Kysely<Database>): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of [
    'coins',
    'coin_stages',
    'ingest_runs',
    'provider_usage',
    'data_issues',
  ] as const) {
    const r = await sql<{ n: string }>`select count(*)::text as n from ${sql.table(t)}`.execute(db);
    out[t] = Number(r.rows[0]?.n);
  }
  return out;
}

export async function schemaExists(db: Kysely<Database>, name: string): Promise<boolean> {
  const r = await sql<{ n: string }>`
    select count(*)::text as n from information_schema.schemata where schema_name = ${name}
  `.execute(db);
  return Number(r.rows[0]?.n) > 0;
}
