# Plan: Wiki Tab — per-repo LLM knowledge base browser

## Task restatement

Add a browsable/editable "Wiki" tab to cc-agent-ui that reads from Redis HASH keys
(`cca:wiki:{repo_slug}`) written by cc-agent. The tab shows a repo list on the left,
a page list in the middle, and markdown content on the right with inline editing.

## Redis key schema

- `cca:wiki:{repo_slug}` → Redis HASH  (field=page_name, value=markdown string)
- `cca:wiki:{repo_slug}:updated` → String (ISO timestamp of last update)

These are NOT in @gonzih/cc-wire yet — define as local key helpers in server.js.

## Approach

Single PR that touches: server.js (5 new API routes), public/index.html (tab + panel + CSS + JS),
test/helpers/redis-mock.js (hash commands), test/data-access.test.js (wiki test suite).

No new files created for routes — follow existing inline-handler pattern in server.js.
No heavy markdown dep — use `<pre>` for display since content is agent-generated markdown.
A simple marked.js CDN include for basic rendering is acceptable per the spec.

## Files touched

1. `server.js` — add wikiKey() helpers + 5 API endpoints
2. `public/index.html` — Wiki tab button, CSS, HTML panel, JS functions
3. `test/helpers/redis-mock.js` — add hGetAll/hGet/hSet/hDel/hKeys/hLen
4. `test/data-access.test.js` — wiki endpoint test suite appended at end

## Risks

- server.js already imports `swarmKey` without declaring it in imports — this is a pre-existing bug I should not touch
- Redis hash commands not in mock — need to add them carefully
- UI: the index.html is large (~3700 lines); need precise insertions
- Slug validation: only allow `[a-zA-Z0-9_.-]` chars to prevent injection
