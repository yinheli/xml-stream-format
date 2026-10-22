import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Generous default so slower CI machines never flake; timing-sensitive tests set their own.
    testTimeout: 20_000,
    typecheck: {
      enabled: true,
      include: ['test/**/*.test.ts'],
      tsconfig: './tsconfig.test.json',
    },
    coverage: {
      include: ['src/**'],
      reporter: ['text', 'html'],
    },
  },
});
