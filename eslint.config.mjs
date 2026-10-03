import js from '@eslint/js';
import ts from 'typescript-eslint';
import hooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default ts.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/target/**', 'work/**', 'outputs/**'] },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    files: ['apps/desktop/**/*.ts', 'apps/desktop/**/*.tsx', 'packages/contracts/**/*.ts'],
    languageOptions: { globals: {...globals.browser, ...globals.node} },
    plugins: {'react-hooks': hooks},
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      'no-empty': ['error', {allowEmptyCatch: true}],
      '@typescript-eslint/no-unused-vars': ['error', {argsIgnorePattern: '^_'}],
    },
  },
);
