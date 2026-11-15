import { describe } from 'vitest';
import { getTestAdminUrl } from '../src/testing.js';

export const adminUrl = getTestAdminUrl();

if (!adminUrl) {
  process.stderr.write(
    '\n*** TEST_DATABASE_ADMIN_URL is not set: database tests are SKIPPED. ' +
      'Set it to a Postgres admin URL to run them. ***\n\n',
  );
}

/** `describe` that skips when no test database server is configured. */
export const describeDb = describe.skipIf(!adminUrl);
