import { describe, it, expect } from 'vitest';
import os from 'os';
import path from 'path';
import { mimeFor, isAllowed, resolvePath, parseJob, diffTools, ALLOWED_ROOTS } from '../lib/utils.js';

// ── mimeFor ────────────────────────────────────────────────────────────────

describe('mimeFor', () => {
  it('returns correct MIME for known text extensions', () => {
    expect(mimeFor('js')).toBe('text/javascript');
    expect(mimeFor('ts')).toBe('text/typescript');
    expect(mimeFor('tsx')).toBe('text/typescript');
    expect(mimeFor('jsx')).toBe('text/javascript');
    expect(mimeFor('py')).toBe('text/x-python');
    expect(mimeFor('go')).toBe('text/x-go');
    expect(mimeFor('rs')).toBe('text/x-rust');
    expect(mimeFor('md')).toBe('text/markdown');
    expect(mimeFor('json')).toBe('application/json');
    expect(mimeFor('yaml')).toBe('text/yaml');
    expect(mimeFor('yml')).toBe('text/yaml');
    expect(mimeFor('sh')).toBe('text/x-sh');
    expect(mimeFor('bash')).toBe('text/x-sh');
    expect(mimeFor('html')).toBe('text/html');
    expect(mimeFor('css')).toBe('text/css');
    expect(mimeFor('txt')).toBe('text/plain');
  });

  it('returns correct MIME for image extensions', () => {
    expect(mimeFor('png')).toBe('image/png');
    expect(mimeFor('jpg')).toBe('image/jpeg');
    expect(mimeFor('jpeg')).toBe('image/jpeg');
    expect(mimeFor('gif')).toBe('image/gif');
    expect(mimeFor('svg')).toBe('image/svg+xml');
    expect(mimeFor('webp')).toBe('image/webp');
  });

  it('returns correct MIME for video extensions', () => {
    expect(mimeFor('mp4')).toBe('video/mp4');
    expect(mimeFor('webm')).toBe('video/webm');
    expect(mimeFor('mov')).toBe('video/quicktime');
  });

  it('returns correct MIME for audio extensions', () => {
    expect(mimeFor('mp3')).toBe('audio/mpeg');
    expect(mimeFor('wav')).toBe('audio/wav');
    expect(mimeFor('ogg')).toBe('audio/ogg');
  });

  it('returns correct MIME for document/data extensions', () => {
    expect(mimeFor('pdf')).toBe('application/pdf');
    expect(mimeFor('clj')).toBe('text/x-clojure');
    expect(mimeFor('cljs')).toBe('text/x-clojure');
    expect(mimeFor('sql')).toBe('text/x-sql');
    expect(mimeFor('log')).toBe('text/plain');
    expect(mimeFor('env')).toBe('text/plain');
    expect(mimeFor('toml')).toBe('text/x-toml');
  });

  it('returns application/octet-stream for unknown extension', () => {
    expect(mimeFor('xyz')).toBe('application/octet-stream');
    expect(mimeFor('')).toBe('application/octet-stream');
    expect(mimeFor('unknown')).toBe('application/octet-stream');
  });
});

// ── isAllowed ──────────────────────────────────────────────────────────────

describe('isAllowed', () => {
  const home = os.homedir();

  it('allows paths inside homedir', () => {
    expect(isAllowed(home)).toBe(true);
    expect(isAllowed(path.join(home, 'Documents'))).toBe(true);
    expect(isAllowed(path.join(home, 'Documents', 'file.txt'))).toBe(true);
  });

  it('allows paths inside /tmp', () => {
    expect(isAllowed('/tmp')).toBe(true);
    expect(isAllowed('/tmp/somefile.txt')).toBe(true);
    expect(isAllowed('/tmp/nested/dir')).toBe(true);
  });

  it('allows paths inside /workspace', () => {
    expect(isAllowed('/workspace')).toBe(true);
    expect(isAllowed('/workspace/project/src')).toBe(true);
  });

  it('allows ~ (tilde) paths under homedir', () => {
    expect(isAllowed('~')).toBe(true);
    expect(isAllowed('~/Documents')).toBe(true);
    expect(isAllowed('~/some/nested/path')).toBe(true);
  });

  it('rejects paths outside allowed roots', () => {
    expect(isAllowed('/etc/passwd')).toBe(false);
    expect(isAllowed('/var/log')).toBe(false);
    expect(isAllowed('/usr/bin/env')).toBe(false);
    expect(isAllowed('/root')).toBe(false);
  });

  it('rejects path traversal attempts', () => {
    // Absolute resolution of /tmp/../etc/passwd → /etc/passwd — not allowed
    expect(isAllowed('/tmp/../etc/passwd')).toBe(false);
  });

  it('rejects path that is a PREFIX but not a child of an allowed root', () => {
    // e.g. if homedir is /Users/alice, /Users/alice2 should be rejected
    const homedir = os.homedir();
    const sibling = homedir + '2'; // e.g. /Users/feral2
    // Only test if the sibling wouldn't accidentally be inside an allowed root
    if (!ALLOWED_ROOTS.some(r => sibling === r || sibling.startsWith(r + '/'))) {
      expect(isAllowed(sibling)).toBe(false);
    }
  });
});

// ── resolvePath ────────────────────────────────────────────────────────────

describe('resolvePath', () => {
  const home = os.homedir();

  it('expands ~ to homedir', () => {
    expect(resolvePath('~')).toBe(home);
  });

  it('expands ~/foo to homedir/foo', () => {
    expect(resolvePath('~/foo')).toBe(path.join(home, 'foo'));
  });

  it('expands ~/a/b/c correctly', () => {
    expect(resolvePath('~/a/b/c')).toBe(path.join(home, 'a', 'b', 'c'));
  });

  it('returns path.resolve for absolute paths (no tilde)', () => {
    expect(resolvePath('/tmp/test')).toBe('/tmp/test');
    expect(resolvePath('/workspace')).toBe('/workspace');
  });

  it('resolves relative paths using path.resolve', () => {
    // path.resolve('.') returns process.cwd()
    const result = resolvePath('.');
    expect(path.isAbsolute(result)).toBe(true);
  });
});

// ── parseJob ───────────────────────────────────────────────────────────────

describe('parseJob', () => {
  it('parses valid JSON job string', () => {
    const job = { id: 'abc123', status: 'running' };
    expect(parseJob(JSON.stringify(job))).toEqual(job);
  });

  it('returns null for null input', () => {
    expect(parseJob(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(parseJob(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseJob('')).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(parseJob('not json')).toBeNull();
    expect(parseJob('{broken json')).toBeNull();
    expect(parseJob('{"unclosed":')).toBeNull();
  });

  it('parses complex job object', () => {
    const job = {
      id: 'uuid-here',
      status: 'done',
      startedAt: '2024-01-01T00:00:00Z',
      recentTools: ['Read', 'Edit'],
      agentDriver: 'claude',
    };
    expect(parseJob(JSON.stringify(job))).toEqual(job);
  });
});

// ── diffTools ──────────────────────────────────────────────────────────────

describe('diffTools', () => {
  it('returns [] when currArr is empty', () => {
    expect(diffTools(['a', 'b'], [])).toEqual([]);
  });

  it('returns [] when currArr is null/undefined', () => {
    expect(diffTools(['a'], null)).toEqual([]);
    expect(diffTools(['a'], undefined)).toEqual([]);
  });

  it('returns up to last 3 items when prevArr is empty (first snapshot)', () => {
    expect(diffTools([], ['a', 'b', 'c', 'd'])).toEqual(['b', 'c', 'd']);
    expect(diffTools([], ['a', 'b'])).toEqual(['a', 'b']);
    expect(diffTools([], ['x'])).toEqual(['x']);
  });

  it('returns up to last 3 items when prevArr is null (first snapshot)', () => {
    expect(diffTools(null, ['a', 'b', 'c', 'd'])).toEqual(['b', 'c', 'd']);
  });

  it('returns [] when arrays are identical', () => {
    expect(diffTools(['a', 'b'], ['a', 'b'])).toEqual([]);
  });

  it('detects single new item appended', () => {
    expect(diffTools(['a', 'b'], ['a', 'b', 'c'])).toEqual(['c']);
  });

  it('detects multiple new items appended', () => {
    expect(diffTools(['a', 'b'], ['a', 'b', 'c', 'd'])).toEqual(['c', 'd']);
  });

  it('handles window sliding — old items dropped, new ones added', () => {
    // prevArr = [a, b, c], currArr = [b, c, d] — 'd' is new
    expect(diffTools(['a', 'b', 'c'], ['b', 'c', 'd'])).toEqual(['d']);
  });

  it('returns all of currArr when no overlap found (overlap=0 always matches)', () => {
    // When prevArr and currArr share no elements, the loop reaches overlap=0:
    // prevSuffix=[] and currPrefix=[] are always equal → returns currArr.slice(0) = all items.
    // The final fallback line (currArr.slice(-3)) is unreachable dead code.
    expect(diffTools(['x', 'y'], ['a', 'b', 'c', 'd'])).toEqual(['a', 'b', 'c', 'd']);
  });

  it('handles single element arrays', () => {
    expect(diffTools(['a'], ['a', 'b'])).toEqual(['b']);
    expect(diffTools(['a'], ['b'])).toEqual(['b']); // no overlap, fallback last 1
  });

  it('handles overlap = 0 case (new entries completely replace old)', () => {
    // overlap=0 means currArr.slice(0) = all of currArr
    // This happens when prevArr = []
    expect(diffTools([], ['a'])).toEqual(['a']);
  });
});
