import { migrate } from '../migrate.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

try {
  const result = await migrate(url, { log: (m) => console.log(m) });
  console.log(
    result.applied.length === 0
      ? 'up to date'
      : `applied ${result.applied.length} migration(s): ${result.applied.join(', ')}`,
  );
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
