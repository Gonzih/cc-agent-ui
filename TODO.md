# TODO: Resizable sidebar meta-agents section

- [x] Write PLAN.md and TODO.md
- [ ] Create feature branch feat/sidebar-resizable-meta
- [ ] Add #sidebar-resizer HTML div between #job-list and #meta-section
- [ ] Update CSS: resizer styles, fix #meta-section (remove max-height/border-top, add min-height), add min-height to #job-list, restyle #meta-header
- [ ] Add drag-to-resize JavaScript logic (mousedown/move/up + localStorage persistence)
- [ ] Smoke test: node --check server.js
- [ ] Bump version: npm version patch --no-git-tag-version
- [ ] Commit, push branch, gh pr create --head feat/sidebar-resizable-meta
- [ ] gh pr merge --squash --auto
- [ ] npm publish --access public
