# TODO: Write tests for business logic

- [x] Write PLAN.md and TODO.md
- [x] Install npm dependencies
- [x] Create `lib/utils.js` (parseJob, mimeFor, isAllowed, resolvePath, diffTools)
- [x] Create `lib/redis-ops.js` (getNamespaces, getJobIds, fetchJob, fetchJobs, fetchMetaStatus, getOutputTail, pollNewOutput, getSwarms)
- [x] Refactor `server.js` to import from lib/ and pass redis/outputLengths to DI functions
- [x] Create `test/pure.test.js`
- [x] Create `test/redis-ops.test.js`
- [x] Add `"test"` script to `package.json`
- [x] Smoke check: `node --check server.js`
- [x] Run tests: `npm test` → 116 pass, 0 fail
- [x] Commit + PR + merge + publish
