import { defineConfig } from 'vitest/config';

/**
 * Slow-tag vitest configuration.
 *
 * Picks up only `*.slow.test.ts` files (e.g. the 25 MB pretty-print PBT and
 * atomic-write PBTs) and gives them a 5-minute timeout. Run via:
 *   npm run test:slow
 */
export default defineConfig({
  test: {
    include: ['**/*.slow.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    globals: false,
    testTimeout: 300_000,
  },
});
