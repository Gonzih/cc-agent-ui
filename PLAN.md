# Plan: Test Coverage for Error Handling and Edge Cases

## Task
Add comprehensive test coverage for uncovered error handling and edge cases across all modules in cc-agent-ui. This includes exception handlers, validation logic, unusual input scenarios, and error boundaries.

## Approach: Extract + Inject + Test

To make the server testable without a live Redis connection, extract the three categories of logic into injectable modules:

1. **lib/utils.js** — Pure functions (no I/O). Fully unit-testable with zero mocking.
2. **lib/redis-helpers.js** — Redis-dependent functions, each taking `redis` as first argument so tests can inject a mock.
3. **lib/fs-handlers.js** — HTTP file-system route handlers extracted as functions taking `(req, res)`. Testable with mock req/res objects (no Redis needed for these endpoints).

server.js becomes a thin orchestrator that wires these modules together.

## Files changed
- `lib/utils.js` (new) — parseJob, mimeFor, isAllowed, resolvePath, diffTools
- `lib/redis-helpers.js` (new) — getNamespaces, getJobIds, fetchJob, fetchJobs, fetchMetaStatus, getOutputTail, pollNewOutput, getSwarms
- `lib/fs-handlers.js` (new) — handleBrowse, handleFsStat, handleFsLs, handleFsCat, handleFsRaw
- `server.js` — import from lib modules (minimal change)
- `test/utils.test.js` (new) — ~50 cases for pure functions
- `test/redis-helpers.test.js` (new) — ~30 cases with mock Redis
- `test/fs-handlers.test.js` (new) — ~25 cases with mock req/res
- `package.json` — add test script

## Risks
- server.js has top-level await redis.connect(); cannot be imported in tests without live Redis. Solution: don't import server.js in tests — test lib modules directly.
- isAllowed uses ALLOWED_ROOTS that includes os.homedir() — tests run as actual user so homedir is known.
- fs-handlers tests write/read real temp files (using os.tmpdir()) — safe, deterministic.
