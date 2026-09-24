import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    // DB-backed tests share one Postgres instance; running them in parallel
    // would have them fighting over the same tenant fixtures.
    fileParallelism: false,
    testTimeout: 20_000,
    setupFiles: ['tests/setup.ts'],
  },
});
