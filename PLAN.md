# Plan: Agent Driver Badge + Model Display

## Task Summary
Add `agentDriver`/`agentModel` badge display on job cards when driver is not 'claude'.
Add driver/model fields to the cron form and chat submit input.

## Approach
Minimal, backward-compatible changes to `public/index.html` only (+ version bump):
1. Add CSS for `.driver-badge` — small muted monospace style fitting dark terminal aesthetic
2. Update `makeCard()` to render badge in card-repo bar when `agentDriver` is set and != 'claude'
3. Update `makeSidebarItem()` to show badge inline
4. Add `agent_driver` select + `agent_model` text input to the cron add form
5. Add driver selector to chat input bar so users can select driver when sending messages
6. Include driver/model in cron POST and chat send payloads

## Badge logic
- If `agentDriver` is missing or 'claude': show nothing (backward compatible)
- If `agentDriver` is 'qwen' and `agentModel` is 'qwen2.5-72b-instruct': show `[qwen2.5-72b]`
- If `agentDriver` is 'aider': show `[aider]`
- Prefer shortening model by removing driver prefix, then slice at 22 chars

## Drivers list
claude, aider, openai, qwen, kimi, deepseek, pi

## Files to touch
- `public/index.html` — CSS + JS
- `package.json` — version bump

## Risks
- Badge must use escHtml to prevent XSS
- Cron form fields are optional; default to 'claude' if blank
