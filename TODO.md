# TODO

- [x] Write PLAN.md and TODO.md
- [ ] Create feature branch `fix/coordinator-bubbles`
- [ ] Add `.mp-msg.coordinator` and `.chat-msg.coordinator` CSS rules
- [ ] Fix `mpMsgEl()` — detect `source !== "claude" && role === "assistant"` → coordinator class + source label
- [ ] Fix `chatMsgEl()` — same detection + coordinator class
- [ ] Fix `appendMetaMsg()` — same detection for the mini meta-bar
- [ ] Fix `handleChatEvent()` col-meta-msgs rendering
- [ ] Smoke test: `npm install --ignore-scripts && node --check server.js`
- [ ] Bump version: `npm version patch --no-git-tag-version`
- [ ] Commit, push, `npm publish --access public`
- [ ] Notify via Redis
- [ ] `gh pr create --head fix/coordinator-bubbles` + `gh pr merge --squash --auto`
