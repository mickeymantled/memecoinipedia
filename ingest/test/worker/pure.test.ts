import { describe, expect, it } from 'vitest';
import { PrefetchLoader } from '../../src/worker/batch.js';
import { scrub } from '../../src/worker/log.js';
import { estimateMetadata, formatPlan } from '../../src/worker/plan.js';
import { parseCsv, parseSampleCsv } from '../../src/worker/seed.js';
import { StageRegistry, type Stage } from '../../src/worker/stage.js';
import { droppedSocialLinks } from '../../src/worker/stages/metadata.js';
import { imageReference } from '../../src/worker/stages/image.js';
import { mintN } from './helpers.js';

const HEADER =
  'mint,half_year,cell,probe,cell_size,created_at,creator,graduated_at,hours,peak_max_usd,peak_p999_usd,peak_at';
const row = (mint: string, created: string, creator: string, grad: string, peak: string) =>
  `${mint},2024-H1,100k-1M,true,2,${created},${creator},${grad},670,934000,${peak},2024-05-21T15:00:00Z`;

describe('sample CSV', () => {
  it('parses quoted fields, doubled quotes and CRLF', () => {
    expect(parseCsv('a,b\r\n"x,1","he said ""hi"""\r\n\r\n')).toEqual([
      ['a', 'b'],
      ['x,1', 'he said "hi"'],
    ]);
  });

  it('maps columns and keeps creation and graduation time apart', () => {
    const creator = mintN(900);
    const text = [
      HEADER,
      row(mintN(1), '2024-05-21T04:58:06Z', creator, '2024-05-21T06:21:58Z', '934000.5'),
      row(mintN(2), '2024-05-22T03:35:04Z', creator, '', ''),
    ].join('\n');
    const r = parseSampleCsv(text);
    expect(r.problems).toEqual([]);
    expect(r.coins).toHaveLength(2);
    expect(r.coins[0]).toEqual({
      chain: 'solana',
      address: mintN(1),
      launchpad: 'pump.fun',
      launchedAt: new Date('2024-05-21T04:58:06Z'),
      creatorWallet: creator,
      graduatedAt: new Date('2024-05-21T06:21:58Z'),
      discoverySource: 'dune-2026-11-15',
      roughAthMarketCapUsd: 934000.5,
    });
    expect(r.coins[1]).toMatchObject({ graduatedAt: null, roughAthMarketCapUsd: null });
  });

  it('reports bad rows and repeated mints instead of guessing', () => {
    const ok = mintN(1);
    const text = [
      HEADER,
      row(ok, '2024-05-21T04:58:06Z', ok, '', '1'),
      row(ok, '2024-05-21T04:58:06Z', ok, '', '2'), // repeat: first kept
      row('not-a-mint', '2024-05-21T04:58:06Z', ok, '', '1'),
      row(mintN(2), 'yesterday', ok, '', '1'),
      row(mintN(3), '', ok, '', '1'),
      row(mintN(4), '2024-05-21T04:58:06Z', ok, '', '-5'),
    ].join('\n');
    const r = parseSampleCsv(text);
    expect(r.rowsRead).toBe(6);
    expect(r.coins.map((c) => c.address)).toEqual([ok]);
    expect(r.coins[0]?.roughAthMarketCapUsd).toBe(1);
    expect(r.duplicates).toBe(1);
    expect(r.problems.map((p) => p.line)).toEqual([4, 5, 6, 7]);
  });

  it('refuses a file without the columns it needs', () => {
    expect(() => parseSampleCsv('mint,created_at\nx,y')).toThrow(/lacks column/);
  });
});

describe('imageReference', () => {
  const CID = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
  const BAFY = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
  const AR = 'a'.repeat(43);
  it('drops the gateway host from IPFS addresses', () => {
    expect(imageReference(`ipfs://${CID}`)).toBe(`ipfs://${CID}`);
    expect(imageReference(`ipfs://${CID}/img.png`)).toBe(`ipfs://${CID}/img.png`);
    expect(imageReference(`https://ipfs.io/ipfs/${CID}`)).toBe(`ipfs://${CID}`);
    expect(imageReference(`https://gateway.pinata.cloud/ipfs/${CID}/a/b.png?x=1`)).toBe(
      `ipfs://${CID}/a/b.png`,
    );
    expect(imageReference(`https://${BAFY}.ipfs.dweb.link/pic.jpg`)).toBe(`ipfs://${BAFY}/pic.jpg`);
  });
  it('turns Arweave addresses into ar:// and keeps other URLs as they are', () => {
    expect(imageReference(`https://arweave.net/${AR}`)).toBe(`ar://${AR}`);
    expect(imageReference(`ar://${AR}/x.png`)).toBe(`ar://${AR}/x.png`);
    expect(imageReference('https://cdn.example.com/a/b.png?v=2')).toBe(
      'https://cdn.example.com/a/b.png?v=2',
    );
  });
  it('gives null for nothing, or for an address that cannot be read', () => {
    expect(imageReference(null)).toBeNull();
    expect(imageReference('ipfs://not-a-cid')).toBeNull();
  });
});

describe('droppedSocialLinks', () => {
  const none = { twitter: null, telegram: null, website: null };
  it('counts values the URL rule refused, not absent or empty ones', () => {
    expect(
      droppedSocialLinks(
        { twitter: '@someone', telegram: '', website: 'example.com', other: 'x' },
        none,
      ),
    ).toEqual([
      { field: 'twitter', value: '@someone' },
      { field: 'website', value: 'example.com' },
    ]);
    expect(
      droppedSocialLinks(
        { twitter: 'https://x.com/a' },
        { twitter: 'https://x.com/a', telegram: null, website: null },
      ),
    ).toEqual([]);
  });
});

describe('PrefetchLoader', () => {
  const make = (extra: { fail?: boolean } = {}) => {
    const calls: string[][] = [];
    const queue = Array.from({ length: 25 }, (_, i) => `k${i}`);
    const loader = new PrefetchLoader<string>({
      maxBatch: 10,
      candidates: async (_f, limit) => queue.slice(0, limit),
      missing: (k) => `missing:${k}`,
      fetch: async (keys) => {
        calls.push(keys);
        if (extra.fail) throw new Error('down');
        return new Map(keys.filter((k) => k !== 'k3').map((k) => [k, `v:${k}`]));
      },
      errorCooldownMs: 1000,
      now: () => 0,
    });
    return { loader, calls };
  };

  it('answers concurrent asks from one request per batch', async () => {
    const { loader, calls } = make();
    const answers = await Promise.all(Array.from({ length: 25 }, (_, i) => loader.get(`k${i}`)));
    expect(answers[0]).toBe('v:k0');
    expect(answers[3]).toBe('missing:k3'); // the source left it out
    // 25 keys in batches of 10: three requests, not 25.
    expect(calls.map((c) => c.length)).toEqual([10, 10, 5]);
    expect(new Set(calls.flat()).size).toBe(25);
  });

  it('does not fetch again for a key it has', async () => {
    const { loader, calls } = make();
    await loader.get('k1');
    await loader.get('k1');
    await loader.get('k2');
    expect(calls).toHaveLength(1);
  });

  it('after a failure, fails at once for a while instead of repeating the request', async () => {
    const { loader, calls } = make({ fail: true });
    await expect(loader.get('k1')).rejects.toThrow('down');
    await expect(loader.get('k2')).rejects.toThrow('down');
    await expect(loader.get('k3')).rejects.toThrow('down');
    expect(calls).toHaveLength(1);
  });
});

describe('StageRegistry', () => {
  const stage = (name: Stage['name']): Stage => ({
    name,
    version: 1,
    run: async () => ({ status: 'done' }),
  });
  it('takes stages in pipeline order with no gaps', () => {
    expect(() => new StageRegistry().register(stage('metadata'))).toThrow(/out of order/);
    const r = new StageRegistry().register(stage('discovered')).register(stage('metadata'));
    expect(r.next('discovered')?.name).toBe('metadata');
    expect(r.next('metadata')).toBeUndefined(); // the pipeline stops after metadata until part 3
    expect(r.previous('metadata')?.name).toBe('discovered');
    expect(() => r.register(stage('metrics'))).toThrow(/out of order/);
    r.register(stage('candles')).register(stage('metrics'));
    expect(r.next('metadata')?.name).toBe('candles');
  });
  it('rejects a version that is not a positive integer', () => {
    expect(() => new StageRegistry().register({ ...stage('discovered'), version: 0 })).toThrow();
  });
});

describe('estimate and plan text', () => {
  it('one Helius request per 1,000 coins and one Jupiter request per 100', () => {
    const e = estimateMetadata(500);
    expect(e.helius).toMatchObject({ requests: 1, credits: 10 });
    expect(e.jupiter).toMatchObject({ requests: 5 });
    expect(e['metadata-fetch']).toMatchObject({ requests: 500, maxRequests: 1000 });
    expect(estimateMetadata(1001).helius).toMatchObject({ requests: 2, credits: 20 });
    expect(estimateMetadata(0)).toEqual({});
  });

  it('formats a plan with the dry-run notice', () => {
    const text = formatPlan(
      {
        file: 'f.csv',
        database: 'localhost:5432/x',
        rowsRead: 500,
        validCoins: 500,
        invalidRows: 0,
        duplicateRows: 0,
        stages: ['discovered', 'metadata'],
        toSeed: 500,
        stageWork: { discovered: 500, metadata: 500 },
        estimate: estimateMetadata(500),
        maxHeliusCredits: 300,
        withinCeiling: true,
        nothingToDo: false,
      },
      false,
    );
    expect(text).toContain('helius: 1 requests, 10 credits (ceiling 300)');
    expect(text).toContain('Dry run: no call was made and nothing was written');
  });
});

describe('scrub', () => {
  it('removes secrets and api-key query text', () => {
    expect(
      scrub('GET https://x/?api-key=abc123&y=1 with secret-value-123', ['secret-value-123']),
    ).toBe('GET https://x/?api-key=[redacted]&y=1 with [redacted]');
    expect(scrub('short abc', ['abc'])).toBe('short abc');
  });
});
