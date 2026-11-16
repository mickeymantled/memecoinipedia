import { describe, expect, it } from 'vitest';
import { HeliusClient, HeliusResponseError } from '../../../src/sources/helius/index.js';
import { fakeRpcFetch, fixtureText, rpcResult } from '../net-helpers.js';

const VANGOAT = '82DC7kRHVwkVEuK8NjbrwDDqbfkTrQWXuCp4T6C9noie';
const ROSE = 'HfVxfzmAPWER3LQ8VbDcbch6ACchbpuyXv3ujgRtpump';
const DODGE = 'DwpnoX1YvBSkRFUJyvgeYamptg7WEb3DvV315dAUpump';
const NON_TOKEN = '11111111111111111111111111111111';

const client = (f: ReturnType<typeof fakeRpcFetch>) =>
  new HeliusClient({ apiKey: 'test-key-123', fetch: f.fetch, http: { maxRetries: 0 } });

describe('one unreadable row does not fail the batch', () => {
  it('returns the odd row as found with an invalid marker, and the rest as normal', async () => {
    const good = JSON.parse(fixtureText('helius', 'asset-batch')).result[0];
    const rows = [
      good,
      {
        id: ROSE,
        interface: 'FungibleToken',
        content: 'not an object',
        token_info: { supply: 'many' },
      },
      { content: {} }, // no id: cannot be matched to a mint
      null,
    ];
    const f = fakeRpcFetch([{ body: rpcResult(rows) }]);
    const assets = await client(f).getAssets([VANGOAT, ROSE, DODGE, NON_TOKEN]);
    expect(f.requests).toHaveLength(1);
    const by = Object.fromEntries(assets.map((a) => [a.mint, a]));

    expect(by[VANGOAT]).toMatchObject({ found: true, name: 'Vincent Van Goat', invalid: null });

    expect(by[ROSE]?.found).toBe(true);
    expect(by[ROSE]?.invalid?.length).toBeGreaterThan(0);
    expect(by[ROSE]).toMatchObject({
      name: null,
      symbol: null,
      uri: null,
      layout: null,
      tokenProgram: null,
      decimals: null,
      supply: null,
    });

    expect(by[DODGE]).toMatchObject({ found: false, invalid: null });
    expect(by[NON_TOKEN]).toMatchObject({ found: false, invalid: null });
  });

  it('still throws when the result is not an array at all', async () => {
    const f = fakeRpcFetch([{ body: rpcResult({ not: 'an array' }) }]);
    await expect(client(f).getAssets(['X'])).rejects.toBeInstanceOf(HeliusResponseError);
  });
});
