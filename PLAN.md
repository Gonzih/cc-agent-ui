# PLAN: meta-agent namespace deduplication + column META button routing

## Task Restatement

Two bugs in how meta-agent namespaces are resolved:

**Bug 1 — Ghost sidebar entry:** `cca:chat:log:*` scan returns both `cc-agent`
(canonical) and `gonzih/cc-agent` (ghost from old UI messages). Both appear in the
sidebar META AGENTS list. `gonzih/cc-agent` is dead — no poller reads from its input
queue.

**Bug 2 — META button routes to wrong namespace:** Clicking META on the
`gonzih/cc-agent` kanban column calls `mpOpen("gonzih/cc-agent")`. The meta-agent is
registered as `cc-agent` (with `repoUrl: "https://github.com/gonzih/cc-agent"`), so
the panel opens the dead namespace.

## Approach

Single targeted approach: add a `buildRepoToMetaNsMap()` helper that reads
`cca:meta:agents:index` and maps repo paths to canonical namespaces. Use this map to:
1. Filter ghost entries from `metaAgents` in `buildSnapshot()` and `/api/meta-agents`
2. Resolve canonical ns before pushing to meta input queue in `/api/meta-chat/send`
3. Add `resolveMetaNs(ns)` in the frontend to translate job namespace → canonical ns
   for the column META click handler

## Files to Touch

- `server.js` — add helper, 3 endpoint changes
- `public/index.html` — store `_metaAgentsData`, add `resolveMetaNs()`, update META click
- `package.json` — version bump (patch)

## Risks

- `cca:meta:agents:index` may be empty or absent; `buildRepoToMetaNsMap()` handles
  this gracefully (returns empty map), so the dedup is a no-op if the index is missing.
- The dedup filter removes entries where `repoToNs[a.namespace]` is truthy; if a
  canonical namespace happens to look like a repo path, it won't appear. Very unlikely.
- Adding canonical namespaces that don't have a chat:log key yet: handled by the
  `deduped.find(a => a.namespace === canonicalNs)` check before pushing.
