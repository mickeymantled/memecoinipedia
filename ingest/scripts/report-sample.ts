/**
 * Report on a sample run, as Markdown on standard output. Reads the database
 * and the sample file; writes nothing and calls no provider.
 *
 *   node --env-file=.env --import tsx ingest/scripts/report-sample.ts --sample FILE
 *
 * Tables: stage status, failures by reason, path / units / pool-list lookup and
 * ATH share (overall, by cell, by half-year), ATH against the Dune hourly peak
 * (p10, median, p90, and every coin outside 0.5 to 3), launch info naming the
 * graduation pool by half-year, metric flags, open data issues, coin status,
 * coins a minute and units against the estimate.
 */
import { parseArgs } from 'node:util';
import { createDb } from '@memecoinipedia/db';
import { readSampleFile } from '../src/worker/seed.js';
import { buildReport, loadReportData } from './lib/sample-report.js';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { sample: { type: 'string' }, help: { type: 'boolean', default: false } },
    strict: true,
  });
  if (values.help || !values.sample) {
    process.stderr.write('Usage: report-sample.ts --sample FILE\n');
    process.exit(values.help ? 0 : 2);
  }
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is not set');
  const sample = await readSampleFile(values.sample);
  const db = createDb(url);
  try {
    const data = await loadReportData(db, sample, values.sample);
    process.stdout.write(buildReport(data));
  } finally {
    await db.destroy();
  }
}

main().catch((err: unknown) => {
  const url = process.env['DATABASE_URL'] ?? '';
  let text = err instanceof Error ? err.message : String(err);
  if (url.length >= 6) text = text.split(url).join('[redacted]');
  process.stderr.write(`report-sample failed: ${text}\n`);
  process.exit(1);
});
