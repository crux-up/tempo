import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'web/dist/', 'node_modules/', 'data/', 'coverage/', '.claude/', '.superpowers/', 'docs/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
