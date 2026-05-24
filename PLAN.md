# Plan: Swarm Visibility UI

## Task
Add swarm visibility to cc-agent-ui. A new swarm_task MCP tool in cc-agent creates Redis records at `cca:swarm:{swarm_id}` with progress info (goal, status, sub_job_ids, sub_jobs_done, sub_jobs_failed, synthesis_job_id).

## Approach chosen: Thin Redis layer + WebSocket broadcast

### server.js changes
1. Add `swarmCache` state object
2. Add `getSwarms()` helper: scan `cca:swarm:*` keys, parse + return sorted array
3. Include swarms in `buildSnapshot()` response
4. `GET /api/swarms` route
5. `POST /api/swarm/trigger` route — writes to `cca:swarm:requests` Redis list
6. 5s polling interval: detect swarm changes, broadcast `swarm_update` WebSocket event

### public/index.html changes
1. "Swarms" tab button in tab nav
2. CSS: swarm panel, card, progress bar, status badges, form, job swarm badge
3. `#swarms-panel` HTML with trigger form + swarm list
4. JS:
   - `swarms = {}` state (swarm_id → record), `jobToSwarm = {}` reverse map
   - `handleSnapshot`: extract `data.swarms`, call `renderSwarmList()`
   - `ws.onmessage`: handle `swarm_update` → upsert, update badges, re-render
   - `renderSwarmList()`: rebuild swarm list DOM
   - `renderSwarmCard(s)`: goal, progress bar, status badge, sub-job list, synthesis link, cost
   - `swarmLoad()`: GET /api/swarms
   - `swarmCreate()`: POST /api/swarm/trigger
   - `updateJobSwarmBadges()`: update existing sidebar items after swarms load
   - `switchToTab('swarms')` case + 5s poll timer
5. `makeSidebarItem()`: add swarm badge if `jobToSwarm[job.id]` set

## Files changed
- `server.js`
- `public/index.html`

## Risks
- `cca:swarm:*` keys could include `cca:swarm:requests` — filter by checking `s.swarm_id` field exists
- Swarm trigger cc-agent compatibility: cc-agent must read from `cca:swarm:requests` list (TBD by cc-agent impl)
