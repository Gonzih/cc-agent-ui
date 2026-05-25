import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 20000,
    hookTimeout: 25000,
    pool: 'forks',
    singleFork: true,
    // Only run the API integration test with vitest (pure/redis-ops use node:test)
    include: ['test/data-access.test.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['lib/**/*.js'],
      exclude: [],
      all: true,
    },
  },
});
