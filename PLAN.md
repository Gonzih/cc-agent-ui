# Plan: Meta Agents Tab — Discord-like live streaming view

## Task restatement

Add a "Meta Agents" tab as the first/primary tab with a Discord-like two-panel layout:
- Left panel: namespace list (like Discord channel list) from Redis
- Right panel: streaming log for selected namespace via SSE + Redis pub/sub

Restructure nav: Meta Agents → Jobs → Crons. Remove/hide Swarms button. Keep Wiki.

## Approach

Single PR touching server.js (2 new endpoints) and public/index.html (CSS + HTML + JS).

**Server-side additions:**
1. `GET /api/meta-agents` — list namespaces from:
   - `cca:discord:channels:index` (set of channel IDs) → `cca:discord:channel:{id}` (HASH → `namespace` field)  
   - Fallback: scan `cca:meta:*:heartbeat` keys
   - Include `lastActive` from `cca:meta:{ns}:heartbeat`
2. `GET /api/meta-agents/{ns}/stream` — SSE endpoint mirroring `/api/jobs/{id}/stream`:
   - History: `LRANGE cca:meta:{ns}:log 0 199`
   - Live: subscribe to `cca:meta:{ns}:stream` pub/sub channel

**Client-side additions:**
- CSS: Meta agents panel, namespace list (Discord-like), stream view, message type colors
- HTML: `#meta-agents-panel` with `#ma-ns-list` (left) + `#ma-stream` (right)
- JS: `metaLoad()`, `metaSelectNs(ns)`, message classification, SSE lifecycle, tab integration

**Message classification (from JSON chunks `{ ts, ns, text }` or raw text):**
- Tool calls (contains "Tool:", "Running", JSON patterns) → blue/purple, monospace, subtle tint
- System events (session started, /compact, /clear, cc-agent prefix) → gray italic
- Assistant text → normal light text

## Files touched

1. `server.js` — 2 new REST/SSE endpoints
2. `public/index.html` — CSS (meta panel styles), HTML (panel markup), JS (meta tab logic)

## Risks

- `redis.keys('cca:meta:*:heartbeat')` is O(N) but fine for dev/small deployments
- SSE unsubscribe: must call `sub.disconnect()` on req close (same as job stream pattern)
- Namespace param needs validation to prevent Redis key injection
- Wiki tab: keep it (not in restructure requirement = keep as-is)
