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
import { exec, execFile } from 'child_process';
import { randomUUID } from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT      = parseInt(process.env.PORT || '7701', 10);
const JOBS_DIR  = path.join(os.homedir(), '.cc-agent', 'jobs');
const NAMESPACE = process.env.CC_AGENT_NAMESPACE || process.env.NAMESPACE || 'default';
const UI_FILE  = path.join(__dirname, 'public', 'index.html');
const TAIL_LINES = 150;

// ── Redis ──────────────────────────────────────────────────────────────────
const redis = createClient({ url: process.env.REDIS_URL || 'redis://127.0.0.1:6379' });
redis.on('error', e => console.error('[redis]', e.message));
await redis.connect();
console.log('[redis] connected');

// Clean ghost chat log keys (owner/repo format keys not in canonical registry)
async function cleanGhostChatLogs() {
  try {
    const keys = await redis.keys('cca:chat:log:*');
    const canonical = new Set(await redis.sMembers('cca:meta:agents:index'));
    for (const key of keys) {
      const ns = key.replace('cca:chat:log:', '');
      if (ns === 'default') continue;
      if (ns.includes('/') && !canonical.has(ns)) {
        await redis.del(key);
        console.log(`[cleanup] deleted ghost chat log key: ${key}`);
      }
    }
  } catch (e) { console.error('[cleanup]', e.message); }
}
cleanGhostChatLogs();

// ── State ──────────────────────────────────────────────────────────────────
const clients        = new Set();
const jobCache       = {};   // id → job object (latest known)
const outputLengths  = {};   // id → last known Redis list length
const metaChatLengths = {}; // ns → last known list length (for polling)
const metaStatusCache = {}; // ns → last known status JSON string (for change detection)

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

/** Fetch meta-agent status from Redis, returns object or null */
async function fetchMetaStatus(ns) {
  try {
    const raw = await redis.get(`cca:meta-agent:status:${ns}`);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
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

  // Meta agents: discover from canonical registry only
  const metaNsMembers = await redis.sMembers('cca:meta:agents:index');
  const metaAgents = [];
  for (const ns of metaNsMembers) {
    if (ns === 'default') continue;
    const raw = await redis.get(`cca:meta:${ns}`);
    if (!raw) continue;
    const state = JSON.parse(raw);
    const logLen = await redis.lLen(`cca:chat:log:${ns}`);
    metaChatLengths[ns] = logLen; // initialize length tracker
    const agentStatus = await fetchMetaStatus(ns);
    if (agentStatus) metaStatusCache[ns] = JSON.stringify(agentStatus);
    metaAgents.push({ ...state, count: logLen, ...(agentStatus || {}) });
  }

  return { namespaces, jobs: withOutput, metaAgents };
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
    clj:'text/x-clojure', cljs:'text/x-clojure', sql:'text/x-sql',
    log:'text/plain', env:'text/plain', toml:'text/x-toml',
  };
  return map[ext] || 'application/octet-stream';
}

// Security: only allow paths under approved roots
const ALLOWED_ROOTS = [os.homedir(), '/tmp', '/workspace'];

function isAllowed(p) {
  const resolved = p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : path.resolve(p);
  return ALLOWED_ROOTS.some(root => resolved === root || resolved.startsWith(root + '/'));
}

function resolvePath(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : path.resolve(p);
}

// ── HTTP server ────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost`);

  if (url.pathname === '/' || url.pathname === '/index.html') {
    try {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(UI_FILE));
    } catch { if (!res.headersSent) res.writeHead(500); res.end('UI not found'); }

  } else if (url.pathname === '/api/browse') {
    // List directory or read file
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

  } else if (url.pathname === '/api/fs/stat') {
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

  } else if (url.pathname === '/api/fs/ls') {
    const p = url.searchParams.get('path');
    if (!p) { res.writeHead(400); res.end('missing path'); return; }
    if (!isAllowed(p)) { res.writeHead(403); res.end('forbidden'); return; }
    const resolved = resolvePath(p);
    try {
      const entries = fs.readdirSync(resolved, { withFileTypes: true }).map(e => ({
        name: e.name,
        type: e.isDirectory() ? 'dir' : 'file',
        size: e.isFile() ? (() => { try { return fs.statSync(path.join(resolved, e.name)).size; } catch { return 0; } })() : null,
        ext: path.extname(e.name).slice(1).toLowerCase(),
      })).sort((a,b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ entries }));
    } catch (e) {
      res.writeHead(404); res.end(e.message);
    }

  } else if (url.pathname === '/api/fs/cat') {
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

  } else if (url.pathname === '/api/fs/raw') {
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
          // Mark approved in Redis — cc-agent MCP must be called separately to actually start it
          // (cc-agent's approval is in-memory; this sets a flag for reference and for GitHub issue polling)
          const updated = { ...job, approvedAt: new Date().toISOString(), approved: true };
          await redis.set(`cca:job:${id}`, JSON.stringify(updated));
          await redis.rPush(`cca:job:${id}:output`, '[cc-agent-ui] Approved by UI — use MCP approve_job to start');
          broadcast({ type: 'job_output', id, lines: ['[cc-agent-ui] Approved by UI — use MCP approve_job to start'] });
        } else if (action === 'cancel') {
          await redis.set(`cca:job:${id}:signal`, 'cancel');
          broadcast({ type: 'job_output', id, lines: ['[cc-agent-ui] cancel signal sent'] });
        } else if (action === 'wake') {
          await redis.set(`cca:job:${id}:signal`, 'wake');
          broadcast({ type: 'job_output', id, lines: ['[cc-agent-ui] wake signal sent'] });
        } else if (action === 'message') {
          if (message) {
            // Queue for cc-agent to pick up (future: cc-agent polls cca:job:{id}:input)
            await redis.rPush(`cca:job:${id}:input`, message);
            // Echo to output so it's visible in terminal immediately
            const line = `[you] ${message}`;
            const newLen = await redis.rPush(`cca:job:${id}:output`, line);
            // Advance the output length tracker so the poller doesn't re-broadcast this line
            outputLengths[id] = newLen;
            broadcast({ type: 'job_output', id, lines: [line] });
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, action, id }));
      } catch (e) {
        res.writeHead(500); res.end(e.message);
      }
    });

  } else if (url.pathname === '/api/open') {
    const p = url.searchParams.get('path');
    if (!p) { res.writeHead(400); res.end('missing path'); return; }
    execFile('code', [p], err => {
      if (err) execFile('open', [p], () => {});
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));

  } else if (url.pathname === '/crons' && req.method === 'GET') {
    (async () => {
      try {
        // cc-agent stores crons as JSON array in a Redis string key
        const raw = await redis.get(`cca:crons:${NAMESPACE}`);
        const crons = raw ? JSON.parse(raw) : [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(crons));
      } catch (e) { res.writeHead(500); res.end(e.message); }
    })();

  } else if (url.pathname === '/crons' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const { schedule, prompt, repoUrl, intervalMs } = JSON.parse(body);
        const raw = await redis.get(`cca:crons:${NAMESPACE}`);
        const crons = raw ? JSON.parse(raw) : [];
        const id = `${Date.now()}-ui${Math.random().toString(36).slice(2,6)}`;
        const cron = { id, chatId: 0, intervalMs: intervalMs || 3600000, prompt, schedule: schedule || 'manual', repoUrl: repoUrl || '', createdAt: new Date().toISOString() };
        crons.push(cron);
        await redis.set(`cca:crons:${NAMESPACE}`, JSON.stringify(crons));
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(cron));
      } catch (e) { res.writeHead(500); res.end(e.message); }
    });

  } else if (url.pathname.startsWith('/crons/') && req.method === 'DELETE') {
    (async () => {
      try {
        const id = decodeURIComponent(url.pathname.slice('/crons/'.length));
        const raw = await redis.get(`cca:crons:${NAMESPACE}`);
        const crons = raw ? JSON.parse(raw) : [];
        const updated = crons.filter(c => c.id !== id);
        await redis.set(`cca:crons:${NAMESPACE}`, JSON.stringify(updated));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) { res.writeHead(500); res.end(e.message); }
    })();

  } else if (url.pathname.startsWith('/crons/') && req.method === 'PATCH') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const id = decodeURIComponent(url.pathname.slice('/crons/'.length));
        const updates = JSON.parse(body);
        const raw = await redis.get(`cca:crons:${NAMESPACE}`);
        const crons = raw ? JSON.parse(raw) : [];
        const idx = crons.findIndex(c => c.id === id);
        if (idx === -1) { res.writeHead(404); res.end('cron not found'); return; }
        crons[idx] = { ...crons[idx], ...updates, id };
        await redis.set(`cca:crons:${NAMESPACE}`, JSON.stringify(crons));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(crons[idx]));
      } catch (e) { res.writeHead(500); res.end(e.message); }
    });

  } else if (url.pathname === '/api/config' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ namespace: NAMESPACE }));

  } else if (url.pathname === '/chat/history' && req.method === 'GET') {
    (async () => {
      try {
        const namespace = url.searchParams.get('namespace') || NAMESPACE;
        const raw = await redis.lRange(`cca:chat:log:${namespace}`, 0, 99);
        const messages = raw.map(v => JSON.parse(v)).reverse();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(messages));
      } catch (e) { res.writeHead(500); res.end(e.message); }
    })();

  } else if (url.pathname === '/chat/send' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const parsed = JSON.parse(body);
        const namespace = parsed.namespace || NAMESPACE;
        const message = parsed.message;
        const msg = { id: randomUUID(), source: 'ui', role: 'user', content: message, namespace, timestamp: new Date().toISOString() };

        // Check if a meta-agent is running for this namespace
        let metaStatus = null;
        try {
          const metaStatusRaw = await redis.get(`cca:meta-agent:status:${namespace}`);
          metaStatus = metaStatusRaw ? JSON.parse(metaStatusRaw) : null;
        } catch {}

        if (metaStatus && metaStatus.status === 'running') {
          // Route directly to meta-agent input queue
          const inputEntry = { id: msg.id, content: message, timestamp: msg.timestamp };
          await redis.lPush(`cca:meta:${namespace}:input`, JSON.stringify(inputEntry));
        } else {
          // No meta-agent running — route to coordinator/cc-tg as before
          await redis.publish(`cca:chat:incoming:${namespace}`, JSON.stringify(msg));
        }

        // Always write to chat log regardless of routing
        await redis.lPush(`cca:chat:log:${namespace}`, JSON.stringify(msg));
        await redis.lTrim(`cca:chat:log:${namespace}`, 0, 499);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) { res.writeHead(500); res.end(e.message); }
    });

  } else if (url.pathname === '/chat/stream' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write(':ok\n\n');
    const sub = redis.duplicate();
    (async () => {
      try {
        await sub.connect();
        const subscribed = new Set();
        let closed = false;

        async function subscribeToNamespaces() {
          if (closed) return;
          try {
            const namespaces = await getNamespaces();
            // Also include meta-agent namespaces from canonical registry
            const metaNsMembers = await redis.sMembers('cca:meta:agents:index');
            const metaNs = metaNsMembers
              .filter(ns => ns !== 'default' && !namespaces.includes(ns));
            const allNamespaces = [...namespaces, ...metaNs];
            for (const ns of allNamespaces) {
              if (!subscribed.has(ns)) {
                subscribed.add(ns);
                await sub.subscribe(`cca:chat:outgoing:${ns}`, (rawMsg) => {
                  try {
                    const parsed = JSON.parse(rawMsg);
                    if (!parsed.namespace) parsed.namespace = ns;
                    res.write(`data: ${JSON.stringify(parsed)}\n\n`);
                  } catch {}
                });
              }
            }
          } catch {}
        }

        await subscribeToNamespaces();
        const pollInterval = setInterval(subscribeToNamespaces, 30000);

        req.on('close', async () => {
          closed = true;
          clearInterval(pollInterval);
          try { await sub.disconnect(); } catch {}
        });
      } catch (e) {
        res.end();
      }
    })();

  } else if (url.pathname === '/versions' && req.method === 'GET') {
    (async () => {
      try {
        const pkgPath = path.join(__dirname, 'package.json');
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const [agentVer, tgVer] = await Promise.all([
          redis.get('cca:meta:cc-agent:version').catch(() => null),
          redis.get('cca:meta:cc-tg:version').catch(() => null),
        ]);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          'cc-agent-ui': pkg.version,
          'cc-agent': agentVer || 'unknown',
          'cc-tg': tgVer || 'unknown',
        }));
      } catch (e) { res.writeHead(500); res.end(e.message); }
    })();

  } else if (url.pathname === '/api/meta-agents') {
    (async () => {
      try {
        const metaNsMembers = await redis.sMembers('cca:meta:agents:index');
        const agents = [];
        for (const ns of metaNsMembers) {
          if (ns === 'default') continue;
          const raw = await redis.get(`cca:meta:${ns}`);
          if (!raw) continue;
          const state = JSON.parse(raw);
          const logLen = await redis.lLen(`cca:chat:log:${ns}`);
          const agentStatus = await fetchMetaStatus(ns);
          agents.push({ ...state, count: logLen, ...(agentStatus || {}) });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(agents));
      } catch (e) { res.writeHead(500); res.end(e.message); }
    })();

  } else if (url.pathname === '/api/meta-chat/log') {
    const ns = url.searchParams.get('ns');
    if (!ns) { res.writeHead(400); res.end('missing ns'); return; }
    (async () => {
      try {
        const raw = await redis.lRange(`cca:chat:log:${ns}`, 0, 99);
        const msgs = raw.map(v => { try { return JSON.parse(v); } catch { return null; } }).filter(Boolean).reverse();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(msgs));
      } catch (e) { res.writeHead(500); res.end(e.message); }
    })();

  } else if (url.pathname === '/api/meta-chat/send' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const { ns, message } = JSON.parse(body);
        if (!ns || !message) { res.writeHead(400); res.end('missing ns/message'); return; }

        // Derive canonical short namespace (e.g. "gonzih/cc-agent" → "cc-agent")
        let canonicalNs = ns.includes('/') ? ns.split('/').pop() : ns;

        // Auto-provision if not yet registered
        const members = await redis.sMembers('cca:meta:agents:index');
        if (!members.includes(canonicalNs)) {
          const repoUrl = ns.includes('/')
            ? `https://github.com/${ns}`
            : `https://github.com/gonzih/${canonicalNs}`;
          const cwd = path.join(os.homedir(), 'cc-agent-workspace', canonicalNs);
          const state = {
            namespace: canonicalNs,
            repoUrl,
            cwd,
            status: 'idle',
            startedAt: new Date().toISOString(),
          };
          const TTL_30D = 30 * 24 * 60 * 60;
          await redis.set(`cca:meta:${canonicalNs}`, JSON.stringify(state), { EX: TTL_30D });
          await redis.sAdd('cca:meta:agents:index', canonicalNs);
          console.log(`[meta] auto-provisioned namespace: ${canonicalNs} (repoUrl: ${repoUrl})`);
        }

        // Push to canonical input queue
        const inputEntry = { id: randomUUID(), content: message, timestamp: new Date().toISOString() };
        await redis.lPush(`cca:meta:${canonicalNs}:input`, JSON.stringify(inputEntry));

        // Log user message under canonical ns
        const msg = { id: randomUUID(), source: 'ui', role: 'user', content: message, timestamp: Date.now() };
        const newLen = await redis.lPush(`cca:chat:log:${canonicalNs}`, JSON.stringify(msg));
        metaChatLengths[canonicalNs] = newLen; // advance tracker before lTrim yield to prevent poll-loop double-broadcast
        await redis.lTrim(`cca:chat:log:${canonicalNs}`, 0, 499);
        broadcast({ type: 'meta_msg', ns: canonicalNs, msg });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) { res.writeHead(500); res.end(e.message); }
    });

  } else if (/^\/api\/jobs\/([^/]+)\/stream$/.test(url.pathname)) {
    // SSE endpoint: stream job output in real-time
    const id = url.pathname.match(/^\/api\/jobs\/([^/]+)\/stream$/)[1];
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write('retry: 3000\n\n');

    let closed = false;
    let sub = null;
    let pollTimer = null;

    req.on('close', async () => {
      closed = true;
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      if (sub) { try { await sub.disconnect(); } catch {} sub = null; }
    });

    (async () => {
      try {
        // Send all current output lines as initial backlog
        let offset = 0;
        try {
          const lines = await redis.lRange(`cca:job:${id}:output`, 0, -1);
          for (const line of lines) {
            if (closed) return;
            res.write(`data: ${JSON.stringify(line)}\n\n`);
          }
          offset = lines.length;
        } catch {}
        if (closed) return;

        // Signal that initial backlog is done
        res.write('event: ready\ndata: 1\n\n');

        // Try pub/sub for live lines
        let pubSubOk = false;
        try {
          sub = redis.duplicate();
          await sub.connect();
          await sub.subscribe(`cca:job:${id}:output:live`, (msg) => {
            if (!closed) {
              try { res.write(`data: ${JSON.stringify(msg)}\n\n`); } catch {}
            }
          });
          pubSubOk = true;
        } catch {
          if (sub) { try { await sub.disconnect(); } catch {} sub = null; }
        }

        if (!pubSubOk) {
          // Fallback: poll the Redis list every 2s for new lines
          pollTimer = setInterval(async () => {
            if (closed) { clearInterval(pollTimer); return; }
            try {
              const len = await redis.lLen(`cca:job:${id}:output`);
              if (len > offset) {
                const newLines = await redis.lRange(`cca:job:${id}:output`, offset, -1);
                for (const line of newLines) {
                  if (closed) return;
                  res.write(`data: ${JSON.stringify(line)}\n\n`);
                }
                offset = len;
              }
            } catch {}
          }, 2000);
        }
      } catch (e) {
        if (!closed) { try { res.end(); } catch {} }
      }
    })();

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

// ── Tool call synthesis from recentTools diff ──────────────────────────────
const toolTrack = {}; // id → last recentTools array

function diffTools(prevArr, currArr) {
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
          toolTrack[job.id] = job.recentTools || [];
          const lines = await getOutputTail(job.id, 50);
          broadcast({ type: 'job_new', job: { ...job, lines } });
        } else if (prev.status !== job.status) {
          jobCache[job.id] = job;
          broadcast({ type: 'job_update', job });
        } else {
          jobCache[job.id] = { ...prev, ...job };
        }
        // Detect new tool calls via recentTools diff
        const activeStatuses = new Set(['running', 'cloning']);
        if (activeStatuses.has(job.status)) {
          const prevTools = toolTrack[job.id] || [];
          const currTools = job.recentTools || [];
          const newTools = diffTools(prevTools, currTools);
          toolTrack[job.id] = currTools;
          if (newTools.length) {
            const lines = newTools.map(t => `[tool] ${t}`);
            broadcast({ type: 'job_output', id: job.id, lines });
            // Also write to Redis output so it persists
            const pipeline = redis.multi();
            for (const l of lines) pipeline.rPush(`cca:job:${job.id}:output`, l);
            pipeline.exec().catch(() => {});
          }
        }
      }
    }
  } catch (e) {
    console.error('[poll:status]', e.message);
  }
}, 2500);

// ── Polling: output for active + recently-finished jobs ───────────────────
const recentlyFinished = new Map(); // id → finishedTimestamp
setInterval(async () => {
  const now = Date.now();
  const activeStatuses = new Set(['running', 'cloning', 'pending_approval']);
  // Include recently finished jobs for 15s to catch tail output
  const toPoll = Object.values(jobCache).filter(j =>
    activeStatuses.has(j.status) ||
    (recentlyFinished.has(j.id) && now - recentlyFinished.get(j.id) < 15000)
  );
  for (const job of toPoll) {
    // Track when jobs finish
    if (!activeStatuses.has(job.status) && !recentlyFinished.has(job.id)) {
      recentlyFinished.set(job.id, now);
    }
    try {
      const lines = await pollNewOutput(job.id);
      if (lines.length > 0) {
        broadcast({ type: 'job_output', id: job.id, lines });
      }
    } catch {}
  }
  // Clean up old entries
  for (const [id, ts] of recentlyFinished) {
    if (now - ts > 30000) recentlyFinished.delete(id);
  }
}, 900);

// ── Polling: meta agent chat logs ──────────────────────────────────────────
setInterval(async () => {
  try {
    const keys = await redis.keys('cca:chat:log:*');
    for (const key of keys) {
      const ns = key.replace('cca:chat:log:', '');
      if (ns === 'default') continue; // money-brain is the default namespace
      const len = await redis.lLen(key);
      const prev = metaChatLengths[ns];
      if (prev === undefined) { metaChatLengths[ns] = len; continue; } // first see
      if (len <= prev) continue;
      const newCount = len - prev;
      metaChatLengths[ns] = len;
      const raw = await redis.lRange(key, 0, newCount - 1); // newest first
      const msgs = raw.map(v => { try { return JSON.parse(v); } catch { return null; } }).filter(Boolean).reverse();
      for (const msg of msgs) broadcast({ type: 'meta_msg', ns, msg });
    }
  } catch (e) { console.error('[poll:meta-chat]', e.message); }
}, 2500);

// ── Polling: meta agent live status (typing, currentTool, etc.) ───────────
setInterval(async () => {
  try {
    const keys = await redis.keys('cca:meta-agent:status:*');
    for (const key of keys) {
      const ns = key.replace('cca:meta-agent:status:', '');
      if (ns === 'default') continue;
      const raw = await redis.get(key);
      if (!raw) continue;
      const prev = metaStatusCache[ns];
      if (prev === raw) continue; // unchanged
      metaStatusCache[ns] = raw;
      try {
        const status = JSON.parse(raw);
        broadcast({ type: 'meta_status', ns, status });
      } catch {}
    }
  } catch (e) { console.error('[poll:meta-status]', e.message); }
}, 2000);

// ── Start ──────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  cc-agent UI  →  http://0.0.0.0:${PORT}\n`);
  const open = process.platform === 'darwin' ? 'open' : 'xdg-open';
  setTimeout(() => exec(`${open} http://127.0.0.1:${PORT}`), 1000);
});
