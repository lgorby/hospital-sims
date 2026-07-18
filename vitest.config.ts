import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // The harness/save suites run multi-day sims (~2-4s each); under machine
    // load they can breach vitest's 5s default and flake. The sim is
    // deterministic — a generous ceiling hides nothing, it only kills the
    // load-dependent false negatives.
    testTimeout: 30_000,
  },
});
