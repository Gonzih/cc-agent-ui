#!/usr/bin/env node
/**
 * cc-agent-ui server — plugged into Redis directly.
 *
 * Data sources:
 *   cca:jobs:{namespace}      → Redis SET of job IDs per namespace
 *   cca:job:{UUID}            → Redis STRING (JSON) — full job metadata
 *   cca:job:{UUID}:output     → Redis LIST — log lines (append-only)
 *   ~/.cc-agent/jobs/{UUID}.log → disk fallback for output
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { createClient } from 'redis';
import { exec } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT     = parseInt(process.env.PORT || '7701', 10);
const JOBS_DIR = path.join(os.homedir(), '.cc-agent', 'jobs');
const UI_FILE  = path.join(__dirname, 'public', 'index.html');
const TAIL_LINES = 150;

// ── Redis ──────────────────────────────────────────────────────────────────
const redis = createClient({ url: 'redis://127.0.0.1:6379' });
redis.on('error', e => console.error('[redis]', e.message));
await redis.connect();
console.log('[redis] connected');

// ── State ──────────────────────────────────────────────────────────────────
const clients       = new Set();
const jobCache      = {};   // id → job object (latest known)
const outputLengths = {};   // id → last known Redis list length

// ── Helpers ────────────────────────────────────────────────────────────────
function broadcast(evt) {
  const msg = JSON.stringify(evt);
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

/** Parse a job JSON string from Redis, return null on failure */
function parseJob(raw) {
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

/** Get all namespace keys: cca:jobs:* */
async function getNamespaces() {
  const keys = await redis.keys('cca:jobs:*');
  return keys
    .filter(k => !k.includes(':index'))
    .map(k => k.replace('cca:jobs:', ''));
}

/** Get all job IDs for a namespace */
async function getJobIds(namespace) {
  return redis.sMembers(`cca:jobs:${namespace}`);
}

/** Fetch a single job by ID */
async function fetchJob(id) {
  const raw = await redis.get(`cca:job:${id}`);
  const job = parseJob(raw);
  if (job) job._id = id;
  return job;
}

/** Fetch multiple jobs in one pipeline */
async function fetchJobs(ids) {
  if (!ids.length) return [];
  const pipeline = redis.multi();
  for (const id of ids) pipeline.get(`cca:job:${id}`);
  const results = await pipeline.exec();
  return results
    .map((raw, i) => { const j = parseJob(raw); if (j) j.id = j.id || ids[i]; return j; })
    .filter(Boolean);
}

/** Get last N lines from Redis output list (or disk fallback) */
async function getOutputTail(id, n = TAIL_LINES) {
  try {
    const len = await redis.lLen(`cca:job:${id}:output`);
    if (len > 0) {
      outputLengths[id] = len;
      const start = Math.max(0, len - n);
      return redis.lRange(`cca:job:${id}:output`, start, -1);
    }
  } catch {}
  // Disk fallback
  try {
    const content = fs.readFileSync(path.join(JOBS_DIR, `${id}.log`), 'utf8');
    const lines = content.split('\n').filter(Boolean);
    outputLengths[id] = lines.length;
    return lines.slice(-n);
  } catch { return []; }
}

/** Poll for new output lines since last known length */
async function pollNewOutput(id) {
  try {
    const len = await redis.lLen(`cca:job:${id}:output`);
    const prev = outputLengths[id] || 0;
    if (len <= prev) return [];
    outputLengths[id] = len;
    return redis.lRange(`cca:job:${id}:output`, prev, -1);
  } catch { return []; }
}

// ── Build initial snapshot ─────────────────────────────────────────────────
async function buildSnapshot() {
  const namespaces = await getNamespaces();
  const allJobs = [];

  for (const ns of namespaces) {
    const ids = await getJobIds(ns);
    const jobs = await fetchJobs(ids);
    // Attach namespace
    for (const j of jobs) { j.namespace = ns; jobCache[j.id] = j; }
    allJobs.push(...jobs);
  }

  // Sort: running/cloning first, then by startedAt desc
  const ORDER = { running:0, cloning:1, pending_approval:2, failed:3, cancelled:4, done:5 };
  allJobs.sort((a, b) =>
    (ORDER[a.status]??9) - (ORDER[b.status]??9) ||
    new Date(b.startedAt||0) - new Date(a.startedAt||0)
  );

  // Fetch output for each (pipeline-style, batched to avoid overwhelming)
  const withOutput = [];
  const BATCH = 30;
  for (let i = 0; i < allJobs.length; i += BATCH) {
    const batch = allJobs.slice(i, i + BATCH);
    const outputs = await Promise.all(batch.map(j => getOutputTail(j.id)));
    batch.forEach((j, k) => withOutput.push({ ...j, lines: outputs[k] }));
  }

  return { namespaces, jobs: withOutput };
}

// ── File browser helpers ───────────────────────────────────────────────────
function mimeFor(ext) {
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
  };
  return map[ext] || 'application/octet-stream';
}

// ── HTTP server ────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost`);

  if (url.pathname === '/' || url.pathname === '/index.html') {
    try {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(UI_FILE));
    } catch { res.writeHead(500); res.end('UI not found'); }

  } else if (url.pathname === '/api/browse') {
    // List directory or read file
    const p = url.searchParams.get('path');
    if (!p) { res.writeHead(400); res.end('missing path'); return; }
    // Resolve ~ and normalize
    const resolved = p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : path.resolve(p);
    try {
      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) {
        const entries = fs.readdirSync(resolved, { withFileTypes: true }).map(e => ({
          name: e.name,
          type: e.isDirectory() ? 'dir' : 'file',
          path: path.join(resolved, e.name),
          size: e.isFile() ? (() => { try { return fs.statSync(path.join(resolved, e.name)).size; } catch { return 0; } })() : null,
        })).sort((a,b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
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

  } else if (url.pathname === '/api/job/output') {
    // Full output for a job
    const id = url.searchParams.get('id');
    if (!id) { res.writeHead(400); res.end('missing id'); return; }
    (async () => {
      try {
        const lines = await getOutputTail(id, 5000);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ lines }));
      } catch (e) { res.writeHead(500); res.end(e.message); }
    })();

  } else if (url.pathname === '/api/job/action' && req.method === 'POST') {
    // Job actions: approve, cancel, wake
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const { id, action, message } = JSON.parse(body);
        if (!id || !action) { res.writeHead(400); res.end('missing id/action'); return; }
        const jobRaw = await redis.get(`cca:job:${id}`);
        const job = parseJob(jobRaw);
        if (!job) { res.writeHead(404); res.end('job not found'); return; }

        if (action === 'approve') {
          // Set approval flag — cc-agent polls for this
          const updated = { ...job, approvedAt: new Date().toISOString(), approved: true };
          await redis.set(`cca:job:${id}`, JSON.stringify(updated));
          // Also push approval to output list so agent sees it
          await redis.rPush(`cca:job:${id}:output`, '[cc-agent-ui] Job approved by user');
        } else if (action === 'cancel') {
          const updated = { ...job, status: 'cancelled', cancelledAt: new Date().toISOString() };
          await redis.set(`cca:job:${id}`, JSON.stringify(updated));
          broadcast({ type: 'job_update', job: updated });
        } else if (action === 'wake') {
          const updated = { ...job, status: 'running', wakedAt: new Date().toISOString() };
          await redis.set(`cca:job:${id}`, JSON.stringify(updated));
          broadcast({ type: 'job_update', job: updated });
        } else if (action === 'message') {
          // Send a message into the job's input channel
          if (message) await redis.rPush(`cca:job:${id}:input`, message);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, action, id }));
      } catch (e) {
        res.writeHead(500); res.end(e.message);
      }
    });

  } else {
    res.writeHead(404); res.end();
  }
});

// ── WebSocket ──────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });
wss.on('connection', async ws => {
  clients.add(ws);
  console.log(`[ws] client connected (total: ${clients.size})`);
  try {
    const snap = await buildSnapshot();
    ws.send(JSON.stringify({ type: 'snapshot', ...snap }));
  } catch (e) {
    console.error('[snapshot]', e.message);
  }
  ws.on('close', () => { clients.delete(ws); });
});

// ── Polling: job status changes ────────────────────────────────────────────
setInterval(async () => {
  try {
    const namespaces = await getNamespaces();
    for (const ns of namespaces) {
      const ids = await getJobIds(ns);
      const jobs = await fetchJobs(ids);
      for (const job of jobs) {
        job.namespace = ns;
        const prev = jobCache[job.id];
        if (!prev) {
          // New job
          jobCache[job.id] = job;
          const lines = await getOutputTail(job.id, 50);
          broadcast({ type: 'job_new', job: { ...job, lines } });
        } else if (prev.status !== job.status) {
          jobCache[job.id] = job;
          broadcast({ type: 'job_update', job });
        } else {
          jobCache[job.id] = { ...prev, ...job };
        }
      }
    }
  } catch (e) {
    console.error('[poll:status]', e.message);
  }
}, 2500);

// ── Polling: output for active jobs ───────────────────────────────────────
setInterval(async () => {
  const activeStatuses = new Set(['running', 'cloning', 'pending_approval']);
  const active = Object.values(jobCache).filter(j => activeStatuses.has(j.status));
  for (const job of active) {
    try {
      const lines = await pollNewOutput(job.id);
      if (lines.length > 0) {
        broadcast({ type: 'job_output', id: job.id, lines });
      }
    } catch {}
  }
}, 900);

// ── Start ──────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  cc-agent UI  →  http://0.0.0.0:${PORT}\n`);
  const open = process.platform === 'darwin' ? 'open' : 'xdg-open';
  setTimeout(() => exec(`${open} http://127.0.0.1:${PORT}`), 1000);
});
