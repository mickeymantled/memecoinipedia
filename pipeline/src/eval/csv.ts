/** One CSV record and the 1-based line it starts on. */
export interface CsvRecord {
  line: number;
  fields: string[];
}

/**
 * Minimal RFC 4180 reader: comma separated, double quotes with `""` as an escaped quote, quoted
 * fields may hold commas and line breaks, CRLF or LF. Blank lines are skipped. A leading byte
 * order mark is dropped. An unterminated quote is returned as `unterminatedAt` (its start line).
 */
export function parseCsv(text: string): { records: CsvRecord[]; unterminatedAt: number | null } {
  const src = text.startsWith('﻿') ? text.slice(1) : text;
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = '';
  let inQuotes = false;
  let quoted = false;
  let line = 1;
  let startLine = 1;
  let quoteLine = 1;

  const endField = () => {
    fields.push(field);
    field = '';
    quoted = false;
  };
  const endRecord = () => {
    endField();
    const blank = fields.length === 1 && fields[0]!.trim() === '';
    if (!blank) records.push({ line: startLine, fields });
    fields = [];
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else {
        if (c === '\n') line++;
        field += c;
      }
      continue;
    }
    if (c === '"' && field === '' && !quoted) {
      inQuotes = true;
      quoted = true;
      quoteLine = line;
    } else if (c === ',') endField();
    else if (c === '\r') {
      if (src[i + 1] === '\n') i++;
      line++;
      endRecord();
      startLine = line;
    } else if (c === '\n') {
      line++;
      endRecord();
      startLine = line;
    } else field += c;
  }
  if (inQuotes) return { records, unterminatedAt: quoteLine };
  if (field !== '' || fields.length > 0) endRecord();
  return { records, unterminatedAt: null };
}

function cell(v: string | number | null): string {
  const s = v === null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** One CSV line (no trailing newline). */
export function csvLine(values: ReadonlyArray<string | number | null>): string {
  return values.map(cell).join(',');
}
