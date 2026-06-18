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
import { parseJob, mimeFor, isAllowed, resolvePath, diffTools } from './lib/utils.js';
import {
  CC_AGENT_VERSION_KEY,
  SWARM_REQUESTS_KEY,
  jobKey,
  jobOutputKey,
  jobSignalKey,
  jobInputKey,
  jobOutputLiveChannel,
  swarmKey,
  cronsKey,
  wikiKey,
  wikiUpdatedKey,
} from '@gonzih/cc-wire';
import {
  getNamespaces as $getNamespaces,
  getJobIds     as $getJobIds,
  fetchJob      as $fetchJob,
  fetchJobs     as $fetchJobs,
  getOutputTail as $getOutputTail,
  pollNewOutput as $pollNewOutput,
  getSwarms     as $getSwarms,
} from './lib/redis-ops.js';
import {
  handleBrowse,
  handleFsStat,
  handleFsLs,
  handleFsCat,
  handleFsRaw,
} from './lib/fs-handlers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT      = parseInt(process.env.PORT || '7701', 10);

// ── Wiki slug validation ───────────────────────────────────────────────────
const WIKI_SLUG_RE = /^[a-zA-Z0-9_.-]+$/;
function validSlug(s) { return typeof s === 'string' && s.length > 0 && s.length <= 200 && WIKI_SLUG_RE.test(s); }
const JOBS_DIR  = path.join(os.homedir(), '.cc-agent', 'jobs');
const NAMESPACE = process.env.CC_AGENT_NAMESPACE || process.env.NAMESPACE || 'default';
const UI_FILE  = path.join(__dirname, 'public', 'index.html');
const TAIL_LINES = 150;

// ── Redis ──────────────────────────────────────────────────────────────────
const redis = createClient({ url: process.env.REDIS_URL || 'redis://127.0.0.1:6379' });
redis.on('error', e => console.error('[redis]', e.message));
await redis.connect();
console.log('[redis] connected');


// ── State ──────────────────────────────────────────────────────────────────
const clients        = new Set();
const jobCache       = {};   // id → job object (latest known)
const outputLengths  = {};   // id → last known Redis list length
const swarmCache      = {}; // swarm_id → last known JSON string (for change detection)

// ── Helpers ────────────────────────────────────────────────────────────────
function broadcast(evt) {
  const msg = JSON.stringify(evt);
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

// Pure helpers and Redis ops are imported from lib/ — see lib/utils.js and lib/redis-ops.js.
// Wrapper shims bind the module-level redis client and outputLengths state so that
// existing call-sites in this file don't need to change.
const getNamespaces   = ()       => $getNamespaces(redis);
const getJobIds       = (ns)     => $getJobIds(redis, ns);
const fetchJob        = (id)     => $fetchJob(redis, id);
const fetchJobs       = (ids)    => $fetchJobs(redis, ids);
const getOutputTail   = (id, n)  => $getOutputTail(redis, outputLengths, id, n);
const pollNewOutput   = (id)     => $pollNewOutput(redis, outputLengths, id);
const getSwarms       = ()       => $getSwarms(redis);

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

  const swarms = await getSwarms();
  for (const s of swarms) swarmCache[s.swarm_id] = JSON.stringify(s);

  return { namespaces, jobs: withOutput, swarms };
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
    handleBrowse(req, res);

  } else if (url.pathname === '/api/fs/stat') {
    handleFsStat(req, res);

  } else if (url.pathname === '/api/fs/ls') {
    handleFsLs(req, res);

  } else if (url.pathname === '/api/fs/cat') {
    handleFsCat(req, res);

  } else if (url.pathname === '/api/fs/raw') {
    handleFsRaw(req, res);

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
        const jobRaw = await redis.get(jobKey(id));
        const job = parseJob(jobRaw);
        if (!job) { res.writeHead(404); res.end('job not found'); return; }

        if (action === 'approve') {
          // Mark approved in Redis — cc-agent MCP must be called separately to actually start it
          // (cc-agent's approval is in-memory; this sets a flag for reference and for GitHub issue polling)
          const updated = { ...job, approvedAt: new Date().toISOString(), approved: true };
          await redis.set(jobKey(id), JSON.stringify(updated));
          await redis.rPush(jobOutputKey(id), '[cc-agent-ui] Approved by UI — use MCP approve_job to start');
          broadcast({ type: 'job_output', id, lines: ['[cc-agent-ui] Approved by UI — use MCP approve_job to start'] });
        } else if (action === 'cancel') {
          await redis.set(jobSignalKey(id), 'cancel');
          broadcast({ type: 'job_output', id, lines: ['[cc-agent-ui] cancel signal sent'] });
        } else if (action === 'wake') {
          await redis.set(jobSignalKey(id), 'wake');
          broadcast({ type: 'job_output', id, lines: ['[cc-agent-ui] wake signal sent'] });
        } else if (action === 'message') {
          if (message) {
            // Queue for cc-agent to pick up (future: cc-agent polls cca:job:{id}:input)
            await redis.rPush(jobInputKey(id), message);
            // Echo to output so it's visible in terminal immediately
            const line = `[you] ${message}`;
            const newLen = await redis.rPush(jobOutputKey(id), line);
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
        const raw = await redis.get(cronsKey(NAMESPACE));
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
        const raw = await redis.get(cronsKey(NAMESPACE));
        const crons = raw ? JSON.parse(raw) : [];
        const id = `${Date.now()}-ui${Math.random().toString(36).slice(2,6)}`;
        const cron = { id, chatId: 0, intervalMs: intervalMs || 3600000, prompt, schedule: schedule || 'manual', repoUrl: repoUrl || '', createdAt: new Date().toISOString() };
        crons.push(cron);
        await redis.set(cronsKey(NAMESPACE), JSON.stringify(crons));
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(cron));
      } catch (e) { res.writeHead(500); res.end(e.message); }
    });

  } else if (url.pathname.startsWith('/crons/') && req.method === 'DELETE') {
    (async () => {
      try {
        const id = decodeURIComponent(url.pathname.slice('/crons/'.length));
        const raw = await redis.get(cronsKey(NAMESPACE));
        const crons = raw ? JSON.parse(raw) : [];
        const updated = crons.filter(c => c.id !== id);
        await redis.set(cronsKey(NAMESPACE), JSON.stringify(updated));
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
        const raw = await redis.get(cronsKey(NAMESPACE));
        const crons = raw ? JSON.parse(raw) : [];
        const idx = crons.findIndex(c => c.id === id);
        if (idx === -1) { res.writeHead(404); res.end('cron not found'); return; }
        crons[idx] = { ...crons[idx], ...updates, id };
        await redis.set(cronsKey(NAMESPACE), JSON.stringify(crons));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(crons[idx]));
      } catch (e) { res.writeHead(500); res.end(e.message); }
    });

  } else if (url.pathname === '/api/config' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ namespace: NAMESPACE }));

  } else if (url.pathname === '/versions' && req.method === 'GET') {
    (async () => {
      try {
        const pkgPath = path.join(__dirname, 'package.json');
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const agentVer = await redis.get(CC_AGENT_VERSION_KEY).catch(() => null);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          'cc-agent-ui': pkg.version,
          'cc-agent': agentVer || 'unknown',
        }));
      } catch (e) { res.writeHead(500); res.end(e.message); }
    })();

  } else if (url.pathname === '/api/wiki' && req.method === 'GET') {
    // List all repos that have wiki pages
    (async () => {
      try {
        const allKeys = await redis.keys('cca:wiki:*');
        // Filter to only base HASH keys (exclude :updated timestamps)
        const repoKeys = allKeys.filter(k => !k.endsWith(':updated'));
        const repos = [];
        for (const k of repoKeys) {
          const slug = k.slice('cca:wiki:'.length);
          const [pageCount, updatedAt] = await Promise.all([
            redis.hLen(k),
            redis.get(wikiUpdatedKey(slug)),
          ]);
          repos.push({ slug, pageCount, updatedAt: updatedAt || null });
        }
        repos.sort((a, b) => a.slug.localeCompare(b.slug));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ repos }));
      } catch (e) { res.writeHead(500); res.end(e.message); }
    })();

  } else if (/^\/api\/wiki\/([^/]+)$/.test(url.pathname) && req.method === 'GET') {
    // List pages for a repo
    const slug = decodeURIComponent(url.pathname.match(/^\/api\/wiki\/([^/]+)$/)[1]);
    if (!validSlug(slug)) { res.writeHead(400); res.end('invalid slug'); return; }
    (async () => {
      try {
        const names = await redis.hKeys(wikiKey(slug));
        const pages = names.sort().map(name => ({
          name,
          slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ pages }));
      } catch (e) { res.writeHead(500); res.end(e.message); }
    })();

  } else if (/^\/api\/wiki\/([^/]+)\/([^/]+)$/.test(url.pathname)) {
    // Get / Put / Delete a specific wiki page
    const m = url.pathname.match(/^\/api\/wiki\/([^/]+)\/([^/]+)$/);
    const repoSlug = decodeURIComponent(m[1]);
    const pageSlug = decodeURIComponent(m[2]);
    if (!validSlug(repoSlug) || !validSlug(pageSlug)) {
      res.writeHead(400); res.end('invalid slug'); return;
    }

    if (req.method === 'GET') {
      (async () => {
        try {
          // page slug may be the exact field name or a derived slug — try exact first,
          // then scan hKeys for a matching derived slug
          const allNames = await redis.hKeys(wikiKey(repoSlug));
          let fieldName = allNames.includes(pageSlug) ? pageSlug : null;
          if (!fieldName) {
            fieldName = allNames.find(
              n => n.toLowerCase().replace(/[^a-z0-9]+/g, '-') === pageSlug
            ) ?? null;
          }
          if (!fieldName) { res.writeHead(404); res.end('page not found'); return; }
          const content = await redis.hGet(wikiKey(repoSlug), fieldName);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ name: fieldName, content: content || '' }));
        } catch (e) { res.writeHead(500); res.end(e.message); }
      })();

    } else if (req.method === 'PUT') {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', async () => {
        try {
          const { content } = JSON.parse(body);
          if (typeof content !== 'string') { res.writeHead(400); res.end('content must be string'); return; }
          await redis.hSet(wikiKey(repoSlug), pageSlug, content);
          await redis.set(wikiUpdatedKey(repoSlug), new Date().toISOString());
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) { res.writeHead(500); res.end(e.message); }
      });

    } else if (req.method === 'DELETE') {
      (async () => {
        try {
          const deleted = await redis.hDel(wikiKey(repoSlug), pageSlug);
          if (deleted === 0) { res.writeHead(404); res.end('page not found'); return; }
          await redis.set(wikiUpdatedKey(repoSlug), new Date().toISOString());
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) { res.writeHead(500); res.end(e.message); }
      })();

    } else {
      res.writeHead(405); res.end('method not allowed');
    }

  } else if (url.pathname === '/api/swarms' && req.method === 'GET') {
    (async () => {
      try {
        const swarmsList = await getSwarms();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(swarmsList));
      } catch (e) { res.writeHead(500); res.end(e.message); }
    })();

  } else if (url.pathname === '/api/swarm/trigger' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const { goal, repoUrl, maxAgents } = JSON.parse(body);
        if (!goal) { res.writeHead(400); res.end('missing goal'); return; }
        const request = {
          id: randomUUID(),
          goal,
          repoUrl: repoUrl || '',
          maxAgents: Math.min(50, Math.max(1, parseInt(maxAgents) || 5)),
          requestedAt: new Date().toISOString(),
          namespace: NAMESPACE,
        };
        await redis.lPush(SWARM_REQUESTS_KEY, JSON.stringify(request));
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id: request.id }));
      } catch (e) { res.writeHead(500); res.end(e.message); }
    });

  } else if (url.pathname === '/api/meta-agents' && req.method === 'GET') {
    (async () => {
      try {
        const nsMap = new Map();
        // Primary source: cca:discord:channels:index
        try {
          const channelIds = await redis.sMembers('cca:discord:channels:index');
          for (const id of channelIds) {
            const h = await redis.hGetAll(`cca:discord:channel:${id}`);
            if (h && h.namespace) {
              const lastActive = await redis.get(`cca:meta:${h.namespace}:heartbeat`).catch(() => null);
              nsMap.set(h.namespace, { namespace: h.namespace, lastActive: lastActive || null, channelId: id });
            }
          }
        } catch {}
        // Fallback: scan cca:meta:*:heartbeat keys
        const hbKeys = await redis.keys('cca:meta:*:heartbeat').catch(() => []);
        for (const k of hbKeys) {
          const ns = k.slice('cca:meta:'.length, k.length - ':heartbeat'.length);
          if (!nsMap.has(ns)) {
            const lastActive = await redis.get(k).catch(() => null);
            nsMap.set(ns, { namespace: ns, lastActive: lastActive || null });
          }
        }
        const namespaces = Array.from(nsMap.values()).sort((a, b) => {
          // Sort by lastActive desc, then namespace name
          if (a.lastActive && b.lastActive) return new Date(b.lastActive) - new Date(a.lastActive);
          if (a.lastActive) return -1;
          if (b.lastActive) return 1;
          return a.namespace.localeCompare(b.namespace);
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ namespaces }));
      } catch (e) { res.writeHead(500); res.end(e.message); }
    })();

  } else if (/^\/api\/meta-agents\/([^/]+)\/log$/.test(url.pathname) && req.method === 'GET') {
    const ns = decodeURIComponent(url.pathname.match(/^\/api\/meta-agents\/([^/]+)\/log$/)[1]);
    if (!validSlug(ns)) { res.writeHead(400); res.end('invalid namespace'); return; }
    (async () => {
      try {
        const lines = await redis.lRange(`cca:meta:${ns}:log`, -200, -1);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ lines }));
      } catch (e) { res.writeHead(500); res.end(e.message); }
    })();

  } else if (/^\/api\/meta-agents\/([^/]+)\/stream$/.test(url.pathname)) {
    // SSE: stream meta-agent output for a namespace
    const ns = decodeURIComponent(url.pathname.match(/^\/api\/meta-agents\/([^/]+)\/stream$/)[1]);
    if (!validSlug(ns)) { res.writeHead(400); res.end('invalid namespace'); return; }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write('retry: 3000\n\n');

    let closed = false;
    let sub = null;

    req.on('close', async () => {
      closed = true;
      if (sub) { try { await sub.disconnect(); } catch {} sub = null; }
    });

    (async () => {
      try {
        // Send last 200 history lines
        const lines = await redis.lRange(`cca:meta:${ns}:log`, -200, -1);
        for (const line of lines) {
          if (closed) return;
          res.write(`data: ${JSON.stringify(line)}\n\n`);
        }
        if (closed) return;
        res.write('event: ready\ndata: 1\n\n');

        // Subscribe to live stream
        try {
          sub = redis.duplicate();
          await sub.connect();
          await sub.subscribe(`cca:meta:${ns}:stream`, (msg) => {
            if (!closed) {
              try { res.write(`data: ${JSON.stringify(msg)}\n\n`); } catch {}
            }
          });
        } catch {
          if (sub) { try { await sub.disconnect(); } catch {} sub = null; }
        }
      } catch (e) {
        if (!closed) { try { res.end(); } catch {} }
      }
    })();

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
          const lines = await redis.lRange(jobOutputKey(id), 0, -1);
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
          await sub.subscribe(jobOutputLiveChannel(id), (msg) => {
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
              const len = await redis.lLen(jobOutputKey(id));
              if (len > offset) {
                const newLines = await redis.lRange(jobOutputKey(id), offset, -1);
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
    // Static files from public/
    const safeName = path.basename(url.pathname);
    const staticPath = path.join(__dirname, 'public', safeName);
    if (safeName && !safeName.startsWith('.') && fs.existsSync(staticPath) && fs.statSync(staticPath).isFile()) {
      const ext = path.extname(safeName).slice(1).toLowerCase();
      const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', ico: 'image/x-icon', webp: 'image/webp' }[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime });
      fs.createReadStream(staticPath).pipe(res);
    } else {
      res.writeHead(404); res.end();
    }
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
// diffTools imported from src/utils.js
const toolTrack = {}; // id → last recentTools array

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
            for (const l of lines) pipeline.rPush(jobOutputKey(job.id), l);
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

// ── Polling: swarm status ──────────────────────────────────────────────────
setInterval(async () => {
  try {
    const keys = await redis.keys(swarmKey('*'));
    for (const key of keys) {
      const raw = await redis.get(key);
      if (!raw) continue;
      const swarmId = key.replace(swarmKey(''), '');
      // Skip non-swarm keys (e.g. cca:swarm:requests)
      let swarm;
      try { swarm = JSON.parse(raw); } catch { continue; }
      if (!swarm || !swarm.swarm_id) continue;
      const prev = swarmCache[swarmId];
      if (prev === raw) continue;
      swarmCache[swarmId] = raw;
      broadcast({ type: 'swarm_update', swarm });
    }
  } catch (e) { console.error('[poll:swarms]', e.message); }
}, 5000);

// ── Start ──────────────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test') {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  cc-agent UI  →  http://0.0.0.0:${PORT}\n`);
    const open = process.platform === 'darwin' ? 'open' : 'xdg-open';
    setTimeout(() => exec(`${open} http://127.0.0.1:${PORT}`), 1000);
  });
}

export { server };
