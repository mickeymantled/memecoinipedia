import { z } from 'zod';
import type { Problem } from './narratives.js';

/**
 * One line of the classifier's file-mode output (`classify.ts --out results.jsonl`, written by
 * `FileStore`): `{ mint, model, prompt_version, classified_at, ...result }` for a coin with a
 * result, or `{ mint, error }` for a coin whose result failed validation. The result fields are
 * the ones in `ClassifyResult`. A coin still pending has no line at all.
 */
const okSchema = z.looseObject({
  mint: z.string().min(1),
  primary_narrative: z.string().min(1),
  secondary_narratives: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  parent_address: z.string().min(1).nullable(),
});
const failedSchema = z.looseObject({ mint: z.string().min(1), error: z.string().nullable() });

export interface OkRecord {
  kind: 'ok';
  mint: string;
  primary: string;
  secondaries: string[];
  confidence: number;
  reason: string;
  parentAddress: string | null;
}
export interface FailedRecord {
  kind: 'failed';
  mint: string;
  error: string;
}
export type ResultRecord = OkRecord | FailedRecord;

export interface ResultsLoad {
  byMint: Map<string, ResultRecord>;
  problems: Problem[];
}

/** Reads a results file. Blank lines are skipped. A bad or repeated line is a problem. */
export function parseResults(text: string): ResultsLoad {
  const byMint = new Map<string, ResultRecord>();
  const problems: Problem[] = [];
  const lineOf = new Map<string, number>();
  text.split('\n').forEach((raw, i) => {
    const line = i + 1;
    if (raw.trim() === '') return;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      problems.push({ line, message: 'not valid JSON' });
      return;
    }
    let rec: ResultRecord;
    const ok = okSchema.safeParse(json);
    if (ok.success) {
      const d = ok.data;
      rec = {
        kind: 'ok',
        mint: d.mint,
        primary: d.primary_narrative,
        secondaries: d.secondary_narratives,
        confidence: d.confidence,
        reason: d.reason,
        parentAddress: d.parent_address,
      };
    } else {
      const failed = failedSchema.safeParse(json);
      if (!failed.success || !('error' in (json as object))) {
        const msg = ok.error.issues
          .slice(0, 3)
          .map((x) => `${x.path.join('.') || '(line)'}: ${x.message}`)
          .join('; ');
        problems.push({ line, message: `neither a result nor a failure record: ${msg}` });
        return;
      }
      rec = {
        kind: 'failed',
        mint: failed.data.mint,
        error: failed.data.error ?? 'failed (no message)',
      };
    }
    if (byMint.has(rec.mint)) {
      problems.push({
        line,
        message: `mint ${rec.mint} appears again (first on line ${lineOf.get(rec.mint)})`,
      });
      return;
    }
    byMint.set(rec.mint, rec);
    lineOf.set(rec.mint, line);
  });
  return { byMint, problems };
}
