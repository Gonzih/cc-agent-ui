import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import {
  getNamespaces,
  getJobIds,
  fetchJob,
  fetchJobs,
  getOutputTail,
  pollNewOutput,
  getSwarms,
} from '../lib/helpers.js';

// ── Mock redis factory ────────────────────────────────────────────────────────

function makeMockRedis(overrides = {}) {
  const pipeline = {
    get: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([]),
  };
  return {
    keys: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    sMembers: vi.fn().mockResolvedValue([]),
    sAdd: vi.fn().mockResolvedValue(1),
    del: vi.fn().mockResolvedValue(1),
    lLen: vi.fn().mockResolvedValue(0),
    lRange: vi.fn().mockResolvedValue([]),
    lPush: vi.fn().mockResolvedValue(1),
    rPush: vi.fn().mockResolvedValue(1),
    publish: vi.fn().mockResolvedValue(1),
    multi: vi.fn().mockReturnValue(pipeline),
    _pipeline: pipeline,
    ...overrides,
  };
}

// ── getNamespaces ─────────────────────────────────────────────────────────────

describe('getNamespaces', () => {
  it('returns empty array when no keys', async () => {
    const redis = makeMockRedis({ keys: vi.fn().mockResolvedValue([]) });
    expect(await getNamespaces(redis)).toEqual([]);
  });

  it('extracts namespace from cca:jobs:{ns} keys', async () => {
    const redis = makeMockRedis({
      keys: vi.fn().mockResolvedValue(['cca:jobs:money-brain', 'cca:jobs:default']),
    });
    const result = await getNamespaces(redis);
    expect(result).toContain('money-brain');
    expect(result).toContain('default');
  });

  it('filters out :index keys', async () => {
    const redis = makeMockRedis({
      keys: vi.fn().mockResolvedValue(['cca:jobs:money-brain', 'cca:jobs:money-brain:index']),
    });
    const result = await getNamespaces(redis);
    expect(result).toContain('money-brain');
    expect(result).not.toContain('money-brain:index');
    // The :index key string also contains ':index' so filtered
    expect(result.every(ns => !ns.includes(':index'))).toBe(true);
  });
});

// ── getJobIds ─────────────────────────────────────────────────────────────────

describe('getJobIds', () => {
  it('returns empty array when no members', async () => {
    const redis = makeMockRedis({ sMembers: vi.fn().mockResolvedValue([]) });
    expect(await getJobIds(redis, 'test-ns')).toEqual([]);
  });

  it('returns job IDs from the namespace set', async () => {
    const ids = ['uuid-1', 'uuid-2', 'uuid-3'];
    const redis = makeMockRedis({ sMembers: vi.fn().mockResolvedValue(ids) });
    const result = await getJobIds(redis, 'money-brain');
    expect(result).toEqual(ids);
  });
});

// ── fetchJob ──────────────────────────────────────────────────────────────────

describe('fetchJob', () => {
  it('returns null when key does not exist', async () => {
    const redis = makeMockRedis({ get: vi.fn().mockResolvedValue(null) });
    expect(await fetchJob(redis, 'missing-id')).toBe(null);
  });

  it('returns null on invalid JSON', async () => {
    const redis = makeMockRedis({ get: vi.fn().mockResolvedValue('{bad json}') });
    expect(await fetchJob(redis, 'bad-id')).toBe(null);
  });

  it('returns parsed job with _id attached', async () => {
    const job = { id: 'abc', status: 'running', namespace: 'test' };
    const redis = makeMockRedis({ get: vi.fn().mockResolvedValue(JSON.stringify(job)) });
    const result = await fetchJob(redis, 'abc');
    expect(result).toMatchObject(job);
    expect(result._id).toBe('abc');
  });

  it('sets _id even when job has no id field', async () => {
    const redis = makeMockRedis({ get: vi.fn().mockResolvedValue(JSON.stringify({ status: 'done' })) });
    const result = await fetchJob(redis, 'my-id');
    expect(result._id).toBe('my-id');
  });
});

// ── fetchJobs ─────────────────────────────────────────────────────────────────

describe('fetchJobs', () => {
  it('returns empty array for empty ids', async () => {
    const redis = makeMockRedis();
    expect(await fetchJobs(redis, [])).toEqual([]);
  });

  it('does not call redis.multi for empty ids', async () => {
    const redis = makeMockRedis();
    await fetchJobs(redis, []);
    expect(redis.multi).not.toHaveBeenCalled();
  });

  it('fetches multiple jobs via pipeline', async () => {
    const jobs = [
      { id: 'id-1', status: 'running' },
      { id: 'id-2', status: 'done' },
    ];
    const pipeline = {
      get: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue(jobs.map(j => JSON.stringify(j))),
    };
    const redis = makeMockRedis({ multi: vi.fn().mockReturnValue(pipeline) });
    const result = await fetchJobs(redis, ['id-1', 'id-2']);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject(jobs[0]);
    expect(result[1]).toMatchObject(jobs[1]);
  });

  it('filters out null results (missing jobs)', async () => {
    const pipeline = {
      get: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([JSON.stringify({ id: 'id-1', status: 'running' }), null]),
    };
    const redis = makeMockRedis({ multi: vi.fn().mockReturnValue(pipeline) });
    const result = await fetchJobs(redis, ['id-1', 'id-missing']);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('id-1');
  });

  it('fills in id from ids array when job has no id field', async () => {
    const pipeline = {
      get: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([JSON.stringify({ status: 'running' })]),
    };
    const redis = makeMockRedis({ multi: vi.fn().mockReturnValue(pipeline) });
    const result = await fetchJobs(redis, ['fallback-id']);
    expect(result[0].id).toBe('fallback-id');
  });

  it('filters out invalid JSON results', async () => {
    const pipeline = {
      get: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue(['{invalid json}', JSON.stringify({ id: 'ok', status: 'done' })]),
    };
    const redis = makeMockRedis({ multi: vi.fn().mockReturnValue(pipeline) });
    const result = await fetchJobs(redis, ['bad', 'ok']);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('ok');
  });
});

// ── getOutputTail ─────────────────────────────────────────────────────────────

describe('getOutputTail', () => {
  const jobsDir = '/tmp/test-jobs';
  let outputLengths;

  beforeEach(() => { outputLengths = {}; });

  it('returns lines from Redis when len > 0', async () => {
    const lines = ['line1', 'line2', 'line3'];
    const redis = makeMockRedis({
      lLen: vi.fn().mockResolvedValue(3),
      lRange: vi.fn().mockResolvedValue(lines),
    });
    const result = await getOutputTail(redis, 'job-id', outputLengths, jobsDir, 150);
    expect(result).toEqual(lines);
    expect(outputLengths['job-id']).toBe(3);
  });

  it('trims to last N lines when len > n', async () => {
    const redis = makeMockRedis({
      lLen: vi.fn().mockResolvedValue(200),
      lRange: vi.fn().mockResolvedValue(['line...']),
    });
    await getOutputTail(redis, 'job-id', outputLengths, jobsDir, 150);
    // lRange called with start = max(0, 200-150) = 50
    expect(redis.lRange).toHaveBeenCalledWith(expect.any(String), 50, -1);
  });

  it('falls back to disk when Redis len is 0', async () => {
    const redis = makeMockRedis({
      lLen: vi.fn().mockResolvedValue(0),
    });
    // Write a temp log file
    const testDir = path.join(os.tmpdir(), 'helpers-test-' + Date.now());
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(path.join(testDir, 'test-job.log'), 'line1\nline2\nline3\n');
    const result = await getOutputTail(redis, 'test-job', outputLengths, testDir, 150);
    expect(result).toEqual(['line1', 'line2', 'line3']);
    expect(outputLengths['test-job']).toBe(3);
    fs.rmSync(testDir, { recursive: true });
  });

  it('returns [] when Redis is 0 and disk file missing', async () => {
    const redis = makeMockRedis({ lLen: vi.fn().mockResolvedValue(0) });
    const result = await getOutputTail(redis, 'no-such-job', outputLengths, '/tmp/no-such-dir', 150);
    expect(result).toEqual([]);
  });

  it('falls back to disk when Redis throws', async () => {
    const redis = makeMockRedis({
      lLen: vi.fn().mockRejectedValue(new Error('redis error')),
    });
    const testDir = path.join(os.tmpdir(), 'helpers-test2-' + Date.now());
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(path.join(testDir, 'err-job.log'), 'a\nb\n');
    const result = await getOutputTail(redis, 'err-job', outputLengths, testDir, 150);
    expect(result).toEqual(['a', 'b']);
    fs.rmSync(testDir, { recursive: true });
  });

  it('returns [] when both Redis and disk fail', async () => {
    const redis = makeMockRedis({
      lLen: vi.fn().mockRejectedValue(new Error('redis error')),
    });
    const result = await getOutputTail(redis, 'gone', outputLengths, '/nonexistent', 150);
    expect(result).toEqual([]);
  });

  it('uses default n=150 when not provided', async () => {
    const redis = makeMockRedis({
      lLen: vi.fn().mockResolvedValue(5),
      lRange: vi.fn().mockResolvedValue(['a', 'b', 'c', 'd', 'e']),
    });
    const result = await getOutputTail(redis, 'job', outputLengths, jobsDir);
    expect(result).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('slices disk lines to last n', async () => {
    const testDir = path.join(os.tmpdir(), 'helpers-test3-' + Date.now());
    fs.mkdirSync(testDir, { recursive: true });
    const manyLines = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n') + '\n';
    fs.writeFileSync(path.join(testDir, 'big-job.log'), manyLines);
    const redis = makeMockRedis({ lLen: vi.fn().mockResolvedValue(0) });
    const result = await getOutputTail(redis, 'big-job', outputLengths, testDir, 3);
    expect(result).toEqual(['line7', 'line8', 'line9']);
    fs.rmSync(testDir, { recursive: true });
  });
});

// ── pollNewOutput ─────────────────────────────────────────────────────────────

describe('pollNewOutput', () => {
  let outputLengths;
  beforeEach(() => { outputLengths = {}; });

  it('returns [] when no new lines', async () => {
    outputLengths['job'] = 5;
    const redis = makeMockRedis({ lLen: vi.fn().mockResolvedValue(5) });
    expect(await pollNewOutput(redis, 'job', outputLengths)).toEqual([]);
  });

  it('returns [] when len < prev (should not happen, defensive)', async () => {
    outputLengths['job'] = 10;
    const redis = makeMockRedis({ lLen: vi.fn().mockResolvedValue(5) });
    expect(await pollNewOutput(redis, 'job', outputLengths)).toEqual([]);
  });

  it('returns new lines when len > prev', async () => {
    outputLengths['job'] = 3;
    const redis = makeMockRedis({
      lLen: vi.fn().mockResolvedValue(5),
      lRange: vi.fn().mockResolvedValue(['line4', 'line5']),
    });
    const result = await pollNewOutput(redis, 'job', outputLengths);
    expect(result).toEqual(['line4', 'line5']);
    expect(outputLengths['job']).toBe(5);
    expect(redis.lRange).toHaveBeenCalledWith(expect.any(String), 3, -1);
  });

  it('treats missing outputLengths[id] as 0', async () => {
    const redis = makeMockRedis({
      lLen: vi.fn().mockResolvedValue(2),
      lRange: vi.fn().mockResolvedValue(['line1', 'line2']),
    });
    const result = await pollNewOutput(redis, 'new-job', outputLengths);
    expect(result).toEqual(['line1', 'line2']);
  });

  it('returns [] on Redis error', async () => {
    const redis = makeMockRedis({
      lLen: vi.fn().mockRejectedValue(new Error('fail')),
    });
    expect(await pollNewOutput(redis, 'job', outputLengths)).toEqual([]);
  });
});

// ── getSwarms ─────────────────────────────────────────────────────────────────

describe('getSwarms', () => {
  it('returns empty array when no swarm keys', async () => {
    const redis = makeMockRedis({ keys: vi.fn().mockResolvedValue([]) });
    expect(await getSwarms(redis)).toEqual([]);
  });

  it('returns [] on Redis error', async () => {
    const redis = makeMockRedis({ keys: vi.fn().mockRejectedValue(new Error('fail')) });
    expect(await getSwarms(redis)).toEqual([]);
  });

  it('skips keys with null values', async () => {
    const redis = makeMockRedis({
      keys: vi.fn().mockResolvedValue(['cca:swarm:abc']),
      get: vi.fn().mockResolvedValue(null),
    });
    expect(await getSwarms(redis)).toEqual([]);
  });

  it('skips keys with invalid JSON', async () => {
    const redis = makeMockRedis({
      keys: vi.fn().mockResolvedValue(['cca:swarm:abc']),
      get: vi.fn().mockResolvedValue('{bad}'),
    });
    expect(await getSwarms(redis)).toEqual([]);
  });

  it('skips records without swarm_id field', async () => {
    const redis = makeMockRedis({
      keys: vi.fn().mockResolvedValue(['cca:swarm:requests']),
      get: vi.fn().mockResolvedValue(JSON.stringify([{ goal: 'foo' }])),
    });
    expect(await getSwarms(redis)).toEqual([]);
  });

  it('skips JSON null values (s is falsy)', async () => {
    const redis = makeMockRedis({
      keys: vi.fn().mockResolvedValue(['cca:swarm:null-key']),
      get: vi.fn().mockResolvedValue('null'), // JSON.parse('null') === null
    });
    expect(await getSwarms(redis)).toEqual([]);
  });

  it('returns valid swarm records sorted by created_at desc', async () => {
    const swarm1 = { swarm_id: 's1', created_at: '2024-01-01T00:00:00Z', goal: 'old' };
    const swarm2 = { swarm_id: 's2', created_at: '2024-06-01T00:00:00Z', goal: 'new' };
    const redis = makeMockRedis({
      keys: vi.fn().mockResolvedValue(['cca:swarm:s1', 'cca:swarm:s2']),
      get: vi.fn()
        .mockResolvedValueOnce(JSON.stringify(swarm1))
        .mockResolvedValueOnce(JSON.stringify(swarm2)),
    });
    const result = await getSwarms(redis);
    expect(result).toHaveLength(2);
    // sorted desc by created_at — newer first
    expect(result[0].swarm_id).toBe('s2');
    expect(result[1].swarm_id).toBe('s1');
  });

  it('handles swarms without created_at (treats as epoch 0)', async () => {
    const swarmA = { swarm_id: 'sa', goal: 'no date' };
    const swarmB = { swarm_id: 'sb', created_at: '2024-06-01T00:00:00Z', goal: 'has date' };
    const swarmC = { swarm_id: 'sc', created_at: '2024-01-01T00:00:00Z', goal: 'older date' };
    const redis = makeMockRedis({
      keys: vi.fn().mockResolvedValue(['cca:swarm:sa', 'cca:swarm:sb', 'cca:swarm:sc']),
      get: vi.fn()
        .mockResolvedValueOnce(JSON.stringify(swarmA))
        .mockResolvedValueOnce(JSON.stringify(swarmB))
        .mockResolvedValueOnce(JSON.stringify(swarmC)),
    });
    const result = await getSwarms(redis);
    // sb newest, sc older, sa no-date (epoch 0, oldest)
    expect(result[0].swarm_id).toBe('sb');
    expect(result[1].swarm_id).toBe('sc');
    expect(result[2].swarm_id).toBe('sa');
  });
});

