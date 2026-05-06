# TODO: fix/meta-chat-dedup-v2

- [ ] Create branch fix/meta-chat-dedup-v2
- [ ] Add `recentUserMsgs` array + `isRecentDuplicate()` near `seenMsgIds` declaration
- [ ] Update `handleMetaMsg` to call `isRecentDuplicate()` after seenMsgIds check
- [ ] Update `mpOpen` history loop to seed both `seenMsgIds` and `recentUserMsgs`
- [ ] Smoke test: node --check server.js
- [ ] Bump version: npm version patch --no-git-tag-version
- [ ] Commit + push + gh pr create --head fix/meta-chat-dedup-v2
- [ ] gh pr merge --squash --auto
- [ ] npm publish --access public
