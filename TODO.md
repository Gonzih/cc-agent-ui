# TODO: Initial Coverage Audit

- [x] Write PLAN.md and TODO.md
- [ ] Extract pure utils from server.js to src/utils.js
- [ ] Update server.js imports to use src/utils.js
- [ ] Install vitest + @vitest/coverage-v8 as devDependencies
- [ ] Add test/coverage scripts to package.json
- [ ] Create vitest.config.js
- [ ] Write src/utils.test.js with full branch coverage of each util
- [ ] Smoke check: node --check server.js (syntax only)
- [ ] Run tests: npx vitest run --coverage
- [ ] Write COVERAGE-AUDIT.md with full gap analysis
- [ ] Commit + PR + merge + publish
