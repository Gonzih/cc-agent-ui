# Plan: Resizable sidebar meta-agents section

## Task restatement
Add a draggable resize handle between `#job-list` and `#meta-section` in the left sidebar so users can adjust how much space each section gets. The height should persist in localStorage. Improve visual separation and the meta-agents header styling.

## Approaches

### A. Pure CSS flex + JS pointer events (chosen)
Add a `#sidebar-resizer` div between the two sections. JS listens to mousedown/mousemove/mouseup and directly sets `metaSection.style.height`. Simple, no library needed.

### B. ResizeObserver / CSS resize property
CSS `resize: vertical` only works on elements with `overflow: auto` and pointing the right direction — doesn't fit vertical split between two siblings easily.

### C. Third-party library (split.js, allotment)
Overkill for a single-file vanilla HTML project with no build step.

## Decision
**Approach A** — pure JS drag, CSS cursor/highlight, localStorage persistence.

## Files to touch
- `public/index.html` — HTML, CSS, and JS changes only (single-file app)
- `package.json` — version bump

## Risks
- Sidebar may be hidden on small screens (mobile) — min-height guards prevent full collapse
- localStorage may not be available in private/sandboxed contexts — wrapped in try/catch implicitly (parseInt of null returns NaN → falls back to DEFAULT_HEIGHT)
