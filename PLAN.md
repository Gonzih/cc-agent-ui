# Plan: coordinator messages render distinctly (not as assistant bubbles)

## Task restatement
When a coordinator (e.g. cc-tg) sends a message via `message_meta_agent`, it ends up in
`cca:chat:log:{namespace}` with `source: "cc-tg"` (or similar) and `role: "assistant"`.
Currently the UI renders it identically to the meta-agent's own AI responses — same purple
`✦ ` prefix, same color. This is confusing when reviewing sessions.

## What we observed in Redis
`cca:chat:log:money-brain` contains messages with these (source, role) combos:
- `("claude", "assistant")` — meta-agent AI responses (current "assistant" style)
- `("cc-tg", "assistant")` — coordinator's Claude text sent into money-brain (BUG: renders as assistant)
- `("cc-tg", "tool")` — coordinator's tool calls (already rendered as tool bubbles)
- `("telegram", "user")` — Telegram user messages (already rendered as user with badge)
- `("ui", "user")` — UI user messages

The distinguishing signal: `role === "assistant" && source !== "claude"` → coordinator message.

## Approach
Pure UI fix in `public/index.html`. Two render functions need updating:
1. `mpMsgEl()` — meta-agent panel (full chat view)
2. `chatMsgEl()` — primary /chat/ panel

**Visual treatment for coordinator messages:**
- CSS class `coordinator` on the wrapper div (currently uses `assistant`)
- Amber/orange color (distinct from the indigo AI `✦ ` prefix)
- Label `↗ <source>:` prefix so it reads like "↗ cc-tg: <text>"
- Keep `role: "tool"` rendering unchanged (collapsible tool bubbles are fine)

## Files to touch
- `public/index.html` — CSS, `mpMsgEl()`, `chatMsgEl()`, `appendMetaMsg()`
- `package.json` — version bump

## Risks
- Some edge case where `source` is undefined on old log entries — default to "assistant" class
- Coordinator label width might overflow narrow bubbles — use `overflow: hidden; text-overflow: ellipsis`
