# TODO: Unit Tests for Utility Functions

- [x] Write PLAN.md and TODO.md
- [ ] Create `lib/utils.js` with extracted pure functions: parseJob, mimeFor, isAllowed, resolvePath, diffTools
- [ ] Update `server.js` to import from `lib/utils.js`
- [ ] Add `"test": "node --test"` to package.json scripts
- [ ] Create `test/utils.test.js` with comprehensive tests
  - [ ] parseJob: null, undefined, empty string, valid JSON, invalid JSON
  - [ ] mimeFor: all known extensions, unknown extension, empty string
  - [ ] isAllowed: homedir paths, /tmp paths, /workspace paths, forbidden paths, ~ expansion, traversal attempts
  - [ ] resolvePath: ~ prefix, absolute path, relative path
  - [ ] diffTools: both empty, curr empty/null, prev empty (first snapshot), identical, new tail items, fallback case
- [ ] Run tests (node --test)
- [ ] Syntax check server.js (node --check server.js)
- [ ] Commit + PR + merge + publish
