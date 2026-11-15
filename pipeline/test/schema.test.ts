import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NARRATIVES,
  outputJsonSchema,
  parseResult,
  MAX_REASON_CHARS,
} from '../src/classify/schema.js';
import { goodResult } from './helpers.js';

const slugs = DEFAULT_NARRATIVES.map((n) => n.slug);
const parse = (o: unknown, candidates: string[] = []) =>
  parseResult(JSON.stringify(o), slugs, candidates);

describe('result validation', () => {
  it('accepts a good result', () => {
    const r = parse(goodResult());
    expect(r.ok).toBe(true);
  });

  it('rejects unknown slugs, labels instead of slugs, and extra fields', () => {
    expect(parse(goodResult({ primary_narrative: 'culture/meme' })).ok).toBe(false);
    expect(parse(goodResult({ secondary_narratives: ['dogs'] })).ok).toBe(false);
    expect(parse({ ...goodResult(), extra: 1 }).ok).toBe(false);
  });

  it('enforces the secondary rules', () => {
    expect(parse(goodResult({ secondary_narratives: ['animal'] })).ok).toBe(false); // equals primary
    expect(parse(goodResult({ secondary_narratives: ['tech', 'tech'] })).ok).toBe(false); // repeat
    expect(
      parse(goodResult({ secondary_narratives: ['tech', 'ai', 'gaming', 'utility'] })).ok,
    ).toBe(false); // four
    expect(parse(goodResult({ secondary_narratives: ['tech', 'ai', 'gaming'] })).ok).toBe(true);
    expect(parse(goodResult({ secondary_narratives: [] })).ok).toBe(true);
  });

  it('enforces confidence 0 to 1 and the one-line 200 character reason', () => {
    expect(parse(goodResult({ confidence: 1.01 })).ok).toBe(false);
    expect(parse(goodResult({ confidence: -0.1 })).ok).toBe(false);
    expect(parse(goodResult({ confidence: 0 })).ok).toBe(true);
    expect(parse(goodResult({ reason: 'x'.repeat(MAX_REASON_CHARS) })).ok).toBe(true);
    expect(parse(goodResult({ reason: 'x'.repeat(MAX_REASON_CHARS + 1) })).ok).toBe(false);
    expect(parse(goodResult({ reason: 'two\nlines' })).ok).toBe(false);
    expect(parse(goodResult({ summary: '' })).ok).toBe(false);
  });

  it('rejects a parent_address outside the candidate list', () => {
    expect(parse(goodResult({ parent_address: 'Invented' }), []).ok).toBe(false);
    expect(parse(goodResult({ parent_address: 'Invented' }), ['Real1', 'Real2']).ok).toBe(false);
    expect(parse(goodResult({ parent_address: 'Real2' }), ['Real1', 'Real2']).ok).toBe(true);
    expect(parse(goodResult({ parent_address: null }), ['Real1']).ok).toBe(true);
  });

  it('reports non-JSON text as a failure instead of throwing', () => {
    const r = parseResult('not json', slugs, []);
    expect(r).toEqual({ ok: false, error: 'response is not valid JSON' });
  });
});

describe('JSON schema sent to the API', () => {
  const schema = outputJsonSchema(slugs) as {
    properties: Record<string, Record<string, unknown>>;
    required: string[];
    additionalProperties: boolean;
  };

  it('uses only constructs structured outputs support', () => {
    // Not supported per the docs: min/max length, numeric bounds, array bounds beyond minItems 0/1.
    const text = JSON.stringify(schema);
    for (const banned of [
      'maxLength',
      'minLength',
      'minimum',
      'maximum',
      'maxItems',
      'uniqueItems',
    ]) {
      expect(text).not.toContain(banned);
    }
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required.sort()).toEqual(Object.keys(schema.properties).sort());
  });

  it('constrains narratives to the slugs it was given', () => {
    expect(schema.properties['primary_narrative']!['enum']).toEqual(slugs);
    expect(outputJsonSchema(['a', 'b'])).not.toEqual(schema);
  });
});
