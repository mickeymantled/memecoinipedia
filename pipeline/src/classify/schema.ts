import { z } from 'zod';

/**
 * The classifier's output: one JSON object per coin.
 *
 * Two layers, because the API's structured outputs accept only a subset of JSON
 * Schema. Source (Structured outputs, "JSON Schema limitations",
 * https://platform.claude.com/docs/en/build-with-claude/structured-outputs):
 * `enum`, `anyOf`, `required` and `additionalProperties: false` are supported;
 * `maxLength`, numeric `minimum`/`maximum` and array constraints beyond
 * `minItems` 0 or 1 are not (the API answers 400). So `outputJsonSchema` sends
 * the shape, and the zod schema returned by `resultSchema` enforces the limits
 * (reason at most 200 characters, at most three secondaries, confidence 0 to 1,
 * no repeats, secondary not equal to primary) on every response before anything
 * is stored. The limits are also written into the field descriptions, which the
 * docs say is how to pass constraints the schema cannot carry.
 */

export const MAX_REASON_CHARS = 200;
export const MAX_SECONDARIES = 3;

/** A narrative as stored in the `narratives` table. */
export interface Narrative {
  slug: string;
  label: string;
}

/** The eleven narratives of migration 0001, for runs that do not read the database. */
export const DEFAULT_NARRATIVES: readonly Narrative[] = [
  { slug: 'ai', label: 'AI' },
  { slug: 'tech', label: 'tech' },
  { slug: 'animal', label: 'animal' },
  { slug: 'celebrity', label: 'celebrity' },
  { slug: 'political', label: 'political' },
  { slug: 'news_event', label: 'news event' },
  { slug: 'culture_meme', label: 'culture/meme' },
  { slug: 'gaming', label: 'gaming' },
  { slug: 'derivative', label: 'derivative' },
  { slug: 'utility', label: 'utility' },
  { slug: 'other', label: 'other' },
];

/** JSON Schema sent as `output_config.format.schema`. Deterministic for a given slug list. */
export function outputJsonSchema(slugs: readonly string[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      primary_narrative: { type: 'string', enum: [...slugs], description: 'One narrative slug.' },
      secondary_narratives: {
        type: 'array',
        items: { type: 'string', enum: [...slugs] },
        description: `At most ${MAX_SECONDARIES} slugs, none equal to the primary, no repeats.`,
      },
      confidence: {
        type: 'number',
        description: 'Confidence in the primary narrative, from 0 to 1.',
      },
      reason: {
        type: 'string',
        description: `One line, at most ${MAX_REASON_CHARS} characters.`,
      },
      parent_address: {
        anyOf: [{ type: 'string' }, { type: 'null' }],
        description: 'An address copied from parent_candidates, or null.',
      },
      sensitive: { type: 'boolean' },
      summary: {
        type: 'string',
        description: 'Two or three sentences using only facts present in the record.',
      },
    },
    required: [
      'primary_narrative',
      'secondary_narratives',
      'confidence',
      'reason',
      'parent_address',
      'sensitive',
      'summary',
    ],
    additionalProperties: false,
  };
}

export interface ClassifyResult {
  primary_narrative: string;
  secondary_narratives: string[];
  confidence: number;
  reason: string;
  parent_address: string | null;
  sensitive: boolean;
  summary: string;
}

/**
 * The zod schema for one result. `slugs` is the allowed narrative set and
 * `candidates` the parent addresses given in this coin's input.
 */
export function resultSchema(
  slugs: readonly string[],
  candidates: readonly string[],
): z.ZodType<ClassifyResult> {
  const slug = z
    .string()
    .refine((s) => slugs.includes(s), { message: 'not a known narrative slug' });
  return z
    .object({
      primary_narrative: slug,
      secondary_narratives: z.array(slug).max(MAX_SECONDARIES),
      confidence: z.number().min(0).max(1),
      reason: z
        .string()
        .min(1)
        .max(MAX_REASON_CHARS)
        .refine((s) => !/[\r\n]/.test(s), { message: 'reason must be one line' }),
      parent_address: z.string().min(1).nullable(),
      sensitive: z.boolean(),
      summary: z.string().min(1),
    })
    .strict()
    .superRefine((r, ctx) => {
      if (r.secondary_narratives.includes(r.primary_narrative)) {
        ctx.addIssue({
          code: 'custom',
          path: ['secondary_narratives'],
          message: 'secondary equals primary',
        });
      }
      if (new Set(r.secondary_narratives).size !== r.secondary_narratives.length) {
        ctx.addIssue({
          code: 'custom',
          path: ['secondary_narratives'],
          message: 'repeated secondary',
        });
      }
      if (r.parent_address !== null && !candidates.includes(r.parent_address)) {
        ctx.addIssue({
          code: 'custom',
          path: ['parent_address'],
          message: 'parent_address is not one of the candidate addresses',
        });
      }
    });
}

export type ParseOutcome = { ok: true; result: ClassifyResult } | { ok: false; error: string };

/** Parses the model's text as JSON and validates it. Never throws. */
export function parseResult(
  text: string,
  slugs: readonly string[],
  candidates: readonly string[],
): ParseOutcome {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'response is not valid JSON' };
  }
  const parsed = resultSchema(slugs, candidates).safeParse(raw);
  if (parsed.success) return { ok: true, result: parsed.data };
  const msg = parsed.error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
  return { ok: false, error: `schema validation failed: ${msg}` };
}
