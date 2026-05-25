# Plan: Initial Coverage Audit

## Task
Set up a test framework with coverage reporting, identify all functions with <100% coverage, and document uncovered branches. This is a baseline audit — the output is a coverage report and gap analysis.

## Situation
- `server.js` contains all application logic: HTTP routes, WebSocket, Redis polling, utility helpers
- `server.js` uses top-level `await redis.connect()` at module scope → cannot be imported in tests without a live Redis instance
- Pure utility functions (`mimeFor`, `isAllowed`, `resolvePath`, `parseJob`, `diffTools`) extracted to `lib/utils.js`

## Approach chosen: Extract utils + dual test suites
- `lib/utils.js` — extracted pure utilities (canonical module, imported by server.js)
- `test/utils.test.js` — `node:test` based tests (no extra deps)
- `src/utils.test.js` — Vitest based tests with V8 coverage reporting
- `vitest.config.js` — coverage config targeting `lib/**/*.js`

## Files touched
- `lib/utils.js` — pure utility functions (parseJob, mimeFor, resolvePath, isAllowed, diffTools)
- `server.js` — imports from lib/utils.js
- `test/utils.test.js` — node:test suite
- `src/utils.test.js` — vitest suite with coverage
- `package.json` — devDependencies + test/coverage scripts
- `vitest.config.js` — coverage configuration
- `COVERAGE-AUDIT.md` — full baseline gap analysis

## Deliverable
`COVERAGE-AUDIT.md` with: covered functions, uncovered server.js routes/handlers, branch analysis, roadmap
