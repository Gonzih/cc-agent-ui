import path from 'path';
import os from 'os';

/** Parse a job JSON string from Redis, return null on failure */
export function parseJob(raw) {
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

/** Map file extension to MIME type */
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

// Security: only allow paths under approved roots
export const ALLOWED_ROOTS = [os.homedir(), '/tmp', '/workspace'];

export function isAllowed(p) {
  const resolved = p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : path.resolve(p);
  return ALLOWED_ROOTS.some(root => resolved === root || resolved.startsWith(root + '/'));
}

export function resolvePath(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : path.resolve(p);
}

/**
 * Detect genuinely new tool calls by comparing tail-overlap of arrays.
 * When prevArr is empty/null this is the first snapshot — return up to last 3.
 * Otherwise find the longest suffix of prevArr matching a prefix of currArr and
 * return whatever comes after that overlap (the truly new items).
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
  return currArr.slice(-Math.min(3, currArr.length)); // fallback: last 3
}
