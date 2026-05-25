# TODO: Initial Coverage Audit

- [x] Write PLAN.md and TODO.md
- [x] Extract pure utils from server.js to lib/utils.js
- [x] Update server.js imports to use lib/utils.js
- [x] Install vitest + @vitest/coverage-v8 as devDependencies
- [x] Add test/coverage scripts to package.json
- [x] Create vitest.config.js
- [x] Write src/utils.test.js with full branch coverage of each util (Vitest)
- [x] Write test/utils.test.js with node:test tests
- [x] Smoke check: node --check server.js (syntax only)
- [x] Run tests: npx vitest run --coverage
- [x] Write COVERAGE-AUDIT.md with full gap analysis
- [ ] Commit + PR + merge + publish
