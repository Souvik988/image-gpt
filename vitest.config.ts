import { defineConfig } from 'vitest/config';

/**
 * Default vitest configuration for the kiro-gpt-bridge monorepo.
 *
 * - Picks up every `*.test.ts` file across all workspaces.
 * - Excludes `*.slow.test.ts` files; those are gated behind `vitest.config.slow.ts`
 *   and run via `npm run test:slow`.
 * - `globals: false` — tests must explicitly import `it`, `expect`, etc. from `vitest`.
 */
export default defineConfig({
  test: {
    include: ['**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.slow.test.ts'],
    globals: false,
  },
});
