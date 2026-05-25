import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import { parseJob, mimeFor, isAllowed, resolvePath, diffTools } from '../lib/pure.js';

// ── parseJob ──────────────────────────────────────────────────────────────────

describe('parseJob', () => {
  test('returns null for null input', () => {
    assert.strictEqual(parseJob(null), null);
  });

  test('returns null for undefined', () => {
    assert.strictEqual(parseJob(undefined), null);
  });

  test('returns null for empty string', () => {
    assert.strictEqual(parseJob(''), null);
  });

  test('returns null for invalid JSON', () => {
    assert.strictEqual(parseJob('{not json}'), null);
  });

  test('returns null for bare string (not JSON)', () => {
    assert.strictEqual(parseJob('hello'), null);
  });

  test('returns parsed object for valid JSON object', () => {
    const result = parseJob('{"id":"abc","status":"running"}');
    assert.deepStrictEqual(result, { id: 'abc', status: 'running' });
  });

  test('returns parsed array for valid JSON array', () => {
    const result = parseJob('[1,2,3]');
    assert.deepStrictEqual(result, [1, 2, 3]);
  });

  test('preserves nested objects', () => {
    const input = { id: 'x', meta: { tool: 'Read', count: 5 } };
    assert.deepStrictEqual(parseJob(JSON.stringify(input)), input);
  });
});

// ── mimeFor ───────────────────────────────────────────────────────────────────

describe('mimeFor', () => {
  const cases = [
    ['js',   'text/javascript'],
    ['jsx',  'text/javascript'],
    ['ts',   'text/typescript'],
    ['tsx',  'text/typescript'],
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
    ['log',  'text/plain'],
    ['env',  'text/plain'],
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
    ['toml', 'text/x-toml'],
  ];

  for (const [ext, mime] of cases) {
    test(`${ext} → ${mime}`, () => {
      assert.strictEqual(mimeFor(ext), mime);
    });
  }

  test('unknown extension returns application/octet-stream', () => {
    assert.strictEqual(mimeFor('xyz'), 'application/octet-stream');
  });

  test('empty string returns application/octet-stream', () => {
    assert.strictEqual(mimeFor(''), 'application/octet-stream');
  });

  test('uppercase extension not recognized (returns octet-stream)', () => {
    assert.strictEqual(mimeFor('JS'), 'application/octet-stream');
  });
});

// ── isAllowed ─────────────────────────────────────────────────────────────────

describe('isAllowed', () => {
  const home = os.homedir();

  test('allows path inside home directory', () => {
    assert.ok(isAllowed(path.join(home, 'projects', 'foo.js')));
  });

  test('allows exact home directory', () => {
    assert.ok(isAllowed(home));
  });

  test('allows tilde path expanded to home', () => {
    assert.ok(isAllowed('~/documents/file.txt'));
  });

  test('allows path under /tmp', () => {
    assert.ok(isAllowed('/tmp/workdir/output.log'));
  });

  test('allows exact /tmp', () => {
    assert.ok(isAllowed('/tmp'));
  });

  test('allows path under /workspace', () => {
    assert.ok(isAllowed('/workspace/repo/src'));
  });

  test('allows exact /workspace', () => {
    assert.ok(isAllowed('/workspace'));
  });

  test('rejects /etc/passwd', () => {
    assert.ok(!isAllowed('/etc/passwd'));
  });

  test('rejects /usr/local/bin', () => {
    assert.ok(!isAllowed('/usr/local/bin'));
  });

  test('rejects /root (unless that happens to be home)', () => {
    if (home !== '/root') {
      assert.ok(!isAllowed('/root'));
    }
  });

  test('rejects path traversal /tmp/../etc/passwd (resolves out of /tmp)', () => {
    // path.resolve('/tmp/../etc/passwd') → '/etc/passwd' → not in allowed roots
    assert.ok(!isAllowed('/tmp/../etc/passwd'));
  });

  test('rejects /tmpfoo (prefix match must require /)', () => {
    // '/tmpfoo' does NOT start with '/tmp/' and is NOT equal to '/tmp'
    assert.ok(!isAllowed('/tmpfoo'));
  });
});

// ── resolvePath ───────────────────────────────────────────────────────────────

describe('resolvePath', () => {
  const home = os.homedir();

  test('expands ~ to home directory', () => {
    assert.strictEqual(resolvePath('~'), home);
  });

  test('expands ~/foo to home/foo', () => {
    assert.strictEqual(resolvePath('~/foo'), path.join(home, 'foo'));
  });

  test('expands ~/a/b/c', () => {
    assert.strictEqual(resolvePath('~/a/b/c'), path.join(home, 'a', 'b', 'c'));
  });

  test('passes absolute path through unchanged', () => {
    assert.strictEqual(resolvePath('/tmp/foo'), '/tmp/foo');
  });

  test('resolves relative paths to absolute', () => {
    const result = resolvePath('relative/path');
    assert.ok(path.isAbsolute(result), 'result should be absolute');
    assert.ok(result.endsWith('relative/path'));
  });
});

// ── diffTools ─────────────────────────────────────────────────────────────────

describe('diffTools', () => {
  test('returns [] when currArr is empty array', () => {
    assert.deepStrictEqual(diffTools(['a'], []), []);
  });

  test('returns [] when currArr is null', () => {
    assert.deepStrictEqual(diffTools(['a'], null), []);
  });

  test('returns [] when currArr is undefined', () => {
    assert.deepStrictEqual(diffTools(['a'], undefined), []);
  });

  test('returns [] when both are empty', () => {
    assert.deepStrictEqual(diffTools([], []), []);
  });

  test('first snapshot with 4 items returns last 3', () => {
    assert.deepStrictEqual(diffTools([], ['a', 'b', 'c', 'd']), ['b', 'c', 'd']);
  });

  test('first snapshot with 2 items returns both (slice(-2))', () => {
    assert.deepStrictEqual(diffTools([], ['a', 'b']), ['a', 'b']);
  });

  test('first snapshot with null prevArr returns last 3', () => {
    assert.deepStrictEqual(diffTools(null, ['a', 'b', 'c', 'd', 'e']), ['c', 'd', 'e']);
  });

  test('returns [] when arrays are identical', () => {
    assert.deepStrictEqual(diffTools(['a', 'b'], ['a', 'b']), []);
  });

  test('returns new item appended to same prefix', () => {
    assert.deepStrictEqual(diffTools(['a'], ['a', 'b']), ['b']);
  });

  test('returns multiple new items', () => {
    assert.deepStrictEqual(diffTools(['a', 'b'], ['a', 'b', 'c', 'd']), ['c', 'd']);
  });

  test('handles sliding-window overlap (suffix of prev = prefix of curr)', () => {
    // prevArr ends with 'b'; currArr starts with 'b' — 'c' is the new item
    assert.deepStrictEqual(diffTools(['a', 'b'], ['b', 'c']), ['c']);
  });

  test('no overlap — overlap=0 always matches, returns full currArr', () => {
    // The loop reaches overlap=0, where both empty slices match, so the
    // function returns currArr.slice(0) = all of currArr (not "last 3").
    assert.deepStrictEqual(diffTools(['x'], ['a', 'b', 'c']), ['a', 'b', 'c']);
  });

  test('completely disjoint arrays return full currArr', () => {
    assert.deepStrictEqual(diffTools(['x', 'y'], ['p', 'q', 'r']), ['p', 'q', 'r']);
  });

  test('single element arrays — same element returns []', () => {
    assert.deepStrictEqual(diffTools(['a'], ['a']), []);
  });

  test('single element arrays — different element, overlap=0 match, returns [currArr[0]]', () => {
    assert.deepStrictEqual(diffTools(['a'], ['b']), ['b']);
  });
});
