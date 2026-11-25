import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    ignores: [
      '**/dist/**',
      '**/test-dist/**',
      '**/node_modules/**',
      '**/.turbo/**',
      '**/src/generated/**',
      'assets/**',
      'docs/**',
    ],
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.tsx'],
    extends: [reactHooks.configs.flat.recommended],
  },
  {
    // node:test registers suites and tests as top-level calls; their returned promises are not awaited. The same holds
    // for a suite that a package exports for its stores to run (`src/testing`).
    files: ['**/*.test.ts', '**/src/testing/**/*.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-extraneous-class': 'off',
    },
  },
  {
    files: ['**/*.{js,mjs}'],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: {
        Buffer: 'readonly',
        URL: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        process: 'readonly',
      },
    },
  },
);
