// Flat ESLint config: catches undefined variables (like the missing
// redis client in round 2) before deploy.
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', 'apps-script/**'] },
  {
    files: ['api/**', 'lib/**', 'test/**'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-undef': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['warn', { args: 'none' }],
    },
  },
  {
    // Both are classic browser scripts loaded before app.js.
    files: ['js/utils.js', 'js/share.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'script',
      globals: { ...globals.browser, RCUtils: 'readonly' },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-undef': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['warn', { args: 'none' }],
    },
  },
  {
    files: ['js/app.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'script',
      // RCUtils comes from js/utils.js, which index.html loads first.
      globals: { ...globals.browser, RCUtils: 'readonly' },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-undef': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
      // app.js is a classic script driven by inline onclick attributes, so
      // "unused" functions are the norm here; no-undef is the check that matters.
      'no-unused-vars': 'off',
    },
  },
  {
    files: ['sw.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'script',
      globals: { ...globals.serviceworker },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-undef': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['warn', { args: 'none' }],
    },
  },
  {
    files: ['e2e/**/*.js', 'playwright.config.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-undef': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['warn', { args: 'none' }],
    },
  },
];
