/**
 * Ask candidate IPFS gateways for a list of CIDs and print how each one answered.
 *
 *   tsx scripts/gateway-probe.ts --file CIDS.txt [--gateway HOST_OR_URL]... [--confirm]
 *
 * CIDS.txt holds one CID (or `cid/path`) per line; blank lines and lines starting with `#` are
 * skipped. Without `--confirm` it prints what it would ask and exits: no request is made. With it,
 * it sends one GET per gateway and CID (10 s timeout, at most one request a second per gateway,
 * first 64 KB of the body read and thrown away, redirects not followed, a generic user agent) and
 * prints, per gateway: valid JSON, not found, rate limited, timed out, other errors, and the
 * median latency of the valid-JSON answers. It writes nothing to any database.
 *
 * Candidates: ipfs.filebase.io, gateway.pinata.cloud, ipfs.io, dweb.link, w3s.link,
 * nftstorage.link, 4everland.io, gateway.lighthouse.storage, plus each `--gateway` given.
 */
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import {
  CANDIDATE_GATEWAYS,
  describePlan,
  formatTallies,
  parseCidList,
  runProbe,
} from './lib/gateway-probe.js';

function usage(message?: string): never {
  if (message) process.stderr.write(`${message}\n\n`);
  process.stderr.write(
    'Usage: gateway-probe.ts --file CIDS.txt [--gateway HOST_OR_URL]... [--confirm]\n',
  );
  process.exit(message ? 2 : 0);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      file: { type: 'string' },
      gateway: { type: 'string', multiple: true },
      confirm: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (values.help) usage();
  if (!values.file) usage('--file CIDS.txt is required');
  const cids = parseCidList(await readFile(values.file, 'utf8'));
  if (cids.length === 0) usage('The file holds no CIDs');
  const gateways = [...new Set([...CANDIDATE_GATEWAYS, ...(values.gateway ?? [])])];

  if (!values.confirm) {
    process.stdout.write(`${describePlan(gateways, cids)}\n`);
    return;
  }
  const tallies = await runProbe({
    gateways,
    cids,
    onProgress: (done, total) => {
      if (done % 25 === 0 || done === total) process.stderr.write(`${done}/${total} requests\n`);
    },
  });
  process.stdout.write(`${formatTallies(tallies, cids.length)}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(
    `gateway-probe failed: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
