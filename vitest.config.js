import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 20000,
    hookTimeout: 25000,
    pool: 'forks',
    singleFork: true,
    // data-access uses mocked Redis (vitest); helpers uses DI pattern (vitest)
    // pure/redis-ops/utils use node:test runner instead
    include: ['test/data-access.test.js', 'test/helpers.test.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['lib/**/*.js'],
      exclude: [],
      all: true,
    },
  },
});
