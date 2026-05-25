# Plan: Write tests for business logic and core modules

## Task
Write unit tests covering the uncovered business logic in cc-agent-ui. The server is a monolithic
Express-like Node.js server (server.js) with inline pure functions and Redis-dependent helpers.
None of these have any tests today.

## Approach: Extract + Dependency-inject + Test

### Why this approach
Directly importing server.js in tests would fail: it connects to Redis and starts HTTP/WS servers
at the module level. The cleanest path is to extract the testable logic into lib/ modules so tests
can import and exercise them in isolation.

### Three approaches considered

**A: Extract to lib/, use Node built-in test runner** ← chosen
- Extract pure functions → `lib/utils.js`
- Extract Redis functions with DI → `lib/redis-ops.js`
- Test both with `node:test` + mock Redis objects
- No new test framework deps (Node 22 has stable built-in runner)
- Also added vitest with coverage reporting as devDependency

**B: Integration tests against a real Redis**
- Requires Redis running in CI and test environment — brittle
- Out-of-scope for a unit-test task

**C: Module mocking with import.meta / loader hooks**
- Complex ESM mock setup; node:test --experimental-loader still unstable
- More setup complexity for the same coverage

## Files created
- `lib/utils.js` — pure functions: parseJob, mimeFor, isAllowed, resolvePath, diffTools
- `lib/redis-ops.js` — Redis functions (DI): getNamespaces, getJobIds, fetchJob, fetchJobs, fetchMetaStatus, getOutputTail, pollNewOutput, getSwarms
- `test/pure.test.js` — unit tests for all pure functions (116 total)
- `test/redis-ops.test.js` — unit tests for Redis functions using mock Redis

## Files modified
- `server.js` — imports from lib/ instead of defining functions inline
- `package.json` — added test/test:coverage scripts

## Key finding
The `diffTools` fallback line `return currArr.slice(-Math.min(3, currArr.length))` is unreachable:
the loop at `overlap=0` always matches (both slices are `[]`), so it returns `currArr.slice(0)`.
Tests document this actual behaviour.
