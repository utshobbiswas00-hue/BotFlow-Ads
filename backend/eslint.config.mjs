// @ts-check
import tseslint from 'typescript-eslint';

// ESLint flat config for @botflow/backend.
//
// Why this exists: the `lint` script (`eslint src`) was permanently broken —
// `eslint` was not declared in any package.json and there was no config file,
// so `npm run lint` exited 127 with `eslint: not found`. This is a pragmatic
// starter ruleset: the type-aware `recommended` set, with the noisiest rules
// relaxed to `warn` so the command is useful on day one instead of drowning in
// pre-existing findings.
//
// Scope is all TypeScript under `src/` (the lint script passes `src`). Tests,
// the Prisma schema/seed and build output are intentionally out of scope here.
export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'tests/**', 'prisma/**', 'coverage/**'],
  },
  ...tseslint.configs.recommended,
  {
    files: ['src/**'],
    languageOptions: {
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    rules: {
      // Pragmatic starter tuning: keep signal, avoid a wall of red on legacy code.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Express module augmentation (`declare global { namespace Express { … } }`)
      // is the documented way to extend Request, so declarations are allowed.
      '@typescript-eslint/no-namespace': [
        'error',
        { allowDeclarations: true, allowDefinitionFiles: true },
      ],
      // BullMQ job-data types for jobs that carry no payload are deliberately
      // empty (`export interface PayoutJobData {}`). Naming them *JobData is the
      // signal, so only those are exempt rather than turning the rule off.
      '@typescript-eslint/no-empty-object-type': ['error', { allowWithName: 'JobData$' }],
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/ban-ts-comment': 'warn',
      'no-console': 'warn',
      'no-debugger': 'error',
    },
  },
);
