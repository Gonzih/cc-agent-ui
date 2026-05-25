/**
 * Unit tests for lib/utils.js — pure functions, no I/O, no mocking needed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { parseJob, mimeFor, isAllowed, resolvePath, ALLOWED_ROOTS, diffTools } from '../lib/utils.js';

// ─── parseJob ─────────────────────────────────────────────────────────────

describe('parseJob', () => {
  it('returns null for null input', () => {
    assert.equal(parseJob(null), null);
  });

  it('returns null for undefined input', () => {
    assert.equal(parseJob(undefined), null);
  });

  it('returns null for empty string', () => {
    assert.equal(parseJob(''), null);
  });

  it('returns null for invalid JSON', () => {
    assert.equal(parseJob('not-json'), null);
  });

  it('returns null for truncated JSON', () => {
    assert.equal(parseJob('{broken'), null);
  });

  it('returns null for JSON string "null" (falsy after parse is truthy raw)', () => {
    // 'null' is truthy as a raw string, so JSON.parse('null') → null → falsy guard skips
    // parseJob('null') → JSON.parse('null') === null → returned as-is
    assert.equal(parseJob('null'), null);
  });

  it('parses a valid object', () => {
    const result = parseJob('{"id":"abc","status":"running"}');
    assert.deepEqual(result, { id: 'abc', status: 'running' });
  });

  it('parses a valid array', () => {
    const result = parseJob('[1,2,3]');
    assert.deepEqual(result, [1, 2, 3]);
  });

  it('parses a string value', () => {
    assert.equal(parseJob('"hello"'), 'hello');
  });

  it('parses a number value', () => {
    assert.equal(parseJob('42'), 42);
  });

  it('parses nested objects', () => {
    const result = parseJob('{"a":{"b":{"c":1}}}');
    assert.deepEqual(result, { a: { b: { c: 1 } } });
  });

  it('handles JSON with unicode', () => {
    const result = parseJob('{"emoji":"\\uD83D\\uDE80"}');
    assert.ok(result);
    assert.ok(result.emoji);
  });

  it('returns null for leading whitespace in otherwise-invalid JSON', () => {
    assert.equal(parseJob('  {bad'), null);
  });
});

// ─── mimeFor ──────────────────────────────────────────────────────────────

describe('mimeFor', () => {
  const cases = [
    ['js',   'text/javascript'],
    ['ts',   'text/typescript'],
    ['tsx',  'text/typescript'],
    ['jsx',  'text/javascript'],
    ['py',   'text/x-python'],
    ['go',   'text/x-go'],
    ['rs',   'text/x-rust'],
    ['md',   'text/markdown'],
    ['json', 'application/json'],
    ['yaml', 'text/yaml'],
    ['yml',  'text/yaml'],
    ['sh',   'text/x-sh'],
    ['bash', 'text/x-sh'],
    ['html', 'text/html'],
    ['css',  'text/css'],
    ['txt',  'text/plain'],
    ['png',  'image/png'],
    ['jpg',  'image/jpeg'],
    ['jpeg', 'image/jpeg'],
    ['gif',  'image/gif'],
    ['svg',  'image/svg+xml'],
    ['webp', 'image/webp'],
    ['mp4',  'video/mp4'],
    ['webm', 'video/webm'],
    ['mov',  'video/quicktime'],
    ['mp3',  'audio/mpeg'],
    ['wav',  'audio/wav'],
    ['ogg',  'audio/ogg'],
    ['pdf',  'application/pdf'],
    ['clj',  'text/x-clojure'],
    ['cljs', 'text/x-clojure'],
    ['sql',  'text/x-sql'],
    ['log',  'text/plain'],
    ['env',  'text/plain'],
    ['toml', 'text/x-toml'],
  ];

  for (const [ext, expected] of cases) {
    it(`maps .${ext} → ${expected}`, () => {
      assert.equal(mimeFor(ext), expected);
    });
  }

  it('returns application/octet-stream for unknown extension', () => {
    assert.equal(mimeFor('xyz'), 'application/octet-stream');
  });

  it('returns application/octet-stream for empty string', () => {
    assert.equal(mimeFor(''), 'application/octet-stream');
  });

  it('returns application/octet-stream for uppercase extension (map is lowercase-only)', () => {
    assert.equal(mimeFor('JS'), 'application/octet-stream');
  });

  it('returns application/octet-stream for exe', () => {
    assert.equal(mimeFor('exe'), 'application/octet-stream');
  });

  it('returns application/octet-stream for dll', () => {
    assert.equal(mimeFor('dll'), 'application/octet-stream');
  });
});

// ─── isAllowed ────────────────────────────────────────────────────────────

describe('isAllowed', () => {
  const home = os.homedir();

  it('allows the home directory itself', () => {
    assert.ok(isAllowed(home));
  });

  it('allows a path inside home', () => {
    assert.ok(isAllowed(path.join(home, 'Documents', 'file.txt')));
  });

  it('allows /tmp itself', () => {
    assert.ok(isAllowed('/tmp'));
  });

  it('allows a path inside /tmp', () => {
    assert.ok(isAllowed('/tmp/foo/bar.txt'));
  });

  it('allows /workspace itself', () => {
    assert.ok(isAllowed('/workspace'));
  });

  it('allows a path inside /workspace', () => {
    assert.ok(isAllowed('/workspace/project/src'));
  });

  it('rejects /etc/passwd', () => {
    assert.ok(!isAllowed('/etc/passwd'));
  });

  it('rejects /usr/bin/bash', () => {
    assert.ok(!isAllowed('/usr/bin/bash'));
  });

  it('rejects /root', () => {
    // /root is not under any allowed root (unless homedir IS /root)
    if (home !== '/root') {
      assert.ok(!isAllowed('/root'));
    }
  });

  it('rejects path traversal out of /tmp', () => {
    // path.resolve normalises /tmp/../etc/passwd to /etc/passwd
    assert.ok(!isAllowed('/tmp/../etc/passwd'));
  });

  it('rejects deep traversal out of /tmp', () => {
    assert.ok(!isAllowed('/tmp/foo/../../etc/passwd'));
  });

  it('rejects a path that merely starts with an allowed root string but is not under it', () => {
    // /tmp_evil starts with /tmp but is not under /tmp/
    assert.ok(!isAllowed('/tmp_evil'));
  });

  it('rejects /workspace_other', () => {
    assert.ok(!isAllowed('/workspace_other'));
  });

  it('allows tilde-prefixed path inside home', () => {
    assert.ok(isAllowed('~/Documents'));
  });

  it('allows bare tilde (resolves to home)', () => {
    assert.ok(isAllowed('~'));
  });

  it('rejects tilde traversal above home', () => {
    // ~/.. resolves to the parent of homedir — which is outside allowed roots
    // (unless /tmp or /workspace happens to be an ancestor)
    const resolved = path.join(home, '..');
    const expected = ALLOWED_ROOTS.some(r => resolved === r || resolved.startsWith(r + '/'));
    assert.equal(isAllowed('~/..'), expected);
  });
});

// ─── resolvePath ──────────────────────────────────────────────────────────

describe('resolvePath', () => {
  const home = os.homedir();

  it('expands ~ to home directory', () => {
    assert.equal(resolvePath('~'), home);
  });

  it('expands ~/foo to home/foo', () => {
    assert.equal(resolvePath('~/foo'), path.join(home, 'foo'));
  });

  it('expands ~/a/b/c correctly', () => {
    assert.equal(resolvePath('~/a/b/c'), path.join(home, 'a', 'b', 'c'));
  });

  it('returns absolute path unchanged', () => {
    assert.equal(resolvePath('/tmp/test.txt'), '/tmp/test.txt');
  });

  it('resolves relative path from cwd', () => {
    const rel = 'some/relative/path';
    assert.equal(resolvePath(rel), path.resolve(rel));
  });

  it('does not double-expand a path that starts with the home string but not ~', () => {
    const p = path.join(home, 'file.txt');
    assert.equal(resolvePath(p), p); // returned as-is via path.resolve
  });
});

// ─── diffTools ────────────────────────────────────────────────────────────

describe('diffTools', () => {
  it('returns [] when currArr is null', () => {
    assert.deepEqual(diffTools(['a'], null), []);
  });

  it('returns [] when currArr is undefined', () => {
    assert.deepEqual(diffTools(['a'], undefined), []);
  });

  it('returns [] when currArr is empty', () => {
    assert.deepEqual(diffTools(['a'], []), []);
  });

  it('returns last 3 of currArr when prevArr is null (first-snapshot)', () => {
    assert.deepEqual(diffTools(null, ['a', 'b', 'c', 'd']), ['b', 'c', 'd']);
  });

  it('returns last 3 when prevArr is empty', () => {
    assert.deepEqual(diffTools([], ['a', 'b', 'c', 'd']), ['b', 'c', 'd']);
  });

  it('returns all of currArr when prevArr is null and currArr has ≤3 items', () => {
    assert.deepEqual(diffTools(null, ['a', 'b']), ['a', 'b']);
  });

  it('returns [] when arrays are identical', () => {
    assert.deepEqual(diffTools(['a', 'b'], ['a', 'b']), []);
  });

  it('detects one new item at the tail', () => {
    assert.deepEqual(diffTools(['a', 'b'], ['a', 'b', 'c']), ['c']);
  });

  it('detects two new items at the tail', () => {
    assert.deepEqual(diffTools(['a', 'b', 'c'], ['a', 'b', 'c', 'd', 'e']), ['d', 'e']);
  });

  it('handles completely replaced arrays — overlap=0 always matches, returns all of currArr', () => {
    // When no suffix of prevArr matches a prefix of currArr, the loop reaches overlap=0:
    //   prevSuffix=[] === currPrefix=[] → match → return currArr.slice(0) = all items
    // The final fallback line is effectively dead code.
    const result = diffTools(['x'], ['p', 'q', 'r', 's']);
    assert.deepEqual(result, ['p', 'q', 'r', 's']);
  });

  it('fallback returns all items when currArr has ≤3 and no overlap', () => {
    const result = diffTools(['x', 'y'], ['p', 'q']);
    assert.deepEqual(result, ['p', 'q']);
  });

  it('handles single-element arrays — new item', () => {
    assert.deepEqual(diffTools(['a'], ['a', 'b']), ['b']);
  });

  it('handles single-element arrays — same', () => {
    assert.deepEqual(diffTools(['a'], ['a']), []);
  });

  it('handles arrays with object elements', () => {
    const prev = [{ tool: 'read' }];
    const curr = [{ tool: 'read' }, { tool: 'write' }];
    assert.deepEqual(diffTools(prev, curr), [{ tool: 'write' }]);
  });

  it('handles large overlap — only tail items are new', () => {
    const prev = ['a', 'b', 'c', 'd', 'e'];
    const curr = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    assert.deepEqual(diffTools(prev, curr), ['f', 'g']);
  });

  it('returns [] when both arrays are empty', () => {
    assert.deepEqual(diffTools([], []), []);
  });

  it('treats null prevArr the same as empty prevArr for first-snapshot limit', () => {
    const r1 = diffTools(null, ['a', 'b', 'c', 'd', 'e']);
    const r2 = diffTools([], ['a', 'b', 'c', 'd', 'e']);
    assert.deepEqual(r1, r2);
  });
});
