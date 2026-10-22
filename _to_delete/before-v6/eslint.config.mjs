import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/.next/**', 'docs/reference/**', '**/next-env.d.ts'] },
  { files: ['tools/**/*.mjs'], languageOptions: { globals: { process: 'readonly', console: 'readonly', fetch: 'readonly', URL: 'readonly', URLSearchParams: 'readonly', setTimeout: 'readonly' } } },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // Money must never be a JS float; engine code uses Decimal. See ADR-0005.
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='parseFloat']",
          message: 'Do not use parseFloat for money. Use Decimal (packages/payroll-engine).',
        },
      ],
    },
  },
);
