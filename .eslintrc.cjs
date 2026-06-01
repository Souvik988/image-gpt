/**
 * Root ESLint configuration for the kiro-gpt-bridge monorepo.
 *
 * Per SOP S2.4: `@typescript-eslint/no-explicit-any` is enforced as an error.
 * Inline disables of this rule (or `@ts-ignore` / `@ts-expect-error`) require a
 * justification comment naming the requirement that forced the exception.
 */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    project: ['./tsconfig.base.json'],
    tsconfigRootDir: __dirname,
  },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  ignorePatterns: ['**/dist/**', '**/node_modules/**'],
  rules: {
    '@typescript-eslint/no-explicit-any': 'error',
  },
};
