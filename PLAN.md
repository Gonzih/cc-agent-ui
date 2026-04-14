# PLAN: Meta Agents Sidebar + Right-Side Panel (0.5.3)

## Task Restatement

Add a "meta agents" section at the bottom of the sidebar that lists all `cca:chat:log:*` namespaces found in Redis. Clicking a meta agent opens a right-side slide-in panel showing:
- An icon-strip (compressed activity view of recent tool/message icons)
- A scrollable chat view (user/assistant messages)
- A send bar to push messages to `cca:meta:{ns}:input`

## Approach

Single approach — the spec is fully detailed with exact code snippets. Implement it faithfully.

**Files to touch:**
- `server.js` — add metaChatLengths tracker, update buildSnapshot, 3 new endpoints, 1 new polling interval
- `public/index.html` — CSS, HTML (sidebar section + panel), JS (state, functions, event wiring)
- `package.json` — bump to 0.5.3

## Risks

- `buildSnapshot` already runs on WS connect — meta agent list will be included in initial snapshot, so `initMetaAgents` called from `handleSnapshot` is the right trigger
- `mpEl` and `mpClose` must be defined before `jpOpen` references them; the spec handles this by using direct DOM calls inside `jpOpen` instead of the function reference
- Tool icon regex `^\[tool\]\s+([\w:]+)` must handle mcp-style names — `m[1].split(':').pop()` handles this
