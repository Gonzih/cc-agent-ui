# TODO

- [x] Write PLAN.md and TODO.md
- [ ] Create feature branch `feat/driver-badge`
- [ ] Add `.driver-badge` CSS rule to index.html
- [ ] Add `driverBadge(job)` helper function in JS
- [ ] Update `makeCard()` to include driver badge in card-repo bar
- [ ] Update `makeSidebarItem()` to include driver badge
- [ ] Add driver select + model input to cron add form HTML
- [ ] Add driver select to chat input bar HTML
- [ ] Update `cronSubmit()` to include agent_driver / agent_model in payload
- [ ] Update `chatSend()` to include agent_driver / agent_model
- [ ] Smoke test: `npm install --ignore-scripts && node --check server.js`
- [ ] Bump version: `npm version patch --no-git-tag-version`
- [ ] Commit, push branch, `gh pr create --head feat/driver-badge`
- [ ] `gh pr merge --squash --auto`
- [ ] `npm publish --access public`
