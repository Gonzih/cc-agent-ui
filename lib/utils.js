/**
 * Pure utility functions — no I/O, no Redis, fully unit-testable.
 */
import path from 'path';
import os from 'os';

/**
 * Parse a job JSON string from Redis.  Returns null on any failure:
 * null/undefined/empty input, or invalid JSON.
 */
export function parseJob(raw) {
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

/** Extension → MIME type mapping */
export function mimeFor(ext) {
  const map = {
    js: 'text/javascript', ts: 'text/typescript', tsx: 'text/typescript',
    jsx: 'text/javascript', py: 'text/x-python', go: 'text/x-go',
    rs: 'text/x-rust', md: 'text/markdown', json: 'application/json',
    yaml: 'text/yaml', yml: 'text/yaml', sh: 'text/x-sh', bash: 'text/x-sh',
    html: 'text/html', css: 'text/css', txt: 'text/plain',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    svg: 'image/svg+xml', webp: 'image/webp',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
    pdf: 'application/pdf',
    clj: 'text/x-clojure', cljs: 'text/x-clojure', sql: 'text/x-sql',
    log: 'text/plain', env: 'text/plain', toml: 'text/x-toml',
  };
  return map[ext] || 'application/octet-stream';
}

/** Security: only allow paths under these roots */
export const ALLOWED_ROOTS = [os.homedir(), '/tmp', '/workspace'];

/**
 * Return true iff the resolved path is under one of the allowed roots.
 * Handles ~ prefix and path traversal attempts.
 */
export function isAllowed(p) {
  const resolved = p.startsWith('~')
    ? path.join(os.homedir(), p.slice(1))
    : path.resolve(p);
  return ALLOWED_ROOTS.some(root => resolved === root || resolved.startsWith(root + '/'));
}

/** Resolve a path, expanding ~ to the user's home directory. */
export function resolvePath(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : path.resolve(p);
}

/**
 * Diff two recentTools arrays.  Returns only the items that are genuinely
 * new at the tail of currArr compared to prevArr.
 *
 * Rules:
 *  - null/empty currArr → []
 *  - null/empty prevArr → up to last 3 of currArr  (first-snapshot heuristic)
 *  - identical arrays  → []
 *  - otherwise: find the longest suffix of prevArr that matches a prefix of
 *    currArr's tail; new items are everything after that overlap.
 *  - fallback (completely different arrays): last min(3, currArr.length) items
 */
export function diffTools(prevArr, currArr) {
  if (!currArr?.length) return [];
  if (!prevArr?.length) return currArr.slice(-3);
  if (JSON.stringify(prevArr) === JSON.stringify(currArr)) return [];
  for (let overlap = Math.min(prevArr.length, currArr.length); overlap >= 0; overlap--) {
    const prevSuffix = prevArr.slice(prevArr.length - overlap);
    const currPrefix = currArr.slice(0, overlap);
    if (JSON.stringify(prevSuffix) === JSON.stringify(currPrefix)) {
      return currArr.slice(overlap);
    }
  }
  return currArr.slice(-Math.min(3, currArr.length));
}
