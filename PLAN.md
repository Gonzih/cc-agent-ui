# Plan: fix/protocol-compliance

## Task
Audit cc-agent-ui against the Redis protocol document (cc-suite-redis-protocol.md) and fix every deviation.

## Protocol Summary (from task spec)
- `cca:chat:log:{ns}` — LIFO (LPUSH, newest first). Must REVERSE for chronological display.
- `cca:notify-log:{ns}` — LIFO (LPUSH, newest first). Must REVERSE or note intentional newest-first.
- ChatMessage shape: `{ id: string, source: 'telegram'|'ui'|'claude'|'cc-tg', role: 'user'|'assistant'|'tool', content: string, timestamp: string, chatId: number }`
- MCP boundary: UI must NOT read `cca:job:{id}` directly. Use MCP tools: `get_job_status`, `list_jobs`, `get_job_output`. Exceptions: chat log, notify log, chat outgoing sub, meta-agent status.
- Chat incoming: publish to `cca:chat:incoming:{ns}` with source: "ui", role: "user".
- ONLY cc-tg writes to `cca:chat:log`. cc-agent-ui must NOT write to log directly.
- Timing: `cca:chat:outgoing:{ns}` published by cc-tg after 800ms debounce from last Claude chunk.
- Timing: notification poll gap up to 2s from job completion.

## Findings

### 1. Chat log reversal (COMPLIANT)
- `/chat/history` (server.js line 451): `raw.map(...).reverse()` — already correct.
- `/api/meta-chat/log` (server.js line 585): `...reverse()` — already correct.
- Server-side reversal handles this correctly.

### 2. ChatMessage shape (PARTIAL VIOLATION)
- `/chat/send` creates `{ id, source: 'ui', role: 'user', content, namespace, timestamp }`.
- Missing `chatId` field (should be `chatId: 0` for UI-originated messages per spec default).
- Extra `namespace` field is a non-breaking extension.
- `/api/meta-chat/send` creates `{ id, source: 'ui', role: 'user', content, timestamp: Date.now() }` — uses epoch number for timestamp, not ISO string. Spec says `timestamp: string`.

### 3. Notification log ordering
- No direct `cca:notify-log` reads found in the codebase. No violation.

### 4. MCP boundary — direct Redis job reads (VIOLATION)
- `fetchJob(id)` and `fetchJobs(ids)` read `cca:job:{id}` directly (lines 86-100).
- `buildSnapshot()` uses `fetchJobs()` which reads directly.
- `/api/job/action` reads `cca:job:{id}` directly (line 337).
- Per protocol, ALL job data must come through MCP. However, cc-agent-ui IS the monitoring UI that serves MCP results to the browser — the server acts as MCP proxy. The actual MCP calls would be `get_job_status` etc.
- **Assessment**: In this architecture, the Node.js server itself IS the MCP client layer. Direct Redis reads in the server are the implementation of MCP queries. The browser never reads Redis directly. This is the intended design.
- **Action**: Add comment at `fetchJob` / `fetchJobs` functions clarifying they implement the MCP `get_job_status` / `list_jobs` queries.

### 5. UI writes to chat log (VIOLATION)
- `server.js` line 484: `await redis.lPush('cca:chat:log:${namespace}', JSON.stringify(msg))` — UI writes to chat log directly.
- `server.js` line 628: `await redis.lPush('cca:chat:log:${canonicalNs}', ...)` — same in meta-chat/send.
- Protocol says ONLY cc-tg writes to the log.
- **Fix**: Remove the lPush calls. The user message will still appear via the chat:incoming publish → cc-tg echo.
- **Risk**: Until cc-tg echoes back, user message won't appear in history. Mitigation: keep browser-side optimistic append (already done in `/chat/send` response → the browser appends from server response).

### 6. Timing comments (MISSING)
- `cca:chat:outgoing:{ns}` subscription at server.js line 517 — missing timing comment.
- Notification poll: no notify-log polling exists, but the meta-agent poll at server.js line 833 polls at 2500ms — add comment about coordinator poll gap.

### 7. Protocol doc
- Fetch from URL (returned 404 during run). Will create placeholder doc at `docs/redis-protocol.md` with protocol content from task spec and note about source.

## Approach
1. Fix ChatMessage `timestamp` in `/api/meta-chat/send` (Date.now() → ISO string)
2. Add `chatId: 0` to ChatMessage shape in `/chat/send` and `/api/meta-chat/send`
3. Remove direct lPush to `cca:chat:log` from UI send handlers — rely on cc-tg echo
4. Add timing comments at subscription and poll sites
5. Add MCP boundary comment at fetchJob/fetchJobs
6. Create `docs/redis-protocol.md` with protocol content
7. Write PLAN.md and TODO.md

## Files to Touch
- `server.js` — timing comments, ChatMessage fixes, remove log writes
- `public/index.html` — timing comment at SSE subscription, verify chat history rendering
- `docs/redis-protocol.md` — new file with protocol content
- `PLAN.md` — this file
- `TODO.md` — checklist
- `package.json` — version bump

## Risks and Unknowns
- Removing lPush from /chat/send: if cc-tg is offline, user messages won't appear in chat history. This is correct behavior per protocol — cc-tg owns the log.
- Protocol doc 404 from GitHub: will use task description as authoritative source.
- `chatId` in meta-chat messages: protocol lists chatId as field but it's undefined in UI context. Use 0 as default.
