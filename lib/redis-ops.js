import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  jobIndexKey,
  jobKey,
  jobOutputKey,
  metaAgentStatusKey,
  swarmKey,
} from '@gonzih/cc-wire';
import { parseJob } from './pure.js';

const JOBS_DIR = path.join(os.homedir(), '.cc-agent', 'jobs');
const TAIL_LINES = 150;

/** Get all namespace keys: cca:jobs:* */
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

/** Fetch a single job by ID, attaching _id field */
export async function fetchJob(redis, id) {
  const raw = await redis.get(jobKey(id));
  const job = parseJob(raw);
  if (job) job._id = id;
  return job;
}

/**
 * Fetch multiple jobs in one pipeline.
 * Returns only successfully-parsed jobs; sets id from ids[i] when the job JSON has none.
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

/** Fetch meta-agent status from Redis, returns object or null */
export async function fetchMetaStatus(redis, ns) {
  try {
    const raw = await redis.get(metaAgentStatusKey(ns));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

/**
 * Get last n lines from Redis output list, with disk fallback.
 * Updates outputLengths[id] with the current length.
 */
export async function getOutputTail(redis, outputLengths, id, n = TAIL_LINES) {
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
 * Poll for new output lines since last known length.
 * Updates outputLengths[id] when new lines are found.
 */
export async function pollNewOutput(redis, outputLengths, id) {
  try {
    const len = await redis.lLen(jobOutputKey(id));
    const prev = outputLengths[id] || 0;
    if (len <= prev) return [];
    outputLengths[id] = len;
    return redis.lRange(jobOutputKey(id), prev, -1);
  } catch { return []; }
}

/** Fetch all swarms from Redis cca:swarm:* keys, sorted by created_at desc */
export async function getSwarms(redis) {
  try {
    const keys = await redis.keys(swarmKey('*'));
    const swarms = [];
    for (const key of keys) {
      const raw = await redis.get(key);
      if (!raw) continue;
      try {
        const s = JSON.parse(raw);
        // Only include records that look like swarm records (have swarm_id field)
        if (s && s.swarm_id) swarms.push(s);
      } catch {}
    }
    swarms.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    return swarms;
  } catch { return []; }
}
