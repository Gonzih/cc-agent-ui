/**
 * File-system HTTP route handlers, extracted for testability.
 * Each handler takes (req, res) with no Redis dependency.
 * Uses isAllowed / resolvePath / mimeFor from utils.
 */
import fs from 'fs';
import path from 'path';
import { isAllowed, resolvePath, mimeFor } from './utils.js';

/** GET /api/browse?path=... — list directory or stream file */
export function handleBrowse(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.searchParams.get('path');
  if (!p) { res.writeHead(400); res.end('missing path'); return; }
  if (!isAllowed(p)) { res.writeHead(403); res.end('forbidden'); return; }
  const resolved = resolvePath(p);
  try {
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(resolved, { withFileTypes: true }).map(e => ({
        name: e.name,
        type: e.isDirectory() ? 'dir' : 'file',
        path: path.join(resolved, e.name),
        size: e.isFile()
          ? (() => { try { return fs.statSync(path.join(resolved, e.name)).size; } catch { return 0; } })()
          : null,
      })).sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'dir', path: resolved, entries }));
    } else {
      const ext = path.extname(resolved).slice(1).toLowerCase();
      const mime = mimeFor(ext);
      res.writeHead(200, { 'Content-Type': mime });
      fs.createReadStream(resolved).pipe(res);
    }
  } catch (e) {
    res.writeHead(404); res.end(e.message);
  }
}

/** GET /api/fs/stat?path=... — return { exists, type, size } */
export function handleFsStat(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.searchParams.get('path');
  if (!p) { res.writeHead(400); res.end('missing path'); return; }
  if (!isAllowed(p)) { res.writeHead(403); res.end('forbidden'); return; }
  const resolved = resolvePath(p);
  try {
    const stat = fs.statSync(resolved);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ exists: true, type: stat.isDirectory() ? 'dir' : 'file', size: stat.size }));
  } catch {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ exists: false }));
  }
}

/** GET /api/fs/ls?path=... — list directory entries */
export function handleFsLs(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.searchParams.get('path');
  if (!p) { res.writeHead(400); res.end('missing path'); return; }
  if (!isAllowed(p)) { res.writeHead(403); res.end('forbidden'); return; }
  const resolved = resolvePath(p);
  try {
    const entries = fs.readdirSync(resolved, { withFileTypes: true }).map(e => ({
      name: e.name,
      type: e.isDirectory() ? 'dir' : 'file',
      size: e.isFile()
        ? (() => { try { return fs.statSync(path.join(resolved, e.name)).size; } catch { return 0; } })()
        : null,
      ext: path.extname(e.name).slice(1).toLowerCase(),
    })).sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ entries }));
  } catch (e) {
    res.writeHead(404); res.end(e.message);
  }
}

/** GET /api/fs/cat?path=... — return file content as JSON (max 1 MB) */
export function handleFsCat(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.searchParams.get('path');
  if (!p) { res.writeHead(400); res.end('missing path'); return; }
  if (!isAllowed(p)) { res.writeHead(403); res.end('forbidden'); return; }
  const resolved = resolvePath(p);
  try {
    const stat = fs.statSync(resolved);
    if (stat.size > 1048576) { res.writeHead(400); res.end('file too large (>1MB)'); return; }
    const content = fs.readFileSync(resolved, 'utf8');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ content }));
  } catch (e) {
    res.writeHead(404); res.end(e.message);
  }
}

/** GET /api/fs/raw?path=... — stream file with correct MIME type */
export function handleFsRaw(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.searchParams.get('path');
  if (!p) { res.writeHead(400); res.end('missing path'); return; }
  if (!isAllowed(p)) { res.writeHead(403); res.end('forbidden'); return; }
  const resolved = resolvePath(p);
  try {
    const ext = path.extname(resolved).slice(1).toLowerCase();
    const mime = mimeFor(ext);
    res.writeHead(200, { 'Content-Type': mime });
    fs.createReadStream(resolved).pipe(res);
  } catch (e) {
    res.writeHead(404); res.end(e.message);
  }
}
