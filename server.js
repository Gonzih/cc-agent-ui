/**
 * cc-agent-ui server
 * Reads ~/.cc-agent/jobs.json + ~/.cc-agent/jobs/{UUID}.log
 * Streams events to browser via WebSocket.
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { exec } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '7701', 10);

const CC_DIR   = path.join(os.homedir(), '.cc-agent');
const JOBS_FILE = path.join(CC_DIR, 'jobs.json');
const JOBS_DIR  = path.join(CC_DIR, 'jobs');
const UI_FILE   = path.join(__dirname, 'public', 'index.html');

// ── State ──────────────────────────────────────────────────────────────────
const clients   = new Set();
const jobCache  = {};          // id → job object (latest)
const logOffsets = {};         // id → bytes read so far
const TAIL_LINES = 120;        // lines to send per job on initial load

// ── Helpers ────────────────────────────────────────────────────────────────
function broadcast(evt) {
  const msg = JSON.stringify(evt);
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

function readJobs() {
  try {
    return JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
  } catch { return []; }
}

/** Read last N lines of a file, return as array */
function tailFile(filePath, n = TAIL_LINES) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    return lines.slice(-n);
  } catch { return []; }
}

/** Read new bytes from a log file since last offset, return new lines */
function pollLog(id) {
  const logPath = path.join(JOBS_DIR, `${id}.log`);
  try {
    const stat = fs.statSync(logPath);
    const size = stat.size;
    const offset = logOffsets[id] || 0;
    if (size <= offset) return [];
    const fd = fs.openSync(logPath, 'r');
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    logOffsets[id] = size;
    return buf.toString('utf8').split('\n').filter(Boolean);
  } catch { return []; }
}

/** Build initial snapshot of a job including tail of its log */
function jobSnapshot(job) {
  const logPath = path.join(JOBS_DIR, `${job.id}.log`);
  const lines = tailFile(logPath, TAIL_LINES);
  // Set offset to current file end so we don't re-send on poll
  try { logOffsets[job.id] = fs.statSync(logPath).size; } catch {}
  return { ...job, lines };
}

// ── HTTP server ────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    try {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(UI_FILE));
    } catch {
      res.writeHead(500); res.end('UI not found');
    }
  } else {
    res.writeHead(404); res.end();
  }
});

// ── WebSocket ──────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });
wss.on('connection', ws => {
  clients.add(ws);
  // Send full snapshot of all jobs + their recent output
  const jobs = readJobs();
  ws.send(JSON.stringify({
    type: 'snapshot',
    jobs: jobs.map(jobSnapshot),
  }));
  ws.on('close', () => clients.delete(ws));
});

// ── Polling loop ───────────────────────────────────────────────────────────

// 1. Check jobs.json every 2s for status changes
setInterval(() => {
  const jobs = readJobs();
  for (const job of jobs) {
    const prev = jobCache[job.id];
    jobCache[job.id] = job;
    if (!prev || prev.status !== job.status) {
      broadcast({ type: 'job_update', job });
    }
  }
  // Detect new jobs
  for (const job of jobs) {
    if (!Object.prototype.hasOwnProperty.call(jobCache, job.id)) {
      const snap = jobSnapshot(job);
      broadcast({ type: 'job_new', job: snap });
    }
  }
}, 2000);

// 2. Poll log files for running/recent jobs every 800ms
setInterval(() => {
  const jobs = readJobs();
  for (const job of jobs) {
    if (['running', 'cloning'].includes(job.status)) {
      const lines = pollLog(job.id);
      if (lines.length > 0) {
        broadcast({ type: 'job_output', id: job.id, lines });
      }
    }
  }
}, 800);

// ── Start ──────────────────────────────────────────────────────────────────
server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  cc-agent UI  →  http://127.0.0.1:${PORT}\n`);
  const open = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start' : 'xdg-open';
  setTimeout(() => exec(`${open} http://127.0.0.1:${PORT}`), 800);
});
