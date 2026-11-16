import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/** Vitest config for the clock check: the package's usual run plus the shifted-clock setup file. */
export default defineConfig({
  test: {
    setupFiles: [fileURLToPath(new URL('./shifted-clock.ts', import.meta.url))],
  },
});
