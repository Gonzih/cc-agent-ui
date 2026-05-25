/**
 * Pure utility functions extracted from server.js for testability.
 */
import path from 'path';
import os from 'os';

export const ALLOWED_ROOTS = [os.homedir(), '/tmp', '/workspace'];

/** Parse a job JSON string from Redis, return null on failure */
export function parseJob(raw) {
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

/** Map a file extension to a MIME type */
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

/** Resolve a path, expanding leading ~ to the home directory */
export function resolvePath(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : path.resolve(p);
}

/** Return true iff the resolved path is under one of the allowed roots */
export function isAllowed(p, allowedRoots = ALLOWED_ROOTS) {
  const resolved = resolvePath(p);
  return allowedRoots.some(root => resolved === root || resolved.startsWith(root + '/'));
}

/**
 * Given prev and curr recentTools arrays, return only the genuinely new
 * tool-call entries that appeared at the tail of currArr since prevArr.
 * Finds the longest tail-overlap between prevArr and currArr head, returns the suffix.
 */
export function diffTools(prevArr, currArr) {
  if (!currArr?.length) return [];
  if (!prevArr?.length) return currArr.slice(-3); // first snapshot: emit up to 3
  if (JSON.stringify(prevArr) === JSON.stringify(currArr)) return [];
  // Find how many NEW items appeared at the tail of currArr relative to prevArr.
  // Strategy: find the longest suffix of prevArr that matches a prefix of the new tail.
  for (let overlap = Math.min(prevArr.length, currArr.length); overlap >= 0; overlap--) {
    const prevSuffix = prevArr.slice(prevArr.length - overlap);
    const currPrefix = currArr.slice(0, overlap);
    if (JSON.stringify(prevSuffix) === JSON.stringify(currPrefix)) {
      return currArr.slice(overlap); // these are genuinely new
    }
  }
  /* c8 ignore next -- overlap=0 always matches ([]===[]); this line is unreachable */
  return currArr.slice(-Math.min(3, currArr.length)); // fallback: last 3
}
