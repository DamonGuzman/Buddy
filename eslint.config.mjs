// ESLint flat config — TypeScript strict, no `any` at module boundaries (ARCHITECTURE.md §9).
// Typed linting is intentionally off: the repo builds with TypeScript 7 (native compiler),
// which typescript-eslint's projectService does not support yet. Revisit when it does.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      'node_modules/',
      'out/',
      'dist/',
      'eval/results/',
      'eval/experiments/coord-study/results/',
      'sessions/',
      '**/*.d.ts',
    ],
  },

  // TypeScript sources (main, preload, renderers, tests).
  {
    files: ['src/**/*.{ts,tsx}', 'tests/**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-non-null-assertion': 'warn',
      'no-console': 'off',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },

  // React renderers: hooks rules.
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },

  // Audio worklets run inside AudioWorkletGlobalScope.
  {
    files: ['src/renderer/**/worklets/*.js', 'tools/phone-audio-bridge/capture-worklet.js'],
    languageOptions: {
      globals: {
        AudioWorkletProcessor: 'readonly',
        registerProcessor: 'readonly',
        sampleRate: 'readonly',
      },
    },
  },

  // Plain-JS tooling and eval harnesses (Node).
  {
    files: ['tools/**/*.{js,mjs}', 'eval/**/*.mjs', 'build/**/*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },

  // Browser-side phone bridge page script.
  {
    files: ['tools/phone-audio-bridge/phone.js'],
    languageOptions: { globals: { ...globals.browser } },
  },

  // Browser-side developer tools.
  {
    files: ['tools/helper-prompt-editor/main.js'],
    languageOptions: { globals: { ...globals.browser } },
  },

  // Tests may reach into internals.
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  prettier,
);
