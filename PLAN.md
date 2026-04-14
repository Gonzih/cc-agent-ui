# PLAN: Fix meta-agent chat routing (0.5.7)

## Task Restatement

Meta-chat messages are being routed to the wrong destination. When a user sends a
message in the main chat or meta-bar with a namespace that has a running meta-agent,
the message should go to `cca:meta:{namespace}:input` (the LIST the meta-agent polls),
not to `cca:chat:incoming:{namespace}` (which routes to the coordinator/cc-tg).

Additionally, `/chat/stream` only subscribes to namespaces that have jobs (from
`cca:jobs:*`), so meta-agent namespaces without jobs never get their outgoing messages
streamed to the UI.

## Affected Code

### 1. `/chat/send` endpoint (server.js ~line 440)
**Current:** Always publishes to `cca:chat:incoming:{namespace}`
**Fix:** Check `cca:meta-agent:status:{namespace}` → if running, push to
`cca:meta:{namespace}:input` with JSON format `{id, content, timestamp}`.

### 2. `/api/meta-chat/send` endpoint (server.js ~line 549)
**Current:** Pushes raw `message` string to `cca:meta:${ns}:input`
**Fix:** Push `JSON.stringify({id, content, timestamp})` to match meta-agent expectations.

### 3. `/chat/stream` endpoint (server.js ~line 457)
**Current:** Only calls `getNamespaces()` which scans `cca:jobs:*` — misses namespaces
that have only chat logs (meta-agent namespaces).
**Fix:** Also scan `cca:chat:log:*` keys, filter out 'default', and subscribe to
`cca:chat:outgoing:{ns}` for those namespaces.

## Approach

Single approach — straightforward targeted fixes to three existing endpoints. No new
abstractions needed; the routing logic is self-contained per endpoint.

## Files to Touch

- `server.js` — three endpoint changes
- `package.json` — version bump to 0.5.7

## Risks

- `/chat/send` change: if meta-agent status is stale (process died but status not cleared),
  messages may go to the queue instead of the coordinator. Acceptable risk — the meta-agent
  poller will time out; the status key should have a TTL set by the meta-agent process.
- `/chat/stream` change: subscribing to more channels is additive and safe.
- `randomUUID` is already imported at line 19 — no new import needed.
