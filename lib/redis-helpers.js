/**
 * Redis helper functions — each takes a `redis` client as its first argument
 * so tests can inject a mock without importing the live client.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  META_AGENTS_INDEX,
  jobIndexKey,
  jobKey,
  jobOutputKey,
  metaAgentStatusKey,
  chatLogKey,
  swarmKey,
} from '@gonzih/cc-wire';
import { parseJob } from './utils.js';

const JOBS_DIR = path.join(os.homedir(), '.cc-agent', 'jobs');
export const TAIL_LINES = 150;

/** Get all namespace keys from cca:jobs:* */
export async function getNamespaces(redis) {
  const keys = await redis.keys(jobIndexKey('*'));
  return keys
    .filter(k => !k.includes(':index'))
    .map(k => k.replace(jobIndexKey(''), ''));
}

/** Get all job IDs for a namespace */
export async function getJobIds(redis, namespace) {
  return redis.sMembers(jobIndexKey(namespace));
}

/**
 * Fetch a single job by ID.  Returns null if not found or invalid JSON.
 */
export async function fetchJob(redis, id) {
  const raw = await redis.get(jobKey(id));
  const job = parseJob(raw);
  if (job) job._id = id;
  return job;
}

/**
 * Fetch multiple jobs in one pipeline.
 * Jobs whose Redis value is missing or invalid JSON are silently dropped.
 */
export async function fetchJobs(redis, ids) {
  if (!ids.length) return [];
  const pipeline = redis.multi();
  for (const id of ids) pipeline.get(jobKey(id));
  const results = await pipeline.exec();
  return results
    .map((raw, i) => { const j = parseJob(raw); if (j) j.id = j.id || ids[i]; return j; })
    .filter(Boolean);
}

/** Fetch meta-agent status from Redis.  Returns object or null on any error. */
export async function fetchMetaStatus(redis, ns) {
  try {
    const raw = await redis.get(metaAgentStatusKey(ns));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

/**
 * Get the last `n` lines from the Redis output list for a job.
 * Falls back to reading the disk log file if Redis has no data.
 * Returns [] if both sources are unavailable.
 */
export async function getOutputTail(redis, id, outputLengths, n = TAIL_LINES) {
  try {
    const len = await redis.lLen(jobOutputKey(id));
    if (len > 0) {
      outputLengths[id] = len;
      const start = Math.max(0, len - n);
      return redis.lRange(jobOutputKey(id), start, -1);
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

/**
 * Poll for new output lines since the last known Redis list length.
 * Returns [] on Redis error or when there is no new data.
 */
export async function pollNewOutput(redis, id, outputLengths) {
  try {
    const len = await redis.lLen(jobOutputKey(id));
    const prev = outputLengths[id] || 0;
    if (len <= prev) return [];
    outputLengths[id] = len;
    return redis.lRange(jobOutputKey(id), prev, -1);
  } catch { return []; }
}

/**
 * Fetch all swarm records from Redis (cca:swarm:* keys).
 * Records without a `swarm_id` field are filtered out (non-swarm keys).
 * Returned array is sorted newest-first by created_at.
 * Returns [] on any Redis error.
 */
export async function getSwarms(redis) {
  try {
    const keys = await redis.keys(swarmKey('*'));
    const swarms = [];
    for (const key of keys) {
      const raw = await redis.get(key);
      if (!raw) continue;
      try {
        const s = JSON.parse(raw);
        if (s && s.swarm_id) swarms.push(s);
      } catch {}
    }
    swarms.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    return swarms;
  } catch { return []; }
}

/**
 * Clean ghost chat log keys — keys in cca:chat:log:* that contain a slash
 * (owner/repo format) but are not in the canonical meta-agent registry.
 */
export async function cleanGhostChatLogs(redis) {
  try {
    const keys = await redis.keys(chatLogKey('*'));
    const canonical = new Set(await redis.sMembers(META_AGENTS_INDEX));
    for (const key of keys) {
      const ns = key.replace(chatLogKey(''), '');
      if (ns === 'default') continue;
      if (ns.includes('/') && !canonical.has(ns)) {
        await redis.del(key);
      }
    }
  } catch (e) { console.error('[cleanup]', e.message); }
}
