# Plan: Fix meta-chat message duplication

## Task restatement
Messages appear 2-3x in the meta-agent chat panel. Two code paths deliver the same message.

## Root cause (confirmed by reading code)

**Race condition in `/api/meta-chat/send` (server.js ~line 628-631):**

```js
const newLen = await redis.lPush(...);  // newLen known here
await redis.lTrim(...);                 // event loop can yield HERE
metaChatLengths[canonicalNs] = newLen; // update happens too late
broadcast({ type: 'meta_msg', ... });  // first broadcast
```

During the `lTrim` await, Node.js event loop can run the poll interval
(setInterval every 2500ms). The poller sees `lLen = N+1` but `prev = N`
(not yet updated), so it broadcasts. Then execution resumes, sets the
length, and broadcasts again → double delivery.

## Fix approaches

### A. Move `metaChatLengths` update before `lTrim` (primary — chosen)
Set `metaChatLengths[canonicalNs] = newLen` immediately after `lPush`,
before the `lTrim` await. The poller sees the updated length during the
yield and skips. One-line move, no new state.

### B. recentlyBroadcast Set on server
Add a module-level Set; in send handler add msg.id; in poll loop skip if
in Set. More code, two places to touch.

### C. Frontend-only dedup
Add `seenMsgIds` Set in frontend. Masks but does not fix the bug.

## Decision
**Primary**: Approach A (move assignment before `lTrim`).
**Safety net**: Also add frontend `seenMsgIds` dedup to guard against any
other duplicate paths (agent responses, reconnects, etc.).

## Files to touch
- `server.js` — move `metaChatLengths[canonicalNs] = newLen` before lTrim
- `public/index.html` — add `seenMsgIds` Set + guard in `handleMetaMsg`
- `package.json` — version bump (patch)
