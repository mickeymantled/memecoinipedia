import { createDb } from '../client.js';
import { seed } from '../seed.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const db = createDb(url);
try {
  const n = await seed(db);
  console.log(`seeded ${n} coins`);
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
