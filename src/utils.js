/**
 * Pure utility functions extracted from server.js.
 * No I/O, no Redis, no side effects — safe to import in tests.
 */

import path from 'path';
import os from 'os';

// ── MIME type mapping ──────────────────────────────────────────────────────

/** Return MIME type for a given file extension (without leading dot). */
export function mimeFor(ext) {
  const map = {
    js:'text/javascript', ts:'text/typescript', tsx:'text/typescript',
    jsx:'text/javascript', py:'text/x-python', go:'text/x-go',
    rs:'text/x-rust', md:'text/markdown', json:'application/json',
    yaml:'text/yaml', yml:'text/yaml', sh:'text/x-sh', bash:'text/x-sh',
    html:'text/html', css:'text/css', txt:'text/plain',
    png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif',
    svg:'image/svg+xml', webp:'image/webp',
    mp4:'video/mp4', webm:'video/webm', mov:'video/quicktime',
    mp3:'audio/mpeg', wav:'audio/wav', ogg:'audio/ogg',
    pdf:'application/pdf',
    clj:'text/x-clojure', cljs:'text/x-clojure', sql:'text/x-sql',
    log:'text/plain', env:'text/plain', toml:'text/x-toml',
  };
  return map[ext] || 'application/octet-stream';
}

// ── Path security helpers ──────────────────────────────────────────────────

/** Allowed roots for file browsing — homedir, /tmp, /workspace */
export const ALLOWED_ROOTS = [os.homedir(), '/tmp', '/workspace'];

/**
 * Return true if path `p` is within an allowed root.
 * Supports `~` expansion.
 */
export function isAllowed(p) {
  const resolved = p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : path.resolve(p);
  return ALLOWED_ROOTS.some(root => resolved === root || resolved.startsWith(root + '/'));
}

/** Resolve a path, expanding leading `~` to homedir. */
export function resolvePath(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : path.resolve(p);
}

// ── JSON parsing helper ────────────────────────────────────────────────────

/** Parse a job JSON string from Redis; returns null on failure or missing input. */
export function parseJob(raw) {
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

// ── Tool call diff helper ──────────────────────────────────────────────────

/**
 * Compute new tool call entries that appeared at the tail of `currArr`
 * relative to `prevArr`.
 *
 * Strategy: find the longest overlap between the suffix of prevArr and the
 * prefix of currArr; everything after that overlap is genuinely new.
 * Falls back to last 3 elements of currArr when no overlap can be found.
 */
export function diffTools(prevArr, currArr) {
  if (!currArr?.length) return [];
  if (!prevArr?.length) return currArr.slice(-3); // first snapshot: emit up to 3
  if (JSON.stringify(prevArr) === JSON.stringify(currArr)) return [];
  for (let overlap = Math.min(prevArr.length, currArr.length); overlap >= 0; overlap--) {
    const prevSuffix = prevArr.slice(prevArr.length - overlap);
    const currPrefix = currArr.slice(0, overlap);
    if (JSON.stringify(prevSuffix) === JSON.stringify(currPrefix)) {
      return currArr.slice(overlap); // these are genuinely new
    }
  }
  return currArr.slice(-Math.min(3, currArr.length)); // fallback: last 3
}
