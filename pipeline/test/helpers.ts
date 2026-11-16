import { randomBytes } from 'node:crypto';
import { describe } from 'vitest';
import pg from 'pg';
import type { Kysely } from 'kysely';
import { createDb, migrate, type Database } from '@memecoinipedia/db';
import type {
  BatchInfo,
  BatchRequest,
  BatchResultEntry,
  ClassifierClient,
  Usage,
} from '../src/classify/client.js';
import { defaultConfig, type ClassifyConfig } from '../src/classify/config.js';
import { parseTemplate, PromptBuilder } from '../src/classify/prompt.js';
import { DEFAULT_NARRATIVES, type ClassifyResult } from '../src/classify/schema.js';
import type { CoinInput } from '../src/classify/input.js';

/**
 * Database tests use only throwaway databases named mcp_test_<hex>, created and dropped through
 * TEST_DATABASE_ADMIN_URL, as db/test does. Nothing here connects to any other database.
 */
export const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (!adminUrl) {
  process.stderr.write(
    '\n*** TEST_DATABASE_ADMIN_URL is not set: pipeline database tests are SKIPPED. ***\n\n',
  );
}
export const describeDb = describe.skipIf(!adminUrl);

const NAME = /^mcp_test_[a-f0-9]+$/;

export interface TestDb {
  name: string;
  url: string;
  db: Kysely<Database>;
  drop: () => Promise<void>;
}

async function withAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

export async function createTestDb(): Promise<TestDb> {
  const name = `mcp_test_${randomBytes(6).toString('hex')}`;
  if (!NAME.test(name)) throw new Error('bad test database name');
  await withAdmin((c) => c.query(`CREATE DATABASE "${name}"`));
  const u = new URL(adminUrl!);
  u.pathname = `/${name}`;
  const url = u.toString();
  try {
    await migrate(url);
  } catch (err) {
    await withAdmin((c) => c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
    throw err;
  }
  const db = createDb(url);
  return {
    name,
    url,
    db,
    drop: async () => {
      await db.destroy();
      if (!NAME.test(name)) throw new Error('refusing to drop');
      await withAdmin((c) => c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
    },
  };
}

export const TEMPLATE = parseTemplate(
  'prompt-version: test-v0\n---\nSlugs:\n{{slug_mapping}}\n\nTaxonomy:\n{{taxonomy}}\n\nBe careful.',
);

export function testConfig(over: Partial<ClassifyConfig> = {}): ClassifyConfig {
  return { ...defaultConfig(), pollIntervalMs: 0, ...over };
}

export function testBuilder(config = testConfig(), taxonomy = 'Dogs are animal.'): PromptBuilder {
  return new PromptBuilder(config, TEMPLATE, taxonomy, DEFAULT_NARRATIVES);
}

export function coin(over: Partial<CoinInput> = {}): CoinInput {
  return {
    chain: 'solana',
    address: 'Mint1',
    name: 'Doge',
    ticker: 'DOGE',
    description: 'a dog',
    socials: { twitter: 'https://x.com/doge' },
    launched_at: '2025-03-01T00:00:00.000Z',
    graduated_at: null,
    ath_market_cap_usd: 250000,
    ath_at: '2025-03-01T01:00:00.000Z',
    seconds_to_ath: 3600,
    status: 'alive',
    ...over,
  };
}

export const USAGE: Usage = {
  input_tokens: 100,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 4000,
  output_tokens: 150,
};

export function goodResult(over: Partial<ClassifyResult> = {}): ClassifyResult {
  return {
    primary_narrative: 'animal',
    secondary_narratives: ['culture_meme'],
    confidence: 0.9,
    reason: 'A dog coin.',
    parent_address: null,
    sensitive: false,
    summary: 'Doge is a coin named after a dog. It launched in March 2025.',
    ...over,
  };
}

/** What the fake returns per request: a result object, raw text, or a non-success outcome. */
export type Reply =
  | { result: ClassifyResult; usage?: Usage; stopReason?: string }
  | { text: string; usage?: Usage; stopReason?: string }
  | { outcome: 'errored'; errorType?: string }
  | { outcome: 'expired' | 'canceled' };

/**
 * An in-memory ClassifierClient. `reply(request, model)` decides each answer. A batch stays
 * `in_progress` for `pollsBeforeEnd` getBatch calls. Records everything it was asked.
 */
export class FakeClient implements ClassifierClient {
  created: Array<{ id: string; requests: BatchRequest[] }> = [];
  getBatchCalls = 0;
  countTokensCalls = 0;
  /** Throws on the nth createBatch call (1-based) when set. */
  failCreateOn: number | null = null;
  constructor(
    private readonly reply: (r: BatchRequest) => Reply = () => ({ result: goodResult() }),
    private readonly pollsBeforeEnd = 1,
  ) {}
  private polls = new Map<string, number>();

  createBatch(requests: BatchRequest[]): Promise<BatchInfo> {
    if (this.failCreateOn === this.created.length + 1) {
      return Promise.reject(new Error('create failed'));
    }
    const id = `batch_${this.created.length + 1}`;
    this.created.push({ id, requests });
    return Promise.resolve({
      id,
      status: 'in_progress',
      counts: { processing: requests.length, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
    });
  }

  getBatch(id: string): Promise<BatchInfo> {
    this.getBatchCalls += 1;
    const n = (this.polls.get(id) ?? 0) + 1;
    this.polls.set(id, n);
    const done = n > this.pollsBeforeEnd;
    return Promise.resolve({
      id,
      status: done ? 'ended' : 'in_progress',
      counts: { processing: done ? 0 : 1, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
    });
  }

  async *readResults(id: string): AsyncIterable<BatchResultEntry> {
    const b = this.created.find((c) => c.id === id);
    if (!b) throw new Error(`unknown batch ${id}`);
    // Reverse order: results arrive in any order.
    for (const req of [...b.requests].reverse()) {
      const r = this.reply(req);
      if ('outcome' in r) {
        if (r.outcome === 'errored') {
          yield {
            customId: req.custom_id,
            outcome: 'errored',
            errorType: r.errorType ?? 'invalid_request',
            errorMessage: 'bad',
          };
        } else {
          yield { customId: req.custom_id, outcome: r.outcome };
        }
        continue;
      }
      yield {
        customId: req.custom_id,
        outcome: 'succeeded',
        text: 'result' in r ? JSON.stringify(r.result) : r.text,
        stopReason: r.stopReason ?? 'end_turn',
        usage: r.usage ?? USAGE,
      };
    }
  }

  countTokens(): Promise<number> {
    this.countTokensCalls += 1;
    return Promise.resolve(4321);
  }
}
