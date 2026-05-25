/**
 * Tests for lib/fs-handlers.js — HTTP file-system route handlers.
 * Uses real temp-directory I/O and mock req/res objects; no Redis needed.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { handleBrowse, handleFsStat, handleFsLs, handleFsCat, handleFsRaw } from '../lib/fs-handlers.js';

// ─── Test fixture setup ───────────────────────────────────────────────────

/** Temporary directory used across all tests in this file */
let tmpDir;

before(() => {
  // Use /tmp directly — os.tmpdir() on macOS returns /var/folders/... which
  // is outside ALLOWED_ROOTS (/tmp, /workspace, homedir).
  tmpDir = fs.mkdtempSync('/tmp/cc-agent-ui-test-');
  // Create a small directory tree for tests:
  //   tmpDir/
  //     subdir/
  //     file.txt      (content: "hello world")
  //     script.js     (content: "console.log(1)")
  //     large.bin     (>1MB, for cat size limit test)
  fs.mkdirSync(path.join(tmpDir, 'subdir'));
  fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'hello world');
  fs.writeFileSync(path.join(tmpDir, 'script.js'), 'console.log(1)');
  // 1 MB + 1 byte
  fs.writeFileSync(path.join(tmpDir, 'large.bin'), Buffer.alloc(1048577, 0x41));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Mock req/res helpers ─────────────────────────────────────────────────

function makeReq(pathname, params = {}) {
  const qs = new URLSearchParams(params).toString();
  return { url: pathname + (qs ? '?' + qs : ''), method: 'GET' };
}

function makeRes() {
  const chunks = [];
  const res = {
    statusCode: null,
    headers: {},
    body: '',
    writeHead(code, hdrs) { this.statusCode = code; Object.assign(this.headers, hdrs || {}); },
    end(data) {
      if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
      this.body = Buffer.concat(chunks).toString();
    },
    write(data) { chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data)); },
    // Required by Node.js stream.pipe(dest): dest must look like a writable stream
    on() { return this; },
    once() { return this; },
    emit() { return false; },
    removeListener() { return this; },
  };
  return res;
}

// Helper: run a handler and capture the response
function run(handler, pathname, params = {}) {
  const req = makeReq(pathname, params);
  const res = makeRes();
  handler(req, res);
  return res;
}

// ─── handleBrowse ─────────────────────────────────────────────────────────

describe('handleBrowse', () => {
  it('returns 400 when path param is missing', () => {
    const res = run(handleBrowse, '/api/browse');
    assert.equal(res.statusCode, 400);
    assert.ok(res.body.includes('missing path'));
  });

  it('returns 403 for a path outside allowed roots', () => {
    const res = run(handleBrowse, '/api/browse', { path: '/etc/passwd' });
    assert.equal(res.statusCode, 403);
    assert.ok(res.body.includes('forbidden'));
  });

  it('returns 404 for a path that does not exist', () => {
    const res = run(handleBrowse, '/api/browse', { path: path.join(tmpDir, 'does-not-exist') });
    assert.equal(res.statusCode, 404);
  });

  it('returns 200 JSON for a directory', () => {
    const res = run(handleBrowse, '/api/browse', { path: tmpDir });
    assert.equal(res.statusCode, 200);
    assert.ok(res.headers['Content-Type'].includes('application/json'));
    const data = JSON.parse(res.body);
    assert.equal(data.type, 'dir');
    assert.ok(Array.isArray(data.entries));
    const names = data.entries.map(e => e.name);
    assert.ok(names.includes('file.txt'));
    assert.ok(names.includes('subdir'));
  });

  it('lists directories before files in directory response', () => {
    const res = run(handleBrowse, '/api/browse', { path: tmpDir });
    const data = JSON.parse(res.body);
    const types = data.entries.map(e => e.type);
    const firstFileIdx = types.indexOf('file');
    const lastDirIdx = types.lastIndexOf('dir');
    if (firstFileIdx !== -1 && lastDirIdx !== -1) {
      assert.ok(lastDirIdx < firstFileIdx, 'dirs should come before files');
    }
  });

  // Note: streaming tests (file MIME type) are not included here because
  // fs.createReadStream() in Node 22's test runner tracks the async file-open
  // operation even when pipe()'s result is discarded, causing node:test to
  // flag "async activity after test ended".  mimeFor() is exhaustively tested
  // in test/utils.test.js; the important invariants (403/400/dir listing) are
  // fully covered above.
});

// ─── handleFsStat ─────────────────────────────────────────────────────────

describe('handleFsStat', () => {
  it('returns 400 when path param is missing', () => {
    const res = run(handleFsStat, '/api/fs/stat');
    assert.equal(res.statusCode, 400);
  });

  it('returns 403 for a forbidden path', () => {
    const res = run(handleFsStat, '/api/fs/stat', { path: '/etc/hosts' });
    assert.equal(res.statusCode, 403);
  });

  it('returns { exists: true, type: "dir" } for a directory', () => {
    const res = run(handleFsStat, '/api/fs/stat', { path: tmpDir });
    assert.equal(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.exists, true);
    assert.equal(data.type, 'dir');
  });

  it('returns { exists: true, type: "file" } for a file', () => {
    const res = run(handleFsStat, '/api/fs/stat', { path: path.join(tmpDir, 'file.txt') });
    assert.equal(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.exists, true);
    assert.equal(data.type, 'file');
    assert.ok(typeof data.size === 'number' && data.size > 0);
  });

  it('returns { exists: false } for a path that does not exist', () => {
    const res = run(handleFsStat, '/api/fs/stat', { path: path.join(tmpDir, 'ghost.txt') });
    assert.equal(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.exists, false);
  });
});

// ─── handleFsLs ──────────────────────────────────────────────────────────

describe('handleFsLs', () => {
  it('returns 400 when path param is missing', () => {
    const res = run(handleFsLs, '/api/fs/ls');
    assert.equal(res.statusCode, 400);
  });

  it('returns 403 for a forbidden path', () => {
    const res = run(handleFsLs, '/api/fs/ls', { path: '/root' });
    assert.equal(res.statusCode, 403);
  });

  it('returns 404 for a non-existent directory', () => {
    const res = run(handleFsLs, '/api/fs/ls', { path: path.join(tmpDir, 'no-such-dir') });
    assert.equal(res.statusCode, 404);
  });

  it('returns entries with name/type/size/ext fields', () => {
    const res = run(handleFsLs, '/api/fs/ls', { path: tmpDir });
    assert.equal(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.ok(Array.isArray(data.entries));
    const txtEntry = data.entries.find(e => e.name === 'file.txt');
    assert.ok(txtEntry);
    assert.equal(txtEntry.type, 'file');
    assert.equal(txtEntry.ext, 'txt');
    assert.ok(txtEntry.size > 0);
  });

  it('sets null size for directories', () => {
    const res = run(handleFsLs, '/api/fs/ls', { path: tmpDir });
    const data = JSON.parse(res.body);
    const dirEntry = data.entries.find(e => e.name === 'subdir');
    assert.ok(dirEntry);
    assert.equal(dirEntry.size, null);
  });

  it('sorts directories before files', () => {
    const res = run(handleFsLs, '/api/fs/ls', { path: tmpDir });
    const data = JSON.parse(res.body);
    const types = data.entries.map(e => e.type);
    const firstFileIdx = types.indexOf('file');
    const lastDirIdx = types.lastIndexOf('dir');
    if (firstFileIdx !== -1 && lastDirIdx !== -1) {
      assert.ok(lastDirIdx < firstFileIdx);
    }
  });
});

// ─── handleFsCat ──────────────────────────────────────────────────────────

describe('handleFsCat', () => {
  it('returns 400 when path param is missing', () => {
    const res = run(handleFsCat, '/api/fs/cat');
    assert.equal(res.statusCode, 400);
  });

  it('returns 403 for a forbidden path', () => {
    const res = run(handleFsCat, '/api/fs/cat', { path: '/etc/passwd' });
    assert.equal(res.statusCode, 403);
  });

  it('returns 404 for a non-existent file', () => {
    const res = run(handleFsCat, '/api/fs/cat', { path: path.join(tmpDir, 'missing.txt') });
    assert.equal(res.statusCode, 404);
  });

  it('returns 400 for a file larger than 1 MB', () => {
    const res = run(handleFsCat, '/api/fs/cat', { path: path.join(tmpDir, 'large.bin') });
    assert.equal(res.statusCode, 400);
    assert.ok(res.body.includes('too large'));
  });

  it('returns file content as JSON for a small file', () => {
    const res = run(handleFsCat, '/api/fs/cat', { path: path.join(tmpDir, 'file.txt') });
    assert.equal(res.statusCode, 200);
    assert.ok(res.headers['Content-Type'].includes('application/json'));
    const data = JSON.parse(res.body);
    assert.equal(data.content, 'hello world');
  });

  it('returns 400 for a directory (stat succeeds but read fails — size == 0 on macOS dirs? no, stat.size on dirs is nonzero but readFileSync throws)', () => {
    // On most systems statSync on a directory succeeds; readFileSync on a dir throws EISDIR
    const res = run(handleFsCat, '/api/fs/cat', { path: tmpDir });
    // Either 404 (caught exception) or 400 (if dir size > 1MB, unlikely) — must not be 200
    assert.notEqual(res.statusCode, 200);
  });
});

// ─── handleFsRaw ──────────────────────────────────────────────────────────

describe('handleFsRaw', () => {
  it('returns 400 when path param is missing', () => {
    const res = run(handleFsRaw, '/api/fs/raw');
    assert.equal(res.statusCode, 400);
  });

  it('returns 403 for a forbidden path', () => {
    const res = run(handleFsRaw, '/api/fs/raw', { path: '/etc/passwd' });
    assert.equal(res.statusCode, 403);
  });

  // Note: handleFsRaw calls writeHead(200, {Content-Type}) THEN creates a
  // ReadStream.  The headers are verifiable (writeHead is synchronous), but
  // fs.createReadStream() schedules an async file-open that node:test tracks
  // as "async activity after test ended" — even when the stream's result is
  // discarded.  MIME-type mapping is exhaustively tested in test/utils.test.js
  // (mimeFor); the security invariants are covered by the path-traversal suite.
  // Streaming tests would require an integration harness with a real HTTP server.
});

// ─── path traversal / security edge cases ────────────────────────────────

describe('path traversal security', () => {
  const handlers = [
    ['handleBrowse', handleBrowse, '/api/browse'],
    ['handleFsStat', handleFsStat, '/api/fs/stat'],
    ['handleFsLs',   handleFsLs,   '/api/fs/ls'],
    ['handleFsCat',  handleFsCat,  '/api/fs/cat'],
    ['handleFsRaw',  handleFsRaw,  '/api/fs/raw'],
  ];

  const attackPaths = [
    '/etc/passwd',
    '/etc/shadow',
    '/root/.ssh/id_rsa',
    '/proc/1/environ',
    '/tmp/../etc/passwd',
    '/tmp/foo/../../etc/passwd',
    '/workspace/../etc/passwd',
    '/tmp_evil',
    '/workspace_secret',
  ];

  for (const [handlerName, handler, pathname] of handlers) {
    for (const attackPath of attackPaths) {
      it(`${handlerName} blocks ${attackPath}`, () => {
        const res = run(handler, pathname, { path: attackPath });
        // Must be 403 (forbidden) — never 200
        assert.equal(res.statusCode, 403, `Expected 403 for path "${attackPath}" but got ${res.statusCode}`);
      });
    }
  }
});
