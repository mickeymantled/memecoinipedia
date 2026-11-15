import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Runner } from '../src/classify/batch.js';
import {
  FileStore,
  fileRecordToCoin,
  parseMintsFile,
  type FileCoin,
} from '../src/classify/file-store.js';
import { estimatedCalibration } from '../src/classify/plan.js';
import { FakeClient, coin, testBuilder, testConfig } from './helpers.js';
import { defineRunnerSuite, type CoinState, type Harness } from './runner-suite.js';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

class FileHarness implements Harness {
  private out = '';
  private coins: FileCoin[] = [];
  async setup(n: number, candidates: Record<number, string[]> = {}): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'classify-test-'));
    dirs.push(dir);
    this.out = join(dir, 'results.jsonl');
    this.coins = Array.from({ length: n }, (_, i) => {
      const cands = candidates[i] ?? [];
      return {
        mint: `Mint${i + 1}`,
        coin: coin({
          address: `Mint${i + 1}`,
          name: `Coin ${i + 1}`,
          ...(cands.length > 0 ? { parent_candidates: cands.map((address) => ({ address })) } : {}),
        }),
        candidates: cands,
      };
    });
    return Promise.resolve();
  }
  keys(): string[] {
    return this.coins.map((c) => c.mint);
  }
  store(): FileStore {
    return FileStore.open(this.out, this.coins);
  }
  async state(key: string): Promise<CoinState> {
    const s = this.store();
    const raw = (
      s as unknown as {
        state: {
          coins: Record<
            string,
            {
              status: string;
              error: string | null;
              result: {
                model: string;
                promptVersion: string;
                data: Record<string, unknown>;
              } | null;
            }
          >;
        };
      }
    ).state.coins[key]!;
    return Promise.resolve({
      primary: (raw.result?.data['primary_narrative'] as string | undefined) ?? null,
      confidence: (raw.result?.data['confidence'] as number | undefined) ?? null,
      model: raw.result?.model ?? null,
      version: raw.result?.promptVersion ?? null,
      stage: raw.status,
      error: raw.error,
    });
  }
}

defineRunnerSuite('the file store (no database)', new FileHarness());

describe('file mode', () => {
  it('writes results to the output file, final result per coin, and failures as error lines', async () => {
    const h = new FileHarness();
    await h.setup(3);
    const bad = h.keys()[2]!;
    const client = new FakeClient((r) =>
      r.custom_id === bad
        ? { text: 'nope' }
        : {
            result: {
              primary_narrative: 'tech',
              secondary_narratives: [],
              confidence: 0.8,
              reason: 'r',
              parent_address: null,
              sensitive: false,
              summary: 's',
            },
          },
    );
    const config = testConfig();
    const b = testBuilder(config);
    const store = h.store();
    await new Runner({
      client,
      store,
      builder: b,
      config,
      calibration: estimatedCalibration(b, config),
    }).run({
      maxUsd: 10,
      passes: 'both',
      force: false,
    });
    const out = (h as unknown as { out: string }).out;
    const lines = readFileSync(out, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({
      mint: 'Mint1',
      primary_narrative: 'tech',
      confidence: 0.8,
      model: 'claude-haiku-5-5',
    });
    expect(lines[0]!['prompt_version']).toMatch(/^test-v0\+/);
    expect(lines[2]).toMatchObject({
      mint: 'Mint3',
      error: expect.stringContaining('JSON') as string,
    });
  });

  it('rejects a mint that cannot be a custom_id', () => {
    expect(() =>
      FileStore.open('/tmp/x.jsonl', [{ mint: 'bad mint!', coin: coin(), candidates: [] }]),
    ).toThrow(/custom_id/);
  });

  it('parses mints files: bare mints, JSON records, comments and blank lines', () => {
    const entries = parseMintsFile(
      '# eval list\n\nAbc123\n{"mint":"Def456","name":"Doge","description":"a dog"}\n',
    );
    expect(entries).toEqual(['Abc123', { mint: 'Def456', name: 'Doge', description: 'a dog' }]);
    const c = fileRecordToCoin(entries[1] as Record<string, unknown>);
    expect(c).toMatchObject({
      mint: 'Def456',
      coin: { name: 'Doge', chain: 'solana', status: 'unknown' },
    });
    expect(() => fileRecordToCoin({ name: 'no mint' })).toThrow();
  });
});
