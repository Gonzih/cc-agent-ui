# Plan: Comprehensive Test Coverage

## Task
Add comprehensive tests for error handling and edge cases across all modules in cc-agent-ui.

## Approach: Extract + Inject + Test (merged from two parallel jobs)

Pure functions, Redis helpers, and HTTP handlers were extracted into `lib/` modules with dependency injection, enabling testing without a live Redis connection.

## Files
- `lib/utils.js` — parseJob, mimeFor, isAllowed, resolvePath, diffTools
- `lib/redis-ops.js` — Redis DI helpers (getNamespaces, getJobIds, fetchJob, fetchJobs, etc.)
- `lib/redis-helpers.js` — Additional Redis helpers with extended signatures
- `lib/fs-handlers.js` — File-system HTTP route handlers
- `lib/pure.js` — Additional pure utility extractions
- `test/utils.test.js` — Pure function unit tests
- `test/pure.test.js` — Pure function tests (alternate)
- `test/redis-ops.test.js` — Redis ops DI tests
- `test/redis-helpers.test.js` — Extended Redis helper tests
- `test/fs-handlers.test.js` — HTTP file-system handler tests + security matrix
- `test/data-access.test.js` — Vitest HTTP API integration tests

## Test runner
- `node --test 'test/**/*.test.js'` — unit/DI tests (no deps)
- `vitest run test/data-access.test.js` — integration tests
