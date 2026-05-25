import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { parseJob, mimeFor, isAllowed, resolvePath } from '../lib/utils.js';

// ── parseJob ─────────────────────────────────────────────────────────────────

test('parseJob returns null for null input', () => {
  assert.equal(parseJob(null), null);
});

test('parseJob returns null for empty string', () => {
  assert.equal(parseJob(''), null);
});

test('parseJob returns null for invalid JSON', () => {
  assert.equal(parseJob('not-json'), null);
});

test('parseJob returns null for malformed JSON', () => {
  assert.equal(parseJob('{broken}'), null);
});

test('parseJob parses a valid job object', () => {
  const job = { id: 'abc', status: 'running' };
  assert.deepEqual(parseJob(JSON.stringify(job)), job);
});

test('parseJob parses a JSON number', () => {
  assert.equal(parseJob('42'), 42);
});

// ── mimeFor ──────────────────────────────────────────────────────────────────

test('mimeFor: js → text/javascript', () => {
  assert.equal(mimeFor('js'), 'text/javascript');
});

test('mimeFor: ts → text/typescript', () => {
  assert.equal(mimeFor('ts'), 'text/typescript');
});

test('mimeFor: tsx → text/typescript', () => {
  assert.equal(mimeFor('tsx'), 'text/typescript');
});

test('mimeFor: json → application/json', () => {
  assert.equal(mimeFor('json'), 'application/json');
});

test('mimeFor: md → text/markdown', () => {
  assert.equal(mimeFor('md'), 'text/markdown');
});

test('mimeFor: png → image/png', () => {
  assert.equal(mimeFor('png'), 'image/png');
});

test('mimeFor: pdf → application/pdf', () => {
  assert.equal(mimeFor('pdf'), 'application/pdf');
});

test('mimeFor: mp4 → video/mp4', () => {
  assert.equal(mimeFor('mp4'), 'video/mp4');
});

test('mimeFor: unknown extension → application/octet-stream', () => {
  assert.equal(mimeFor('xyz'), 'application/octet-stream');
});

test('mimeFor: empty string → application/octet-stream', () => {
  assert.equal(mimeFor(''), 'application/octet-stream');
});

// ── resolvePath ───────────────────────────────────────────────────────────────

test('resolvePath expands leading ~', () => {
  const home = os.homedir();
  assert.equal(resolvePath('~/foo/bar'), path.join(home, 'foo/bar'));
});

test('resolvePath handles bare ~', () => {
  assert.equal(resolvePath('~'), os.homedir());
});

test('resolvePath resolves absolute paths unchanged', () => {
  assert.equal(resolvePath('/tmp/x'), '/tmp/x');
});

test('resolvePath resolves relative paths against cwd', () => {
  const result = resolvePath('some/relative/path');
  assert.ok(path.isAbsolute(result));
  assert.ok(result.endsWith('some/relative/path'));
});

// ── isAllowed ─────────────────────────────────────────────────────────────────

const roots = [os.homedir(), '/tmp', '/workspace'];

test('isAllowed: path inside /tmp is allowed', () => {
  assert.ok(isAllowed('/tmp/somefile', roots));
});

test('isAllowed: /tmp itself is allowed', () => {
  assert.ok(isAllowed('/tmp', roots));
});

test('isAllowed: path inside home dir is allowed', () => {
  assert.ok(isAllowed(path.join(os.homedir(), 'projects/foo'), roots));
});

test('isAllowed: tilde path inside home dir is allowed', () => {
  assert.ok(isAllowed('~/projects/bar', roots));
});

test('isAllowed: /etc/passwd is NOT allowed', () => {
  assert.ok(!isAllowed('/etc/passwd', roots));
});

test('isAllowed: /proc is NOT allowed', () => {
  assert.ok(!isAllowed('/proc', roots));
});

test('isAllowed: path trying to escape via .. is blocked', () => {
  // path.resolve collapses ../ so /tmp/../etc/passwd → /etc/passwd
  assert.ok(!isAllowed('/tmp/../etc/passwd', roots));
});
