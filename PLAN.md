# Plan: Tests for Data Access and ORM Layers

## Task
Write tests for all uncovered data access and ORM layers in cc-agent-ui.
Two parallel jobs tackled this:

### Job A (lib extraction + node:test, already merged to main)
Extracted pure functions and Redis helpers into `lib/`:
- `lib/utils.js` — parseJob, mimeFor, isAllowed, resolvePath, diffTools
- `lib/redis-ops.js` — getNamespaces, getJobIds, fetchJob, fetchJobs, fetchMetaStatus, getOutputTail, pollNewOutput, getSwarms
- `test/pure.test.js` — 116 unit tests using node:test
- `test/redis-ops.test.js` — Redis DI tests using node:test
- `test/utils.test.js` — utils unit tests using node:test

### Job B (API integration tests + vitest, this branch)
Added HTTP API integration tests against a mocked Redis:
- `test/helpers/redis-mock.js` — in-memory mock that intercepts createClient
- `test/data-access.test.js` — 69 tests via vitest covering all HTTP endpoints
  that touch Redis: job output, job actions, cron CRUD, swarms, chat, meta-agents,
  versions, config, file browser security

## Combined test script
```
npm test  →  node:test (lib unit tests) + vitest (API integration tests)
```

## Risks resolved
- Port collision: test server uses 7798 (7701/7702 occupied by live instances)
- Namespace collision: CC_AGENT_NAMESPACE must be overridden in test env
- Module-level side effects: server.js lazily imported after mocks are wired
