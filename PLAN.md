# Plan: Cost display + driver filter + always-on driver badge

## Task summary
Four UI improvements to cc-agent-ui:
1. **Cost per job card** — show `$0.023` on each card footer when `costUsd > 0`
2. **Driver badge always visible** — fix `driverBadge()` to show `[claude]`, `[claude:sonnet-4-6]`, `[qwen:72b]` etc. on ALL jobs
3. **Driver filter bar** — second row of filter buttons (all/claude/qwen/aider/openai/other) above the job list
4. **Per-driver cost summary** — live cost breakdown in topbar (e.g. `claude: $2.34 qwen: $0.12`)

## Approach
Single-file edit of `public/index.html`. Targeted CSS/HTML/JS edits.
Files: `public/index.html`, `package.json` (version bump)
