# TODO: Write tests for business logic

- [x] Write PLAN.md and TODO.md
- [ ] Install npm dependencies (`npm install --ignore-scripts`)
- [ ] Create `lib/pure.js` (parseJob, mimeFor, isAllowed, resolvePath, diffTools)
- [ ] Create `lib/redis-ops.js` (getNamespaces, getJobIds, fetchJob, fetchJobs, fetchMetaStatus, getOutputTail, pollNewOutput, getSwarms)
- [ ] Refactor `server.js` to import from lib/ and pass redis/outputLengths to DI functions
- [ ] Create `test/pure.test.js`
- [ ] Create `test/redis-ops.test.js`
- [ ] Add `"test"` script to `package.json`
- [ ] Smoke check: `node --check server.js`
- [ ] Run tests: `npm test`
- [ ] git checkout -b, commit, push, PR, merge, publish
