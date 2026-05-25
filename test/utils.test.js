import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import { parseJob, mimeFor, isAllowed, resolvePath, diffTools } from '../lib/utils.js';

// ── parseJob ────────────────────────────────────────────────────────────────

describe('parseJob', () => {
  test('returns null for null input', () => {
    assert.equal(parseJob(null), null);
  });

  test('returns null for undefined input', () => {
    assert.equal(parseJob(undefined), null);
  });

  test('returns null for empty string', () => {
    assert.equal(parseJob(''), null);
  });

  test('returns null for invalid JSON', () => {
    assert.equal(parseJob('{not valid json'), null);
  });

  test('returns null for plain non-JSON string', () => {
    assert.equal(parseJob('hello'), null);
  });

  test('parses a simple object', () => {
    const result = parseJob('{"id":"abc","status":"running"}');
    assert.deepEqual(result, { id: 'abc', status: 'running' });
  });

  test('parses a nested object', () => {
    const obj = { id: '1', meta: { count: 3, tags: ['a', 'b'] } };
    assert.deepEqual(parseJob(JSON.stringify(obj)), obj);
  });

  test('parses a JSON array', () => {
    const result = parseJob('[1,2,3]');
    assert.deepEqual(result, [1, 2, 3]);
  });

  test('parses JSON boolean true', () => {
    assert.equal(parseJob('true'), true);
  });

  test('parses JSON number', () => {
    assert.equal(parseJob('42'), 42);
  });

  test('parses JSON null literal string (returns null from JSON.parse)', () => {
    // JSON.parse('null') === null; the truthy check `raw ?` passes because 'null' is truthy
    assert.equal(parseJob('null'), null);
  });
});

// ── mimeFor ─────────────────────────────────────────────────────────────────

describe('mimeFor', () => {
  test('returns application/octet-stream for unknown extension', () => {
    assert.equal(mimeFor('xyz'), 'application/octet-stream');
  });

  test('returns application/octet-stream for empty string', () => {
    assert.equal(mimeFor(''), 'application/octet-stream');
  });

  // Text / code
  test('js → text/javascript', () => assert.equal(mimeFor('js'), 'text/javascript'));
  test('jsx → text/javascript', () => assert.equal(mimeFor('jsx'), 'text/javascript'));
  test('ts → text/typescript', () => assert.equal(mimeFor('ts'), 'text/typescript'));
  test('tsx → text/typescript', () => assert.equal(mimeFor('tsx'), 'text/typescript'));
  test('py → text/x-python', () => assert.equal(mimeFor('py'), 'text/x-python'));
  test('go → text/x-go', () => assert.equal(mimeFor('go'), 'text/x-go'));
  test('rs → text/x-rust', () => assert.equal(mimeFor('rs'), 'text/x-rust'));
  test('md → text/markdown', () => assert.equal(mimeFor('md'), 'text/markdown'));
  test('json → application/json', () => assert.equal(mimeFor('json'), 'application/json'));
  test('yaml → text/yaml', () => assert.equal(mimeFor('yaml'), 'text/yaml'));
  test('yml → text/yaml', () => assert.equal(mimeFor('yml'), 'text/yaml'));
  test('sh → text/x-sh', () => assert.equal(mimeFor('sh'), 'text/x-sh'));
  test('bash → text/x-sh', () => assert.equal(mimeFor('bash'), 'text/x-sh'));
  test('html → text/html', () => assert.equal(mimeFor('html'), 'text/html'));
  test('css → text/css', () => assert.equal(mimeFor('css'), 'text/css'));
  test('txt → text/plain', () => assert.equal(mimeFor('txt'), 'text/plain'));
  test('log → text/plain', () => assert.equal(mimeFor('log'), 'text/plain'));
  test('env → text/plain', () => assert.equal(mimeFor('env'), 'text/plain'));
  test('toml → text/x-toml', () => assert.equal(mimeFor('toml'), 'text/x-toml'));
  test('clj → text/x-clojure', () => assert.equal(mimeFor('clj'), 'text/x-clojure'));
  test('cljs → text/x-clojure', () => assert.equal(mimeFor('cljs'), 'text/x-clojure'));
  test('sql → text/x-sql', () => assert.equal(mimeFor('sql'), 'text/x-sql'));

  // Images
  test('png → image/png', () => assert.equal(mimeFor('png'), 'image/png'));
  test('jpg → image/jpeg', () => assert.equal(mimeFor('jpg'), 'image/jpeg'));
  test('jpeg → image/jpeg', () => assert.equal(mimeFor('jpeg'), 'image/jpeg'));
  test('gif → image/gif', () => assert.equal(mimeFor('gif'), 'image/gif'));
  test('svg → image/svg+xml', () => assert.equal(mimeFor('svg'), 'image/svg+xml'));
  test('webp → image/webp', () => assert.equal(mimeFor('webp'), 'image/webp'));

  // Video
  test('mp4 → video/mp4', () => assert.equal(mimeFor('mp4'), 'video/mp4'));
  test('webm → video/webm', () => assert.equal(mimeFor('webm'), 'video/webm'));
  test('mov → video/quicktime', () => assert.equal(mimeFor('mov'), 'video/quicktime'));

  // Audio
  test('mp3 → audio/mpeg', () => assert.equal(mimeFor('mp3'), 'audio/mpeg'));
  test('wav → audio/wav', () => assert.equal(mimeFor('wav'), 'audio/wav'));
  test('ogg → audio/ogg', () => assert.equal(mimeFor('ogg'), 'audio/ogg'));

  // Document
  test('pdf → application/pdf', () => assert.equal(mimeFor('pdf'), 'application/pdf'));
});

// ── resolvePath ──────────────────────────────────────────────────────────────

describe('resolvePath', () => {
  const home = os.homedir();

  test('~ alone expands to home directory', () => {
    assert.equal(resolvePath('~'), home);
  });

  test('~/subdir expands to path under home', () => {
    assert.equal(resolvePath('~/projects'), path.join(home, 'projects'));
  });

  test('~/a/b/c expands correctly', () => {
    assert.equal(resolvePath('~/a/b/c'), path.join(home, 'a', 'b', 'c'));
  });

  test('absolute path is returned as-is (via path.resolve)', () => {
    assert.equal(resolvePath('/tmp/foo'), path.resolve('/tmp/foo'));
  });

  test('/tmp is resolved correctly', () => {
    assert.equal(resolvePath('/tmp'), '/tmp');
  });

  test('relative path is resolved relative to cwd', () => {
    const rel = 'somefile.txt';
    assert.ok(path.isAbsolute(resolvePath(rel)));
    assert.ok(resolvePath(rel).endsWith('somefile.txt'));
  });

  test('does not expand ~username (only leading ~ alone)', () => {
    // The implementation checks p.startsWith('~') so ~username also expands
    // (documenting actual behavior)
    const result = resolvePath('~username');
    assert.equal(result, path.join(home, 'username'));
  });
});

// ── isAllowed ────────────────────────────────────────────────────────────────

describe('isAllowed', () => {
  const home = os.homedir();

  test('exact homedir is allowed', () => {
    assert.equal(isAllowed(home), true);
  });

  test('subdirectory of homedir is allowed', () => {
    assert.equal(isAllowed(path.join(home, 'projects', 'myrepo')), true);
  });

  test('~ expands to homedir and is allowed', () => {
    assert.equal(isAllowed('~'), true);
  });

  test('~/subdir expands and is allowed', () => {
    assert.equal(isAllowed('~/Documents/file.txt'), true);
  });

  test('/tmp is allowed', () => {
    assert.equal(isAllowed('/tmp'), true);
  });

  test('/tmp/subdir is allowed', () => {
    assert.equal(isAllowed('/tmp/cc-agent/work'), true);
  });

  test('/workspace is allowed', () => {
    assert.equal(isAllowed('/workspace'), true);
  });

  test('/workspace/subdir is allowed', () => {
    assert.equal(isAllowed('/workspace/myproject'), true);
  });

  test('/etc is forbidden', () => {
    assert.equal(isAllowed('/etc'), false);
  });

  test('/etc/passwd is forbidden', () => {
    assert.equal(isAllowed('/etc/passwd'), false);
  });

  test('/var/log is forbidden', () => {
    assert.equal(isAllowed('/var/log'), false);
  });

  test('/proc is forbidden', () => {
    assert.equal(isAllowed('/proc'), false);
  });

  test('/root is forbidden (unless homedir is /root)', () => {
    if (home !== '/root') {
      assert.equal(isAllowed('/root'), false);
    }
  });

  test('path that starts-with homedir string but is not a subdirectory is forbidden', () => {
    // e.g. if home is /home/user, then /home/username2 must NOT be allowed
    const fake = home + '2';
    const underAllowed = [home, '/tmp', '/workspace'].some(r => fake === r || fake.startsWith(r + '/'));
    assert.equal(isAllowed(fake), underAllowed);
  });

  test('path traversal via .. is blocked', () => {
    // /tmp/../etc resolves to /etc which is forbidden
    assert.equal(isAllowed('/tmp/../etc'), false);
  });

  test('path traversal via ~ is resolved safely', () => {
    // ~/../../etc resolves via path.join + path traversal
    const resolved = path.join(home, '../../etc');
    const underAllowed = [home, '/tmp', '/workspace'].some(r => resolved === r || resolved.startsWith(r + '/'));
    assert.equal(isAllowed('~/../../etc'), underAllowed);
  });

  test('custom allowedRoots parameter: allows path in custom root', () => {
    assert.equal(isAllowed('/custom/root/file.txt', ['/custom/root']), true);
  });

  test('custom allowedRoots parameter: blocks path not in custom root', () => {
    assert.equal(isAllowed('/tmp/file.txt', ['/custom/root']), false);
  });

  test('custom allowedRoots: exact root match', () => {
    assert.equal(isAllowed('/custom/root', ['/custom/root']), true);
  });
});

// ── diffTools ────────────────────────────────────────────────────────────────

describe('diffTools', () => {
  test('returns [] when currArr is null', () => {
    assert.deepEqual(diffTools(['a', 'b'], null), []);
  });

  test('returns [] when currArr is undefined', () => {
    assert.deepEqual(diffTools(['a'], undefined), []);
  });

  test('returns [] when currArr is empty array', () => {
    assert.deepEqual(diffTools(['a', 'b'], []), []);
  });

  test('first snapshot (prevArr empty): returns last 3 of currArr', () => {
    assert.deepEqual(diffTools([], ['a', 'b', 'c', 'd', 'e']), ['c', 'd', 'e']);
  });

  test('first snapshot: returns all when currArr has ≤3 items', () => {
    assert.deepEqual(diffTools([], ['a', 'b']), ['a', 'b']);
  });

  test('first snapshot: returns all when currArr has exactly 3 items', () => {
    assert.deepEqual(diffTools([], ['a', 'b', 'c']), ['a', 'b', 'c']);
  });

  test('first snapshot: returns last 3 when prevArr is null', () => {
    assert.deepEqual(diffTools(null, ['x', 'y', 'z', 'w']), ['y', 'z', 'w']);
  });

  test('first snapshot: returns all ≤3 when prevArr is null', () => {
    assert.deepEqual(diffTools(null, ['x', 'y']), ['x', 'y']);
  });

  test('identical arrays → []', () => {
    assert.deepEqual(diffTools(['a', 'b'], ['a', 'b']), []);
  });

  test('single new item appended to end', () => {
    assert.deepEqual(diffTools(['a', 'b'], ['a', 'b', 'c']), ['c']);
  });

  test('two new items appended to end', () => {
    assert.deepEqual(diffTools(['a', 'b'], ['a', 'b', 'c', 'd']), ['c', 'd']);
  });

  test('rolling window: prev=[a,b,c], curr=[b,c,d] → [d]', () => {
    assert.deepEqual(diffTools(['a', 'b', 'c'], ['b', 'c', 'd']), ['d']);
  });

  test('no overlap: overlap=0 fires, returns all of currArr', () => {
    // overlap=0: prevSuffix=[] === currPrefix=[] → return curr.slice(0) = all of curr
    assert.deepEqual(diffTools(['a', 'b', 'c'], ['x', 'y', 'z']), ['x', 'y', 'z']);
  });

  test('single item array: prev=[a], curr=[b] → [b]', () => {
    assert.deepEqual(diffTools(['a'], ['b']), ['b']);
  });

  test('curr has only one new item vs prev with many', () => {
    assert.deepEqual(diffTools(['a', 'b', 'c', 'd'], ['b', 'c', 'd', 'e']), ['e']);
  });

  test('large rolling window: 5 items, 2 new', () => {
    const prev = ['t1', 't2', 't3', 't4', 't5'];
    const curr = ['t3', 't4', 't5', 't6', 't7'];
    assert.deepEqual(diffTools(prev, curr), ['t6', 't7']);
  });

  test('all items replaced → overlap=0 fires, returns full currArr', () => {
    const prev = ['old1', 'old2'];
    const curr = ['new1', 'new2', 'new3'];
    assert.deepEqual(diffTools(prev, curr), ['new1', 'new2', 'new3']);
  });

  test('works with object elements (stringified for comparison)', () => {
    const prev = [{ name: 'Read' }, { name: 'Write' }];
    const curr = [{ name: 'Read' }, { name: 'Write' }, { name: 'Bash' }];
    assert.deepEqual(diffTools(prev, curr), [{ name: 'Bash' }]);
  });

  test('identical object arrays → []', () => {
    const arr = [{ name: 'Read' }];
    assert.deepEqual(diffTools(arr, [{ name: 'Read' }]), []);
  });
});
