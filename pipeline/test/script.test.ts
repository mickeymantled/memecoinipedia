import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../scripts/classify.ts', import.meta.url));
const TSX = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url));

/** Environment with no key and no database: the script must work without either in dry-run. */
const env = { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '' };

async function script(args: string[], extra: Record<string, string> = {}) {
  try {
    const r = await run(TSX, [SCRIPT, ...args], { env: { ...env, ...extra }, timeout: 60_000 });
    return { code: 0, out: r.stdout, err: r.stderr };
  } catch (e) {
    const x = e as { code: number; stdout: string; stderr: string };
    return { code: x.code, out: x.stdout, err: x.stderr };
  }
}

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('classify script', () => {
  it('is a dry run by default: prints the estimate, needs no key and no database', async () => {
    const r = await script(['--synthetic', '100']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('DRY RUN: nothing was sent');
    expect(r.out).toContain('first pass: claude-haiku-5-5, 100 coins');
    expect(r.out).toContain('second pass: claude-sonnet-5-5, 15 coins');
    expect(r.out).toContain('cache read');
  });

  it('--max-usd alone is still a dry run', async () => {
    const r = await script(['--synthetic', '10', '--max-usd', '5']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('still a dry run');
  });

  it('refuses --confirm without --max-usd, before touching anything', async () => {
    const r = await script(['--confirm', '--synthetic', '10'], {
      ANTHROPIC_API_KEY: 'sk-ant-test-not-real',
    });
    expect(r.code).toBe(2);
    expect(r.err).toContain('--confirm needs --max-usd');
    expect(r.out + r.err).not.toContain('sk-ant');
  });

  it('refuses --confirm on synthetic coins, and a zero ceiling', async () => {
    expect((await script(['--confirm', '--max-usd', '5', '--synthetic', '10'])).err).toContain(
      'dry runs only',
    );
    expect((await script(['--confirm', '--max-usd', '0'])).err).toContain('above zero');
  });

  it('a real run without a key stops with a message that does not print the key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'classify-script-'));
    dirs.push(dir);
    const mints = join(dir, 'm.jsonl');
    writeFileSync(mints, '{"mint":"Abc","name":"Doge","description":"a dog"}\n');
    const out = join(dir, 'out.jsonl');
    const r = await script([
      '--confirm',
      '--max-usd',
      '1',
      '--mints',
      mints,
      '--out',
      out,
      '--no-db',
    ]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('ANTHROPIC_API_KEY is not set');
    // Nothing was written: no results file and no state file.
    expect(readdirSync(dir)).toEqual(['m.jsonl']);
  });

  it('file mode dry run reads the file, opens no database and writes nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'classify-script-'));
    dirs.push(dir);
    const mints = join(dir, 'm.jsonl');
    writeFileSync(
      mints,
      '{"mint":"A1","name":"Doge"}\n{"mint":"B2","name":"Pepe","description":"frog"}\n',
    );
    const r = await script(['--mints', mints, '--out', join(dir, 'out.jsonl'), '--no-db']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('first pass: claude-haiku-5-5, 2 coins');
    expect(readdirSync(dir)).toEqual(['m.jsonl']);
  });

  it('--no-db rejects bare mints, and --mints needs --out', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'classify-script-'));
    dirs.push(dir);
    const mints = join(dir, 'm.txt');
    writeFileSync(mints, 'BareMint\n');
    expect(
      (await script(['--mints', mints, '--out', join(dir, 'o.jsonl'), '--no-db'])).err,
    ).toContain('bare mints');
    expect((await script(['--mints', mints])).err).toContain('--mints needs --out');
  });
});
