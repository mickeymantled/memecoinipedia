import { DEFAULT_NARRATIVES, MAX_SECONDARIES, type Narrative } from '../classify/schema.js';
import { parseCsv } from './csv.js';
import { toSlug, type Problem } from './narratives.js';

/** Columns of `/research/evals/labels.csv` (AGENTS.md). */
export const LABEL_COLUMNS = [
  'mint',
  'ticker',
  'primary_narrative',
  'secondary_narratives',
  'parent_mint',
  'confidence',
  'notes',
] as const;

export interface Label {
  /** Line in the file where the row starts. */
  line: number;
  mint: string;
  ticker: string;
  primary: string;
  secondaries: string[];
  parentMint: string | null;
  /** The labeller's confidence; null when left blank. */
  confidence: number | null;
  notes: string;
}

export interface LabelsLoad {
  labels: Label[];
  problems: Problem[];
}

/** `a;b`, `a|b`, or a JSON array `["a","b"]`. Returns null when a JSON array is malformed. */
function splitSecondaries(raw: string): string[] | null {
  const t = raw.trim();
  if (t === '') return [];
  if (t.startsWith('[')) {
    try {
      const v: unknown = JSON.parse(t);
      if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[];
    } catch {
      /* fall through */
    }
    return null;
  }
  return t
    .split(/[;|]/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/**
 * Reads labels.csv text. Narratives may be taxonomy labels or slugs; both become slugs. Every
 * problem is reported with its line number and the rows that have one are left out of `labels`.
 */
export function parseLabels(
  text: string,
  narratives: readonly Narrative[] = DEFAULT_NARRATIVES,
): LabelsLoad {
  const problems: Problem[] = [];
  const labels: Label[] = [];
  const { records, unterminatedAt } = parseCsv(text);
  if (unterminatedAt !== null) {
    problems.push({ line: unterminatedAt, message: 'quoted field is never closed' });
  }
  const [head, ...rows] = records;
  if (!head) {
    problems.push({ line: 1, message: 'no header row' });
    return { labels, problems };
  }
  const header = head.fields.map((h) => h.trim());
  const col = new Map<string, number>();
  header.forEach((h, i) => col.set(h, i));
  const missingCols = LABEL_COLUMNS.filter((c) => !col.has(c));
  if (missingCols.length > 0) {
    problems.push({
      line: head.line,
      message: `header lacks column(s): ${missingCols.join(', ')}`,
    });
    return { labels, problems };
  }

  const firstLine = new Map<string, number>();
  for (const row of rows) {
    const bad = (message: string) => problems.push({ line: row.line, message });
    if (row.fields.length !== header.length) {
      bad(`expected ${header.length} fields, found ${row.fields.length}`);
      continue;
    }
    const get = (name: (typeof LABEL_COLUMNS)[number]) => row.fields[col.get(name)!]!;
    let ok = true;

    const mint = get('mint').trim();
    if (mint === '') {
      bad('mint is empty');
      ok = false;
    } else if (firstLine.has(mint)) {
      bad(`duplicate mint ${mint} (first on line ${firstLine.get(mint)})`);
      ok = false;
    } else firstLine.set(mint, row.line);

    const primaryRaw = get('primary_narrative');
    const primary = toSlug(primaryRaw, narratives);
    if (primary === null) {
      bad(`unknown primary narrative "${primaryRaw.trim()}"`);
      ok = false;
    }

    const secRaw = splitSecondaries(get('secondary_narratives'));
    const secondaries: string[] = [];
    if (secRaw === null) {
      bad('secondary_narratives starts with [ but is not a JSON array of strings');
      ok = false;
    } else {
      if (secRaw.length > MAX_SECONDARIES) {
        bad(`${secRaw.length} secondary narratives (at most ${MAX_SECONDARIES})`);
        ok = false;
      }
      for (const s of secRaw) {
        const slug = toSlug(s, narratives);
        if (slug === null) {
          bad(`unknown secondary narrative "${s.trim()}"`);
          ok = false;
        } else if (slug === primary) {
          bad(`secondary narrative "${s.trim()}" equals the primary`);
          ok = false;
        } else if (secondaries.includes(slug)) {
          bad(`secondary narrative "${s.trim()}" is repeated`);
          ok = false;
        } else secondaries.push(slug);
      }
    }

    const confRaw = get('confidence').trim();
    let confidence: number | null = null;
    if (confRaw !== '') {
      confidence = Number(confRaw);
      if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
        bad(`confidence "${confRaw}" is not a number from 0 to 1`);
        ok = false;
      }
    }

    if (!ok || primary === null) continue;
    const parent = get('parent_mint').trim();
    labels.push({
      line: row.line,
      mint,
      ticker: get('ticker').trim(),
      primary,
      secondaries,
      parentMint: parent === '' ? null : parent,
      confidence,
      notes: get('notes').trim(),
    });
  }
  return { labels, problems };
}
