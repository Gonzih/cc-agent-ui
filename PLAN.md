# PLAN: Restore Infinite Canvas + Add Enrichments (0.5.0)

## Task Restatement

PR #23 (0.4.0) replaced the infinite canvas UI with a flat spreadsheet. The owner wants:
1. The original canvas restored (pan/zoom, sidebar, repo columns, job cards, panels)
2. A sticky meta-agent bar added above the canvas (primary namespace chat, last 5 msgs)
3. Per-column chat inputs at the bottom of each repo column
4. Keep the namespace-aware server.js from 0.4.0 (it's correct)

## Approaches

### A) Full restore + surgical additions (CHOSEN)
- `git show <old-commit>:public/index.html` (fetched from GitHub since repo is shallow clone)
- Add meta-bar HTML/CSS/JS on top of restored canvas
- Add per-column chat inside `getOrCreateCol`
- Wire SSE events to `handleChatEvent`

### B) Patch current spreadsheet back to canvas
- Too risky — the canvas code was removed, not just reorganized
- Would require reconstructing pan/zoom, drag, sidebar from memory

### C) Merge old + new manually
- Essentially the same as A but more error-prone

## Chosen Approach: A

**Why:** The old canvas code is directly available from GitHub; minimal risk of regressions.

## Files to Touch

- `public/index.html`: restored from commit 428f0598, then:
  - Add meta-bar HTML after `</div>` (topbar close) at line ~1077
  - Add meta-bar CSS after topbar CSS
  - Add per-column chat CSS
  - Update `getOrCreateCol` to include col-chat section
  - Add meta-bar JS near bottom of script
  - Wire chatSSE.onmessage to handleChatEvent
- `package.json`: bump to 0.5.0
- `server.js`: no changes (already namespace-aware)

## Risks & Unknowns

- Old canvas uses `repoKey(job)` for columns (not namespace) — per-column chat sends to `namespace=key` which may not match Redis namespace keys
- SSE chat stream in old code doesn't pass `namespace` field — wire `handleChatEvent` to the existing SSE handler
