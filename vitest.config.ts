import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
      reporter: ['text-summary', 'html'],
      // Ratchet set just below the 2026-09-11 baseline (97.1 / 90.4 / 98.5 / 98.6).
      thresholds: { statements: 95, branches: 88, functions: 95, lines: 95 },
    },
  },
});
