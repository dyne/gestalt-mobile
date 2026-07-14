import tseslint from 'typescript-eslint';

export default [
  { ignores: ['dist/', 'node_modules/', 'src/server/platform/codex/generated/'] },
  ...tseslint.configs.recommended,
];
