/**
 * GraphQL documents for the Codex.io API. Every field here was used by
 * probes/codex-probe.mjs or confirmed against the live API when the fixtures
 * were recorded (ingest/scripts/record-codex-fixtures.ts). Do not add fields
 * that have not been confirmed.
 *
 * Values are interpolated, not sent as GraphQL variables, because that is how
 * the probe called the API. Mints and pool addresses are validated as base58
 * before they are interpolated, so nothing can break out of the string.
 */

/** Codex network id for Solana. */
export const SOLANA_NETWORK_ID = 1399811149;

/** Codex returns spend as micro-units in this field of every response that asks for it. */
export const USAGE_SELECTION = 'usageData{ total{computeUnits} }';

/** filterTokens: hard limits found against the live API on 2026-11-14. */
export const FILTER_TOKENS_MAX_LIMIT = 200;
/** `limit + offset` may not exceed this. */
export const FILTER_TOKENS_MAX_DEPTH = 10_000;

export const LAUNCHPAD_FIELDS =
  'launchpadName migrated migratedAt migratedPoolAddress completed completedAt poolAddress';

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function assertAddress(value: string, what: string): string {
  if (!BASE58.test(value)) throw new TypeError(`${what} is not a base58 Solana address`);
  return value;
}

function assertInt(value: number, what: string): number {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${what} must be an integer`);
  return value;
}

export interface FilterTokensArgs {
  gte: number;
  lte: number;
  limit: number;
  offset: number;
}

export function filterTokensQuery(a: FilterTokensArgs): string {
  assertInt(a.gte, 'gte');
  assertInt(a.lte, 'lte');
  assertInt(a.limit, 'limit');
  assertInt(a.offset, 'offset');
  return (
    `{ filterTokens(filters:{network:[${SOLANA_NETWORK_ID}], launchpadName:["Pump.fun"], ` +
    `launchpadMigrated:true, launchpadMigratedAt:{gte:${a.gte}, lte:${a.lte}}}, ` +
    `rankings:{attribute:launchpadMigratedAt, direction:ASC}, limit:${a.limit}, offset:${a.offset}) ` +
    `{ count page results { token { address symbol name createdAt creatorAddress ` +
    `launchpad { ${LAUNCHPAD_FIELDS} } } pair { address } liquidity } } ${USAGE_SELECTION} }`
  );
}

export function tokenQuery(mint: string): string {
  assertAddress(mint, 'mint');
  return (
    `{ token(input:{address:"${mint}", networkId:${SOLANA_NETWORK_ID}}) ` +
    `{ address symbol name createdAt creatorAddress launchpad { ${LAUNCHPAD_FIELDS} } } ` +
    `${USAGE_SELECTION} }`
  );
}

/** Codex's result cap for one listPairsWithMetadataForToken call. */
export const PAIRS_LIMIT = 250;

export function pairsQuery(mint: string): string {
  assertAddress(mint, 'mint');
  return (
    `{ listPairsWithMetadataForToken(tokenAddress:"${mint}", networkId:${SOLANA_NETWORK_ID}, ` +
    `limit:${PAIRS_LIMIT}){ results{ liquidity volume quoteToken backingToken{address symbol} ` +
    `exchange{name} pair{ address createdAt protocol exchangeHash token0 token1 } } } ` +
    `${USAGE_SELECTION} }`
  );
}

/** Codex resolution strings for the three resolutions the project uses. */
export type BarResolution = '1' | '60' | '1D';

export const BAR_FIELDS =
  't o h l c volume buyers sellers buys sells traders transactions liquidity s';

export function barsQuery(
  pairAddress: string,
  from: number,
  to: number,
  resolution: BarResolution,
): string {
  assertAddress(pairAddress, 'pair address');
  assertInt(from, 'from');
  assertInt(to, 'to');
  return (
    `{ getBars(symbol:"${pairAddress}:${SOLANA_NETWORK_ID}", from:${from}, to:${to}, ` +
    `resolution:"${resolution}" removeEmptyBars:true) { ${BAR_FIELDS} } ${USAGE_SELECTION} }`
  );
}
