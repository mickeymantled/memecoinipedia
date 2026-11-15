import type { Kysely } from 'kysely';
import type { Database } from '@memecoinipedia/db';
import { createParentCandidateProvider, type ParentProviderOptions } from './parent-index.js';

/**
 * Evaluation of the parent-candidate provider against hand-checked pairs. Read-only: it runs in
 * one read-only transaction, so a write would be refused by the database itself.
 */

export interface ParentPair {
  child: string;
  parent: string;
}

export interface PairResult extends ParentPair {
  /** 1-based rank of the true parent among the candidates, or null when it is not among them. */
  rank: number | null;
  /** 'child-not-found' when the child has no coin row on the chain: not counted in recall. */
  status: 'ok' | 'child-not-found';
}

export interface EvalSummary {
  results: PairResult[];
  /** Pairs whose child was found. The recall denominator. */
  evaluated: number;
  recall: { 1: number; 3: number; 10: number };
}

/** Parses `child_address,parent_address` lines. A header, blank lines and `#` comments are skipped. */
export function parsePairsCsv(text: string): ParentPair[] {
  const pairs: ParentPair[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const [child, parent, ...rest] = line.split(',').map((x) => x.trim().replace(/^"|"$/g, ''));
    if (!child || !parent || rest.length > 0) throw new Error(`Bad pairs line: expected 2 columns`);
    if (child === 'child_address') continue;
    pairs.push({ child, parent });
  }
  return pairs;
}

export async function evaluateParentPairs(
  db: Kysely<Database>,
  pairs: readonly ParentPair[],
  options: ParentProviderOptions & { chain?: string } = {},
): Promise<EvalSummary> {
  const chain = options.chain ?? 'solana';
  return db
    .transaction()
    .setAccessMode('read only')
    .execute(async (trx) => {
      const provider = createParentCandidateProvider(trx, options);
      const idByAddress = new Map<string, number>();
      const children = [...new Set(pairs.map((p) => p.child))];
      for (let i = 0; i < children.length; i += 1000) {
        const rows = await trx
          .selectFrom('coins')
          .select(['id', 'address'])
          .where('chain', '=', chain)
          .where('address', 'in', children.slice(i, i + 1000))
          .execute();
        for (const r of rows) idByAddress.set(r.address, r.id);
      }
      const found = [...idByAddress].map(([address, id]) => ({ id, chain, address }));
      const extras = await provider(found);
      const results: PairResult[] = pairs.map((p) => {
        const id = idByAddress.get(p.child);
        if (id === undefined) return { ...p, rank: null, status: 'child-not-found' };
        const at = (extras.get(id)?.parent_candidates ?? []).findIndex(
          (c) => c.address === p.parent,
        );
        return { ...p, rank: at < 0 ? null : at + 1, status: 'ok' };
      });
      const ok = results.filter((r) => r.status === 'ok');
      const at = (k: number): number =>
        ok.length === 0 ? 0 : ok.filter((r) => r.rank !== null && r.rank <= k).length / ok.length;
      return { results, evaluated: ok.length, recall: { 1: at(1), 3: at(3), 10: at(10) } };
    });
}

export function formatEval(s: EvalSummary): string {
  const lines = s.results.map((r) =>
    r.status === 'child-not-found'
      ? `${r.child} -> ${r.parent}: child not found`
      : `${r.child} -> ${r.parent}: ${r.rank === null ? 'missing' : `rank ${r.rank}`}`,
  );
  const skipped = s.results.length - s.evaluated;
  const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
  lines.push(
    '',
    `pairs evaluated: ${s.evaluated}${skipped > 0 ? ` (${skipped} skipped: child not found)` : ''}`,
    `recall@1: ${pct(s.recall[1])}  recall@3: ${pct(s.recall[3])}  recall@10: ${pct(s.recall[10])}`,
  );
  return lines.join('\n');
}
