# PLAN: Spreadsheet Redesign + Per-Namespace Chat

## Task Restatement

Redesign cc-agent-ui as an Excel-style spreadsheet where:
- **Columns = namespaces** (derived from `cca:jobs:*` Redis keys)
- **Rows = job cards** within each namespace column
- **Meta-agent bar** = sticky full-width header showing primary namespace chat
- **Per-column chat** = each namespace column has its own chat input at the bottom
- **Server** = namespace-aware chat endpoints (history, send, stream)

## Approaches Considered

### A) Incremental patch on infinite canvas
- Keep sidebar + canvas, add namespace grouping + mini-chat per column
- Con: The canvas/pan/zoom paradigm conflicts with a readable spreadsheet; scrolling becomes awkward
- Con: Sidebar is redundant in a spreadsheet view

### B) Full spreadsheet redesign (CHOSEN)
- Replace sidebar + infinite canvas with a CSS flex-row spreadsheet
- Compact job cards (status + repo + task + elapsed) in columns keyed by namespace
- Per-column chat inputs at bottom of each column
- Meta-agent sticky bar above the spreadsheet
- Reuse: job detail panel (slideover), file browser, crons panel, tab nav

### C) React/component rewrite
- Too heavy for a single-file vanilla JS project
- Breaks the "keep server.js and index.html as single files" pattern

## Chosen Approach: B

**Why:** Cleanest separation of concerns, fits the CSS grid suggestion in the spec, reuses all the heavy lifting (job detail panel, file browser, crons, WS message handlers).

## Files to Touch

- `server.js`: 4 changes
  - `/chat/history`: add `?namespace=X` param
  - `/chat/send`: read `namespace` from body, save to chat log
  - `/chat/stream`: subscribe to all namespace outgoing channels, include namespace in SSE events
  - `/api/config`: new endpoint returning `{ namespace: NAMESPACE }`
- `public/index.html`: major redesign
  - CSS: remove canvas styles, add spreadsheet/column/compact-card/meta-bar styles
  - HTML: replace `#sidebar` + `#viewport` with `#meta-bar` + `#spreadsheet`
  - JS: replace canvas column management with namespace column management; namespace-aware chat
- `package.json`: bump version to 0.4.0

## Risks & Unknowns

- Redis pub/sub: subscribing to new namespace channels after initial connect while already in subscriber mode — supported by Redis, but need to verify node-redis handles it correctly
- Primary namespace ordering: need `/api/config` to tell the client which namespace is primary (NAMESPACE env var)
- SSE multi-namespace: each SSE connection needs its own subscriber client + poll interval; must clean up on disconnect to avoid leaks
