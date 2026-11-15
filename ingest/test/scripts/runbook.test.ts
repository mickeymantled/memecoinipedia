import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The operator's runbook (docs/runbook.md) tells people to type commands. This test reads the
 * runbook and checks each such command against the scripts' own argument parsers, so a renamed
 * command or option breaks the build instead of the operator. Nothing is run.
 *
 * What it checks: for every line of a fenced block that starts with `pnpm -C ingest exec tsx`, the
 * script file exists; the command (first word after the script) is one the script accepts; every
 * `--option` is one the script's parser declares. For `pnpm --filter <pkg> <script>`, the package
 * exists and has that script. What it does not check: the values given to options, the
 * `psql`/`pg_dump`/`createdb`/`pg_restore` lines (they are not this repository's), and prose.
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const RUNBOOK = readFileSync(`${ROOT}docs/runbook.md`, 'utf8');

/** Every line inside a ``` fence. */
function fencedLines(md: string): string[] {
  const out: string[] = [];
  let inside = false;
  for (const line of md.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      inside = !inside;
      continue;
    }
    if (inside) out.push(line.trim());
  }
  return out;
}

/** The options a script declares: parseArgs keys, or `'--name'` literals in a hand-written parser. */
function declaredOptions(source: string): Set<string> {
  const names = new Set<string>(['help']);
  for (const m of source.matchAll(/^\s*'?([a-z][\w-]*)'?:\s*\{\s*type:/gm)) names.add(m[1]!);
  for (const m of source.matchAll(/'--([a-z][\w-]*)'/g)) names.add(m[1]!);
  return names;
}

/** The commands a script accepts, from its `command === 'x'` / `command !== 'x'` tests. */
function declaredCommands(source: string): Set<string> {
  const names = new Set<string>();
  for (const m of source.matchAll(/command\s*[!=]==\s*'([a-z][\w-]*)'/g)) names.add(m[1]!);
  return names;
}

interface ScriptCall {
  line: string;
  script: string;
  rest: string[];
}

const SCRIPT_LINE = /^pnpm -C ingest exec tsx (?:--env-file=\S+ )?scripts\/([\w-]+\.ts)(?:\s+(.*))?$/;

const calls: ScriptCall[] = fencedLines(RUNBOOK)
  .filter((l) => l.startsWith('pnpm -C ingest'))
  .map((line) => {
    const m = SCRIPT_LINE.exec(line);
    if (!m) throw new Error(`Runbook line is not in the documented form: ${line}`);
    return { line, script: m[1]!, rest: (m[2] ?? '').split(/\s+/).filter(Boolean) };
  });

describe('docs/runbook.md', () => {
  it('has script commands to check', () => {
    expect(calls.length).toBeGreaterThan(10);
  });

  it.each(calls.map((c) => [c.line, c] as const))('%s', (_line, call) => {
    const path = `${ROOT}ingest/scripts/${call.script}`;
    expect(existsSync(path), `${call.script} exists`).toBe(true);
    const source = readFileSync(path, 'utf8');
    const options = declaredOptions(source);
    const commands = declaredCommands(source);

    let args = call.rest;
    if (commands.size > 0) {
      const [command, ...after] = args;
      expect(command, 'a command is given').toBeDefined();
      expect([...commands], `${call.script} accepts "${command}"`).toContain(command);
      args = after;
    }
    for (const a of args) {
      if (!a.startsWith('--')) continue;
      const name = a.slice(2);
      expect([...options], `${call.script} declares --${name}`).toContain(name);
    }
  });

  it('names a package script that exists for each pnpm --filter line', () => {
    const lines = fencedLines(RUNBOOK).filter((l) => l.startsWith('pnpm --filter'));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const m = /^pnpm --filter (\S+) (\S+)$/.exec(line);
      expect(m, `documented form: ${line}`).not.toBeNull();
      const pkg = JSON.parse(readFileSync(`${ROOT}db/package.json`, 'utf8')) as {
        name: string;
        scripts: Record<string, string>;
      };
      expect(pkg.name).toBe(m![1]);
      expect(Object.keys(pkg.scripts)).toContain(m![2]);
    }
  });

  it('mentions only scripts that exist, and no local path', () => {
    for (const m of RUNBOOK.matchAll(/scripts\/([\w-]+\.ts)/g)) {
      expect(existsSync(`${ROOT}ingest/scripts/${m[1]}`), m[1]).toBe(true);
    }
    expect(RUNBOOK).not.toMatch(/\/Users\/|\/home\/|\/private\/|\/tmp\//);
  });

  it('documents the health command and every option it takes', () => {
    const source = readFileSync(`${ROOT}ingest/scripts/live.ts`, 'utf8');
    expect(declaredCommands(source)).toContain('health');
    for (const opt of ['--json', '--limit', '--monthly-codex-units']) {
      expect(RUNBOOK).toContain(opt);
    }
  });
});
