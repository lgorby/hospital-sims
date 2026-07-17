import tseslint from 'typescript-eslint';

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // SSOT rule (tech plan §3.1): game-content numbers live in sim/data/ only.
    // UI and sim systems must read them from the tables, never inline them.
    files: ['src/ui/**/*.ts', 'src/sim/systems/**/*.ts'],
    rules: {
      'no-magic-numbers': [
        'error',
        {
          ignore: [-1, 0, 1, 2],
          ignoreArrayIndexes: true,
          ignoreDefaultValues: true,
          enforceConst: true,
        },
      ],
    },
  },
  {
    ignores: ['dist/', 'node_modules/'],
  },
);
