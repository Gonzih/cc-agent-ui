# Plan: Unit Tests for Utility Functions

## Task
Write comprehensive unit tests for all utility, helper, and standalone functions in `server.js` that currently lack test coverage. Include edge cases, error conditions, and boundary tests.

## Identified Testable Functions

Pure/standalone functions in `server.js` that can be tested without Redis:
1. `parseJob(raw)` — JSON parse with null-safety
2. `mimeFor(ext)` — Extension → MIME type lookup
3. `isAllowed(p)` — Security path-access check
4. `resolvePath(p)` — Path resolution with ~ expansion
5. `diffTools(prevArr, currArr)` — RecentTools array diff for WS broadcast deduplication

## Approaches

### Option A: Test functions inline (copy-paste into test file)
- Pros: No code changes to server.js
- Cons: Duplicates logic; tests don't reflect actual code

### Option B: Extract utilities to `lib/utils.js`, import in both server.js and tests ✓
- Pros: Tests the real code, no duplication, good architecture
- Cons: Requires refactoring server.js (minimal, well-scoped)

### Option C: Use dynamic import with mocked redis
- Pros: Tests the full server module
- Cons: Complex mocking, fragile, heavy

**Chosen approach: Option B** — extract pure utility functions to `lib/utils.js`, update server.js to import from there, write tests against `lib/utils.js`.

## Files to Touch
- `lib/utils.js` (new) — extracted pure utility functions
- `server.js` — import from lib/utils.js instead of defining inline
- `test/utils.test.js` (new) — comprehensive unit tests
- `package.json` — add `"test": "node --test"` script

## Risks
- `isAllowed` uses `os.homedir()` and `path.resolve()` — tests must account for real system paths or stub appropriately
- `server.js` has top-level `await redis.connect()` — can't import server.js in tests; extracting utils avoids this entirely
