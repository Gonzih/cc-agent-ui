# Plan: Add lib/helpers.js vitest coverage

## Unique contribution
Adds `lib/helpers.js` + `test/helpers.test.js` (47 vitest tests, 100% coverage) extending
the existing test infrastructure with cleanGhostChatLogs coverage and a parameterized
jobsDir approach for testable disk-fallback paths.

Prior PRs (#49-#54) covered pure functions, Redis ops, data access, and fs-handlers.
This PR adds `cleanGhostChatLogs` coverage (not present in other test files) and
`lib/helpers.js` as an extended DI variant.
