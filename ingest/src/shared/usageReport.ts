/**
 * What a long run does with its provider usage, shared by the backfill and the live process:
 * copy each client's own totals into the run's `UsageMeter`, and flush the meter to
 * `provider_usage` every few seconds, with a history sample (`provider_usage_samples`) now and then.
 */
import { recordUsageSample, type Database } from '@memecoinipedia/db';
import type { Kysely } from 'kysely';
import { CODEX_PROVIDER } from '../sources/codex/index.js';
import type { Logger } from '../worker/log.js';
import type { SourceClients } from '../worker/run.js';
import type { UsageMeter } from '../worker/usage.js';

/** Copies the clients' running totals into the meter. */
export function syncUsageFrom(clients: SourceClients, meter: UsageMeter): void {
  const usage = { ...clients.readUsage?.() };
  if (clients.codex && !usage[CODEX_PROVIDER]) {
    const c = clients.codex.spend();
    usage[CODEX_PROVIDER] = { requests: c.requests, units: c.units };
  }
  for (const [p, t] of Object.entries(usage)) meter.set(p, t.requests, t.units);
}

export interface UsageReportingOptions {
  db: Kysely<Database>;
  runId: number;
  meter: UsageMeter;
  clients: SourceClients;
  now: () => Date;
  log: Logger;
  /** Milliseconds between flushes of the meter. Default 5,000. */
  flushEveryMs?: number;
  /** Milliseconds between history samples. Default 30,000. */
  sampleEveryMs?: number;
}

/** Starts the periodic flush and sampling; returns the function that stops it. */
export function startUsageReporting(o: UsageReportingOptions): () => void {
  let lastSample = 0;
  return o.meter.startFlushing(
    o.db,
    o.runId,
    o.now,
    o.flushEveryMs ?? 5000,
    (err) => o.log.warn(`usage flush failed: ${(err as Error).message}`),
    () => {
      syncUsageFrom(o.clients, o.meter);
      // History for the status view's "last hour": one sample every 30 seconds.
      if (Date.now() - lastSample >= (o.sampleEveryMs ?? 30_000)) {
        lastSample = Date.now();
        const at = o.now();
        for (const [p, t] of Object.entries(o.meter.snapshot())) {
          recordUsageSample(o.db, o.runId, { provider: p, ...t }, at).catch((e: Error) =>
            o.log.warn(`usage sample failed: ${e.message}`),
          );
        }
      }
    },
  );
}
