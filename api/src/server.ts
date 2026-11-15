import { serve } from '@hono/node-server';
import { createDb } from '@memecoinipedia/db';
import { createApp } from './app.js';

/** Starts the API. Reads DATABASE_URL and PORT from the environment, nothing else. */
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  process.stderr.write('DATABASE_URL is not set\n');
  process.exit(1);
}
const port = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  process.stderr.write('PORT must be a whole number from 0 to 65535\n');
  process.exit(1);
}

const db = createDb(databaseUrl);
const server = serve({ fetch: createApp({ db }).fetch, port }, (info) => {
  process.stdout.write(`api listening on port ${info.port}\n`);
});

const shutdown = () => {
  server.close(() => {
    void db.destroy().finally(() => process.exit(0));
  });
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
