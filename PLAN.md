# Plan: fix/meta-chat-dedup-v2

## Task
Fix two remaining message duplication gaps in the meta-agent chat panel.

## Gap 1
`mpOpen` loads history and renders it, but never seeds `seenMsgIds`. If the poll loop fires
after open, those messages have unknown IDs → shown again.

**Fix:** In `mpOpen` history loop, add `if (m.id) seenMsgIds.add(m.id)` before rendering.

## Gap 2
For cc-tg namespace: UI writes message (UUID-A) to log AND publishes to `cca:chat:incoming`.
cc-tg writes a second entry with different UUID-B. Both IDs are distinct → seenMsgIds can't dedup.

**Fix (frontend only):** Content-based dedup for `role: 'user'` msgs via `recentUserMsgs[]`.
`isRecentDuplicate()` checks content match within 10s window. Seed from history in `mpOpen`.

## Files to touch
- `public/index.html` only
- `package.json` (version bump)

## Risks
- Content-based dedup could suppress a legitimate re-send of same message within 10s — acceptable.
