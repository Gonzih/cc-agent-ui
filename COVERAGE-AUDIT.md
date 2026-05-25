# Coverage Audit — Baseline Report

**Date:** 2026-05-25  
**Tool:** Vitest 4.1.7 + @vitest/coverage-v8 (V8 native)  
**Branch:** main @ 32d2459

---

## Summary

| File | Statements | Branches | Functions | Lines | Uncovered |
|------|-----------|---------|-----------|-------|-----------|
| `src/utils.js` | 95.65% (22/23) | **100%** (18/18) | **100%** (6/6) | 93.75% (15/16) | line 77 |
| `server.js` | **0%** | **0%** | **0%** | **0%** | (not unit-testable — see below) |

---

## Covered: `src/utils.js`

All 5 exported utility functions are tested with 35 test cases:

| Function | Statements | Branches | Notes |
|----------|-----------|---------|-------|
| `mimeFor(ext)` | 100% | 100% | 24 extension cases + unknown fallback |
| `isAllowed(p)` | 100% | 100% | homedir, /tmp, /workspace, tilde, path traversal |
| `resolvePath(p)` | 100% | 100% | tilde expansion + absolute + relative |
| `parseJob(raw)` | 100% | 100% | valid JSON, null, undefined, empty, invalid |
| `diffTools(prev, curr)` | ~96% | 100% | all branches covered; one line unreachable |
| `ALLOWED_ROOTS` (const) | 100% | N/A | exported constant |

### Identified Dead Code

**`src/utils.js` line 77** — `diffTools` fallback:
```js
return currArr.slice(-Math.min(3, currArr.length)); // fallback: last 3
```
This line is **unreachable**. The `for` loop above iterates `overlap` from `min(prev.length, curr.length)` down to `0`. At `overlap=0`, `prevSuffix` and `currPrefix` are both `[]`, which always stringify-equal. So `currArr.slice(0)` (= all of `currArr`) is always returned before the fallback.

**Recommendation:** Remove the dead fallback line, or rewrite the loop to `overlap >= 1` if you actually want the last-3 fallback to trigger.

---

## Not Covered: `server.js`

`server.js` (955 lines after refactor) connects to Redis at module load via top-level `await redis.connect()`. This makes it **non-importable** in unit tests without a live Redis instance. All logic in this file has **0% coverage** at baseline.

### Functions / Handlers (all uncovered)

#### Utility / State helpers (Redis-dependent)
| Function | Lines | Notes |
|----------|-------|-------|
| `cleanGhostChatLogs()` | ~14 | Scans `cca:chat:log:*`, deletes ghost keys |
| `broadcast(evt)` | ~5 | Iterates `clients` Set, sends JSON to WebSocket clients |
| `getNamespaces()` | ~5 | `redis.keys(jobIndexKey('*'))` |
| `getJobIds(namespace)` | ~3 | `redis.sMembers(jobIndexKey(ns))` |
| `fetchJob(id)` | ~5 | `redis.get(jobKey(id))` + `parseJob` |
| `fetchJobs(ids)` | ~10 | Redis pipeline batch |
| `fetchMetaStatus(ns)` | ~5 | `redis.get(metaAgentStatusKey(ns))` |
| `getOutputTail(id, n)` | ~15 | Redis lRange + disk fallback |
| `pollNewOutput(id)` | ~9 | Redis lLen + lRange delta |
| `getSwarms()` | ~15 | Scans `cca:swarm:*`, filters by `swarm_id` |
| `buildSnapshot()` | ~45 | Aggregates all namespaces, jobs, meta-agents, swarms |
| `diffTools(prev, curr)` | — | **Now in `src/utils.js`** (100% covered) |

#### HTTP Routes (all uncovered)
| Route | Method | Lines | Description |
|-------|--------|-------|-------------|
| `/` | GET | ~5 | Serve `public/index.html` |
| `/api/browse` | GET | ~20 | Directory listing or file stream |
| `/api/fs/stat` | GET | ~12 | File stat |
| `/api/fs/ls` | GET | ~15 | Directory listing |
| `/api/fs/cat` | GET | ~12 | File content (<1MB) |
| `/api/fs/raw` | GET | ~8 | Raw file stream |
| `/api/job/output` | GET | ~8 | Full job output tail (5000 lines) |
| `/api/job/action` | POST | ~35 | approve / cancel / wake / message |
| `/api/open` | GET | ~5 | Open file in VS Code / system |
| `/crons` | GET | ~8 | List crons |
| `/crons` | POST | ~12 | Create cron |
| `/crons/:id` | DELETE | ~10 | Delete cron |
| `/crons/:id` | PATCH | ~12 | Update cron |
| `/api/config` | GET | ~3 | Return namespace |
| `/chat/history` | GET | ~10 | Chat log (last 100) |
| `/chat/send` | POST | ~25 | Send chat message (meta-agent routing) |
| `/chat/stream` | GET | ~40 | SSE stream for chat messages |
| `/versions` | GET | ~12 | Component version info |
| `/api/meta-agents` | GET | ~15 | List meta-agents |
| `/api/meta-chat/log` | GET | ~10 | Meta-chat log for namespace |
| `/api/meta-chat/send` | POST | ~35 | Send meta-chat (auto-provision) |
| `/api/swarms` | GET | ~8 | List swarms |
| `/api/swarm/trigger` | POST | ~15 | Trigger new swarm |
| `/api/jobs/:id/stream` | GET | ~55 | SSE job output stream + fallback poll |
| Static files | GET | ~8 | `public/` file serving |

#### WebSocket + Polling Intervals (all uncovered)
| Component | Lines | Description |
|-----------|-------|-------------|
| `wss.on('connection')` | ~12 | WebSocket connection + snapshot send |
| `setInterval` job status poll | ~45 | 2500ms — detect status changes, tool diffs |
| `setInterval` output poll | ~25 | 900ms — stream new output lines for active jobs |
| `setInterval` meta-chat poll | ~20 | 2500ms — detect new chat messages |
| `setInterval` meta-status poll | ~18 | 2000ms — detect typing/tool changes |
| `setInterval` swarm poll | ~18 | 5000ms — detect swarm status changes |

---

## Uncovered Branches in `server.js`

### `getOutputTail` (lines ~143–159)
- Branch 1: `len > 0` (Redis has data) ✗
- Branch 2: Redis empty → disk fallback ✗
- Branch 3: Disk fallback fails → return `[]` ✗

### `/api/job/action` POST handler
- Branch: `action === 'approve'` ✗
- Branch: `action === 'cancel'` ✗
- Branch: `action === 'wake'` ✗
- Branch: `action === 'message'` ✗
- Branch: `message` truthy/falsy ✗
- Branch: `job not found` → 404 ✗

### `/chat/send` POST handler
- Branch: `metaStatus && metaStatus.status === 'running'` → route to meta-agent input ✗
- Branch: no meta-agent → publish to chatIncomingChannel ✗

### `/api/meta-chat/send` POST handler
- Branch: `!members.includes(canonicalNs)` → auto-provision ✗
- Branch: `ns.includes('/')` → extract canonical short name ✗

### `/api/swarm/trigger` POST handler
- Branch: `!goal` → 400 ✗
- Branch: `maxAgents` clamped to `[1, 50]` ✗

### SSE job stream `/api/jobs/:id/stream`
- Branch: pub/sub succeeds → live stream ✗
- Branch: pub/sub fails → fallback poll ✗
- Branch: `closed=true` during initial backlog ✗

### `buildSnapshot` sorting
- Branch: `ORDER[a.status] ?? 9` for unknown status ✗

### Job status polling interval
- Branch: new job (not in `jobCache`) ✗
- Branch: status changed → `job_update` broadcast ✗
- Branch: status unchanged → cache update ✗
- Branch: `recentTools` diff produces new items ✗

---

## Roadmap to Full Coverage

### Phase 1 (high value, low effort)
1. Add integration test setup using [`ioredis-mock`](https://github.com/stipsan/ioredis-mock) or [`redis-memory-server`](https://github.com/mhassan1/redis-memory-server) to make `server.js` importable
2. Write HTTP tests using Node's `fetch` or `supertest` for the 25 routes
3. Write WebSocket tests using the `ws` client library

### Phase 2 (complex)
4. Test SSE endpoints (job stream, chat stream) — requires EventSource or raw HTTP chunked responses
5. Test polling intervals — use fake timers (`vi.useFakeTimers`)
6. Test `buildSnapshot` with various Redis states

### Estimated effort to reach 80% coverage
~3–4 days: integration test setup + HTTP route tests + key Redis helper tests
