import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Integration files run ONLY via `npm run test:integration`
    // (vitest.integration.config.ts) — they share one disposable database and
    // must run serially. Keeping them out of `npm test` makes the unit/API
    // suite independent of database availability and prevents accidental
    // parallel runs when TEST_DATABASE_URL is set in the shell.
    exclude: [...configDefaults.exclude, 'test/integration/**'],
    environment: 'node',
  },
});
