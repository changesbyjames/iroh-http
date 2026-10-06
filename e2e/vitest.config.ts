import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // Each file owns real endpoints and, for the Rust suite, a child process.
    fileParallelism: false
  }
});
