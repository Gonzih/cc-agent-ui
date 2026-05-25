# Plan: Initial Coverage Audit

## Task
Set up a test framework with coverage reporting, identify all functions with <100% coverage, and document uncovered branches. This is a baseline audit — the output is a coverage report and gap analysis.

## Situation
- `server.js` (992 lines) contains all application logic: HTTP routes, WebSocket, Redis polling, utility helpers
- Zero tests exist
- `server.js` uses top-level `await redis.connect()` at module scope → cannot be imported in tests without a live Redis instance
- Pure utility functions (`mimeFor`, `isAllowed`, `resolvePath`, `parseJob`, `diffTools`) are embedded in `server.js` and CAN be tested once extracted

## Approaches

### A. Extract utils + Vitest (chosen)
- Extract the 5 pure utility functions to `src/utils.js`
- Import them back in `server.js` (no behavior change)
- Install `vitest` + `@vitest/coverage-v8` as devDependencies
- Write `src/utils.test.js` with full branch coverage of each utility
- Run `npx vitest run --coverage` → get V8 coverage report
- Document uncovered code in `server.js` (all routes, WebSocket, polling intervals)
- **Pro:** Works without Redis, tests pure logic, establishes infrastructure
- **Con:** `server.js` routes remain uncovered at this stage

### B. Integration tests with real Redis
- Start a Redis instance in tests, import server.js
- **Pro:** Covers all routes
- **Con:** Requires Redis running, complex setup, out of scope for baseline audit

### C. HTTP supertest with mocked Redis
- Heavily mock the `redis` client module
- **Pro:** Route coverage
- **Con:** ESM mock complexity with Vitest, top-level await makes this fragile

## Approach chosen: A (extract utils + Vitest)

## Files to touch
- `src/utils.js` — new, extracted pure utilities
- `src/utils.test.js` — new, test suite for utils
- `server.js` — update imports to use `src/utils.js`
- `package.json` — add devDependencies + test/coverage scripts
- `vitest.config.js` — new, configure coverage

## Risks
- ESM module resolution: Vitest handles this natively, low risk
- `os.homedir()` usage in `isAllowed`/`resolvePath`: calls real OS function, deterministic
- `server.js` coverage will show ~0% after extraction — that's the expected baseline

## Deliverable
A committed `COVERAGE-AUDIT.md` file listing:
1. Covered functions (tested in utils.test.js)
2. Uncovered functions/routes in server.js with branch analysis
3. Coverage % baseline per file
