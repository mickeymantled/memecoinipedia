import { describe, expect, it } from 'vitest';
import { HeliusClient } from '../../../src/sources/helius/index.js';
import { cleanText } from '../../../src/sources/metadata/parse.js';
import { imageReference } from '../../../src/worker/stages/image.js';
import { fakeClock } from '../helpers.js';
import { fakeRpcFetch, fixtureText } from '../net-helpers.js';

const KEY = 'helius-test-key-0123456789abcdef';
const NON_TOKEN = '11111111111111111111111111111111';
const VANGOAT = '82DC7kRHVwkVEuK8NjbrwDDqbfkTrQWXuCp4T6C9noie';
const COP = 'copJmvZPQayNtCmaEMC9wGwQKvtw16PzHQEhesbsHsq';
const DODGE = 'DwpnoX1YvBSkRFUJyvgeYamptg7WEb3DvV315dAUpump';
const WIZARD = 'C8T9P27ABMvLHsRKEavFqa9etSsfw8EqkF2XkzT4pump';
const ROSE = 'HfVxfzmAPWER3LQ8VbDcbch6ACchbpuyXv3ujgRtpump';
const DUMACRATS = 'GqmP8uGseERgZYa7NAvzNrFw9qbGzMM6YnpwWiH46TGX';
const GOYIM = '9S8edqWxoWz5LYLnxWUmWBJnePg35WfdYQp7HQkUpump';
const FIXTURE_MINTS = [VANGOAT, COP, DODGE, WIZARD, ROSE, DUMACRATS, GOYIM, NON_TOKEN];

async function assetsFromFixture() {
  const f = fakeRpcFetch([{ body: fixtureText('helius', 'asset-batch') }]);
  const clock = fakeClock();
  const c = new HeliusClient({
    apiKey: KEY,
    fetch: f.fetch,
    http: { sleep: clock.sleep, random: () => 0.5, baseDelayMs: 10 },
  });
  return c.getAssets(FIXTURE_MINTS);
}

describe('getAssets: description and image', () => {
  it('reads content.metadata.description and content.links.image; 5 of 7 assets carry a description, 7 of 7 an image', async () => {
    const assets = (await assetsFromFixture()).filter((a) => a.found);
    expect(assets).toHaveLength(7);
    const by = Object.fromEntries(assets.map((a) => [a.mint, a]));
    expect(by[VANGOAT]?.description).toBe(
      "I'm the greatest of all time, I'm also a goat.\r\n\r\nCheck out my GOATxibit.",
    );
    expect(by[VANGOAT]?.image).toBe(
      'https://ipfs.io/ipfs/QmTNWvHkup5HUtpwkQ2Hut1z3fGBgBFVD4w9GEaCA8ZNHC',
    );
    expect(by[ROSE]?.description).toBe(''); // an empty string: blank, stored as null
    expect(by[DUMACRATS]?.description).toBeNull(); // no description at all
    expect(assets.filter((a) => cleanText(a.description) !== null)).toHaveLength(5);
    expect(assets.filter((a) => imageReference(a.image) !== null)).toHaveLength(7);
  });

  it('a not-found mint has neither', async () => {
    const none = (await assetsFromFixture()).find((a) => a.mint === NON_TOKEN)!;
    expect(none).toMatchObject({ found: false, description: null, image: null });
  });
});

describe('cleanText', () => {
  it('removes NUL, turns blank into null and keeps everything else as written', () => {
    expect(cleanText('  a\u0000b \n')).toBe('  ab \n');
    expect(cleanText('   ')).toBeNull();
    expect(cleanText('')).toBeNull();
    expect(cleanText('\u0000')).toBeNull();
    expect(cleanText(null)).toBeNull();
    expect(cleanText(undefined)).toBeNull();
  });
});
