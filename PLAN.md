# Plan: Meta-agent namespace resolution — canonical registry, auto-provision, fallback

## Task restatement
Three precise changes to fix how the server discovers meta-agents and how the frontend resolves namespaces:
1. **Change A** — Both `buildSnapshot()` and `/api/meta-agents` currently scan `cca:chat:log:*` (storage) to discover meta-agents. Replace with reads from `cca:meta:agents:index` (the canonical registry). Remove `buildRepoToMetaNsMap()` (it was a workaround). Add `cleanGhostChatLogs()` on startup to delete ghost keys.
2. **Change B** — `/api/meta-chat/send` currently calls `buildRepoToMetaNsMap()`. Replace with inline short-name derivation + auto-provision: if the canonical ns isn't in the registry, register it. Also update `subscribeToNamespaces()` to read from `cca:meta:agents:index` instead of `cca:chat:log:*`.
3. **Change C** — `resolveMetaNs(ns)` in `public/index.html` falls back to the registry lookup only. Add a second fallback: `ns.includes('/') ? ns.split('/').pop() : ns` so any `owner/repo` format works without a registry entry.

## Approach
Direct in-place edits to `server.js` and `public/index.html`. No new files.

## Files to touch
- `server.js` — buildSnapshot(), /api/meta-agents, buildRepoToMetaNsMap(), /api/meta-chat/send, subscribeToNamespaces(), startup
- `public/index.html` — resolveMetaNs()
- `package.json` — version bump

## Risks
- `cca:meta:agents:index` may not exist yet on a fresh instance → `sMembers` returns empty array, handled gracefully
- Ghost log cleanup on startup is intentionally conservative: only deletes keys containing `/` not in canonical set
