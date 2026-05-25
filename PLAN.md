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
- Extract pure functions → `lib/pure.js`
- Extract Redis functions with DI → `lib/redis-ops.js`
- Test both with `node:test` + mock Redis objects
- No new test framework deps (Node 22 has stable built-in runner)

**B: Integration tests against a real Redis**
- Requires Redis running in CI and test environment — brittle
- Out-of-scope for a unit-test task

**C: Module mocking with import.meta / loader hooks**
- Complex ESM mock setup; node:test --experimental-loader still unstable
- More setup complexity for the same coverage

## Files to create
- `lib/pure.js` — pure functions: parseJob, mimeFor, isAllowed, resolvePath, diffTools
- `lib/redis-ops.js` — Redis functions (DI): getNamespaces, getJobIds, fetchJob, fetchJobs, fetchMetaStatus, getOutputTail, pollNewOutput, getSwarms
- `test/pure.test.js` — unit tests for all pure functions
- `test/redis-ops.test.js` — unit tests for Redis functions using mock Redis

## Files to modify
- `server.js` — import from lib/ instead of defining functions inline; pass `redis` + `outputLengths` to DI functions
- `package.json` — add `"test": "node --test test/"` script

## Risks
- server.js uses `outputLengths` as module-level state; DI wires it as a parameter to redis-ops
- @gonzih/cc-wire must be installed (npm install) before tests can run
- diffTools fallback line is dead code (overlap=0 always matches); tests must reflect actual behavior
