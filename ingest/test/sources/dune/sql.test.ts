import { describe, expect, it } from 'vitest';
import {
  renderSql,
  SqlRenderError,
  templatePlaceholders,
} from '../../../src/sources/dune/index.js';

const T =
  "select * from t where d >= DATE '{{start}}' and n < {{limit}} and ts < TIMESTAMP '{{until}}'";

describe('renderSql', () => {
  it('fills a date, a number and a timestamp, without adding quotes', () => {
    expect(renderSql(T, { start: '2024-02-29', limit: 90, until: '2026-12-31 23:59:59' })).toBe(
      "select * from t where d >= DATE '2024-02-29' and n < 90 and ts < TIMESTAMP '2026-12-31 23:59:59'",
    );
  });

  it('fills a placeholder used twice and keeps decimals and negatives', () => {
    expect(renderSql('{{a}} {{a}} {{b}}', { a: -1.5, b: 0 })).toBe('-1.5 -1.5 0');
  });

  it('lists placeholders', () => {
    expect(templatePlaceholders(T)).toEqual(['start', 'limit', 'until']);
    expect(templatePlaceholders('select 1')).toEqual([]);
  });

  it.each([
    ["'; drop table x; --"],
    ['2024-01-01; select 1'],
    ['2024-1-1'],
    ['2024-02-30'],
    ['2023-02-29'],
    ['2024-13-01'],
    ['2024-01-01T00:00:00'],
    ['2024-01-01 24:00:00'],
    ['2024-01-01 00:60:00'],
    ['2024-01-01 00:00:00.5'],
    ['2024-01-01 00:00:00 UTC'],
    ['2024-01-01\n'],
    [' 2024-01-01'],
    ['12'],
    [''],
    ['{{other}}'],
  ])('rejects the string %j', (value) => {
    expect(() => renderSql('x {{p}}', { p: value })).toThrow(SqlRenderError);
  });

  it.each([[Number.NaN], [Number.POSITIVE_INFINITY], [Number.NEGATIVE_INFINITY], [1e21], [1e-7]])(
    'rejects the number %s',
    (value) => {
      expect(() => renderSql('x {{p}}', { p: value })).toThrow(SqlRenderError);
    },
  );

  it.each([
    [null],
    [undefined],
    [true],
    [10n],
    [['2024-01-01']],
    [{ toString: () => '2024-01-01' }],
    [new Date('2024-01-01')],
    [Symbol('x')],
  ])('rejects the value kind %s', (value) => {
    expect(() => renderSql('x {{p}}', { p: value })).toThrow(SqlRenderError);
  });

  it('rejects a template with a placeholder that was not supplied', () => {
    expect(() => renderSql(T, { start: '2024-01-01', limit: 1 })).toThrow(/not supplied: until/);
  });

  it('rejects a parameter the template does not use', () => {
    expect(() => renderSql('select {{a}}', { a: 1, b: 2 })).toThrow(/not used.*b/);
  });

  it('rejects malformed placeholders and stray braces', () => {
    expect(() => renderSql('select {{ a }}', { a: 1 })).toThrow(SqlRenderError);
    expect(() => renderSql('select {{}}', {})).toThrow(SqlRenderError);
    expect(() => renderSql('select {{a', { a: 1 })).toThrow(SqlRenderError);
    expect(() => renderSql('select a}}', {})).toThrow(SqlRenderError);
  });

  it('does not read inherited properties as parameters', () => {
    expect(() => renderSql('select {{toString}}', {})).toThrow(/not supplied/);
  });

  it('leaves the template untouched when there is nothing to fill', () => {
    expect(renderSql('select 1', {})).toBe('select 1');
  });
});
