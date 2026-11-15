import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestDatabase } from '@memecoinipedia/db/testing';
import { createTestDatabase, getTestAdminUrl } from '@memecoinipedia/db/testing';
import { describe } from 'vitest';
import { seedFromCandidateFile } from '../../src/backfill/seed.js';
import { UnitBudget } from '../../src/sources/budget.js';
import { CodexClient } from '../../src/sources/codex/index.js';
import type { PostJsonOptions } from '../../src/sources/http.js';
import type { RateLimiter } from '../../src/sources/ratelimit.js';
import { silentLogger } from '../../src/worker/log.js';
import type { SourceClients } from '../../src/worker/run.js';
import { asset, okResult, token } from '../worker/helpers.js';
import { synthProvider, writeCandidateFile, type SynthProvider } from './synthetic.js';

export const adminUrl = getTestAdminUrl();
export const describeDb = describe.skipIf(!adminUrl);
export const testLog = silentLogger;

export interface Fixture {
  t: TestDatabase;
  dir: string;
  file: string;
  rows: number;
  cleanup(): Promise<void>;
}

/** A throwaway database seeded from a synthetic candidate file of `rows` coins. */
export async function seededDatabase(rows: number, seed = 1): Promise<Fixture> {
  const t = await createTestDatabase(adminUrl!);
  const dir = await mkdtemp(join(tmpdir(), 'backfill-'));
  const file = join(dir, 'candidates.csv');
  await writeCandidateFile(file, rows, seed);
  await seedFromCandidateFile({ file, confirm: true, db: t.db });
  return {
    t,
    dir,
    file,
    rows,
    cleanup: async () => {
      await t.drop();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export interface TestClients {
  clients: SourceClients;
  provider: SynthProvider;
  limiter: RateLimiter | undefined;
  codex: CodexClient;
}

/** Source clients on the simulated provider. Helius, Jupiter and the metadata fetch are fakes. */
export function testClients(
  opts: {
    provider?: SynthProvider;
    limiter?: RateLimiter;
    http?: Omit<PostJsonOptions, 'fetch' | 'headers'>;
  } = {},
): TestClients {
  const provider = opts.provider ?? synthProvider();
  const codex = new CodexClient({
    apiKey: 'test-key-not-real',
    fetch: provider.fetch,
    budget: new UnitBudget({ ceilingUnits: 10_000_000 }),
    ...(opts.limiter ? { limiter: opts.limiter } : {}),
    http: opts.http ?? { maxRetries: 0, sleep: async () => {} },
  });
  const clients: SourceClients = {
    codex,
    helius: {
      getAssets: async (m) => m.map((x) => asset(x, { uri: `https://example.test/${x}.json` })),
    },
    jupiter: { getTokens: async (m) => m.map((x) => token(x)) },
    fetchMetadata: async (uri) => okResult({ description: `about ${uri.slice(-12)}` }),
  };
  return { clients, provider, limiter: opts.limiter, codex };
}
