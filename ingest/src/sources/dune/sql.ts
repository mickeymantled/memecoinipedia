/**
 * `renderSql`: fills Dune `{{name}}` placeholders. Only three kinds of value are accepted, and
 * each is checked with a strict pattern, so no text from outside can reach the SQL:
 *
 * - a date, the string `YYYY-MM-DD`
 * - a timestamp, the string `YYYY-MM-DD HH:MM:SS`
 * - a finite number (rendered in plain decimal form)
 *
 * Values are rendered without quotes. The SQL template supplies its own quotes around dates,
 * as Dune's parameter box does (`TIMESTAMP '{{month_start}} 00:00:00'`). An unknown placeholder,
 * an unused parameter and any other kind of value are errors.
 */

export class SqlRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SqlRenderError';
  }
}

export type SqlParamValue = string | number;

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
const PLAIN_DECIMAL = /^-?\d+(\.\d+)?$/;

function validDate(y: number, m: number, d: number): boolean {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

function renderValue(name: string, value: unknown): string {
  if (typeof value === 'number') {
    const text = String(value);
    if (!Number.isFinite(value) || !PLAIN_DECIMAL.test(text)) {
      throw new SqlRenderError(`Parameter ${name}: number is not finite or not plain decimal`);
    }
    return text;
  }
  if (typeof value === 'string') {
    const d = DATE.exec(value);
    if (d && validDate(Number(d[1]), Number(d[2]), Number(d[3]))) return value;
    const t = TIMESTAMP.exec(value);
    if (
      t &&
      validDate(Number(t[1]), Number(t[2]), Number(t[3])) &&
      Number(t[4]) <= 23 &&
      Number(t[5]) <= 59 &&
      Number(t[6]) <= 59
    ) {
      return value;
    }
    throw new SqlRenderError(
      `Parameter ${name}: string is not a valid YYYY-MM-DD date or YYYY-MM-DD HH:MM:SS timestamp`,
    );
  }
  throw new SqlRenderError(`Parameter ${name}: only dates, timestamps and numbers are accepted`);
}

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;

/** The distinct placeholder names in a template, in order of first use. */
export function templatePlaceholders(template: string): string[] {
  const names: string[] = [];
  for (const m of template.matchAll(PLACEHOLDER)) {
    const name = m[1] ?? '';
    if (!NAME.test(name)) throw new SqlRenderError(`Malformed placeholder {{${name}}}`);
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

export function renderSql(template: string, params: Readonly<Record<string, unknown>>): string {
  const names = templatePlaceholders(template);
  const supplied = Object.keys(params);
  const missing = names.filter((n) => !Object.hasOwn(params, n));
  if (missing.length > 0) {
    throw new SqlRenderError(`Placeholder not supplied: ${missing.join(', ')}`);
  }
  const unused = supplied.filter((n) => !names.includes(n));
  if (unused.length > 0) {
    throw new SqlRenderError(`Parameter not used by the template: ${unused.join(', ')}`);
  }
  const rendered = new Map(names.map((n) => [n, renderValue(n, params[n])]));
  const out = template.replace(PLACEHOLDER, (_m, name: string) => rendered.get(name) ?? '');
  // Anything left over is a stray brace pair that the pattern did not recognise.
  if (/\{\{|\}\}/.test(out)) throw new SqlRenderError('Unbalanced {{ or }} in template');
  return out;
}
