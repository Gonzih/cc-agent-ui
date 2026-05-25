# Plan: Data Access Tests

## Task
Write tests for all uncovered data access layers in cc-agent-ui. The server.js file
is a ~993-line Node.js ESM module acting as a Redis proxy. It has zero existing tests.

## Approaches considered

### A) Integration tests against real Redis (docker)
- Pro: Tests actual behavior end-to-end
- Con: Requires running Redis; slow; flaky in CI; the repo already has redis in docker-compose but
  starting it from tests is complex

### B) HTTP API tests with mocked Redis (CHOSEN)
- Pro: Tests full request/response cycle; no real Redis needed; fast; reliable
- Con: Only tests publicly-reachable behavior (but that covers all data access paths)

### C) Extract data access functions to lib/ and unit-test them in isolation
- Pro: True unit tests; can test internal helpers
- Con: Requires refactoring server.js (touching lines 100–240); risk of breaking behavior

## Approach: B — Mock Redis + HTTP API tests

Use **Vitest** (ESM-native, fast) with a custom in-memory Redis mock.
- `vi.mock('redis')` intercepts the `createClient` call before server.js loads
- A stateful in-memory mock (Map-based) handles all Redis operations
- Tests make real HTTP requests to a test server running on port 7798
- `beforeEach` resets Redis store so tests are independent

## Files touched
- `package.json` — add vitest devDependency + test script
- `vitest.config.js` — test runner config (singleFork, ESM)
- `test/helpers/redis-mock.js` — stateful in-memory Redis mock
- `test/data-access.test.js` — comprehensive tests for all data access domains

## Test coverage plan
1. **Job output** (`getOutputTail`) — via `GET /api/job/output`
2. **Job actions** (cancel/wake/message/approve) — via `POST /api/job/action`
3. **Cron CRUD** — via `GET/POST /crons` and `DELETE/PATCH /crons/:id`
4. **Swarm data access** — via `GET /api/swarms` and `POST /api/swarm/trigger`
5. **Chat history** (LIFO reversal) — via `GET /chat/history`
6. **Chat send routing** (publish vs lPush) — via `POST /chat/send`
7. **Meta-agent listing** — via `GET /api/meta-agents`
8. **Meta-chat log** (LIFO reversal) — via `GET /api/meta-chat/log`
9. **Meta-chat send** (auto-provisioning) — via `POST /api/meta-chat/send`
10. **Config** — via `GET /api/config`
11. **Versions** — via `GET /versions`
12. **Edge cases** — missing params (400), missing job (404), malformed JSON

## Risks
- server.js has no cleanup export — polling timers run in background (acceptable; they use empty cache)
- `cleanGhostChatLogs()` runs on startup — mock returns [] so it's a no-op
- Port 7798 must not be in use (7701/7702 are occupied per institutional knowledge)
