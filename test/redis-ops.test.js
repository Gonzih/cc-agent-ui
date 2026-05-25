import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  getNamespaces,
  getJobIds,
  fetchJob,
  fetchJobs,
  fetchMetaStatus,
  getOutputTail,
  pollNewOutput,
  getSwarms,
} from '../lib/redis-ops.js';

// ── Mock Redis builder ────────────────────────────────────────────────────────

/**
 * Creates a mock Redis client. Any method can be overridden via `overrides`.
 * The pipeline returned by multi() has its `exec` result set by `pipelineResults`.
 */
function makeMockRedis(overrides = {}) {
  return {
    keys:     async ()            => [],
    get:      async ()            => null,
    lLen:     async ()            => 0,
    lRange:   async ()            => [],
    sMembers: async ()            => [],
    multi: () => {
      const pipeline = {
        get:  function() { return this; },
        exec: async () => [],
      };
      return pipeline;
    },
    ...overrides,
  };
}

// ── getNamespaces ─────────────────────────────────────────────────────────────

describe('getNamespaces', () => {
  test('returns empty array when no keys', async () => {
    const redis = makeMockRedis({ keys: async () => [] });
    assert.deepStrictEqual(await getNamespaces(redis), []);
  });

  test('strips the cca:jobs: prefix from each key', async () => {
    const redis = makeMockRedis({
      keys: async () => ['cca:jobs:money-brain', 'cca:jobs:default'],
    });
    const result = await getNamespaces(redis);
    assert.ok(result.includes('money-brain'));
    assert.ok(result.includes('default'));
  });

  test('filters out keys that contain ":index"', async () => {
    const redis = makeMockRedis({
      keys: async () => ['cca:jobs:money-brain', 'cca:jobs:index:something'],
    });
    const result = await getNamespaces(redis);
    assert.ok(result.includes('money-brain'));
    assert.strictEqual(result.length, 1);
  });
});

// ── getJobIds ─────────────────────────────────────────────────────────────────

describe('getJobIds', () => {
  test('returns ids from Redis set', async () => {
    const redis = makeMockRedis({
      sMembers: async () => ['id1', 'id2', 'id3'],
    });
    const result = await getJobIds(redis, 'money-brain');
    assert.deepStrictEqual(result, ['id1', 'id2', 'id3']);
  });

  test('returns empty array when set is empty', async () => {
    const redis = makeMockRedis({ sMembers: async () => [] });
    const result = await getJobIds(redis, 'empty-ns');
    assert.deepStrictEqual(result, []);
  });
});

// ── fetchJob ──────────────────────────────────────────────────────────────────

describe('fetchJob', () => {
  test('returns null when key does not exist', async () => {
    const redis = makeMockRedis({ get: async () => null });
    assert.strictEqual(await fetchJob(redis, 'missing'), null);
  });

  test('returns null when JSON is invalid', async () => {
    const redis = makeMockRedis({ get: async () => 'not-json' });
    assert.strictEqual(await fetchJob(redis, 'bad'), null);
  });

  test('returns parsed job object with _id attached', async () => {
    const redis = makeMockRedis({
      get: async () => JSON.stringify({ id: 'abc', status: 'running' }),
    });
    const result = await fetchJob(redis, 'abc');
    assert.strictEqual(result._id, 'abc');
    assert.strictEqual(result.status, 'running');
  });

  test('attaches _id even when job JSON has no id field', async () => {
    const redis = makeMockRedis({
      get: async () => JSON.stringify({ status: 'done' }),
    });
    const result = await fetchJob(redis, 'injected-id');
    assert.strictEqual(result._id, 'injected-id');
  });
});

// ── fetchJobs ─────────────────────────────────────────────────────────────────

describe('fetchJobs', () => {
  test('returns empty array for empty ids list', async () => {
    const redis = makeMockRedis();
    assert.deepStrictEqual(await fetchJobs(redis, []), []);
  });

  test('returns parsed jobs from pipeline results', async () => {
    const job1 = { id: 'id1', status: 'running' };
    const job2 = { id: 'id2', status: 'done' };
    const redis = makeMockRedis({
      multi: () => ({
        get:  function() { return this; },
        exec: async () => [JSON.stringify(job1), JSON.stringify(job2)],
      }),
    });
    const result = await fetchJobs(redis, ['id1', 'id2']);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].id, 'id1');
    assert.strictEqual(result[1].id, 'id2');
  });

  test('filters out null pipeline results', async () => {
    const redis = makeMockRedis({
      multi: () => ({
        get:  function() { return this; },
        exec: async () => [JSON.stringify({ id: 'id1', status: 'running' }), null],
      }),
    });
    const result = await fetchJobs(redis, ['id1', 'id2']);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].id, 'id1');
  });

  test('filters out invalid JSON in pipeline results', async () => {
    const redis = makeMockRedis({
      multi: () => ({
        get:  function() { return this; },
        exec: async () => ['bad-json', JSON.stringify({ id: 'id2', status: 'done' })],
      }),
    });
    const result = await fetchJobs(redis, ['id1', 'id2']);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].id, 'id2');
  });

  test('uses ids[i] as fallback when job JSON has no id field', async () => {
    const redis = makeMockRedis({
      multi: () => ({
        get:  function() { return this; },
        exec: async () => [JSON.stringify({ status: 'running' })],
      }),
    });
    const result = await fetchJobs(redis, ['fallback-id']);
    assert.strictEqual(result[0].id, 'fallback-id');
  });

  test('preserves id from job JSON when present', async () => {
    const redis = makeMockRedis({
      multi: () => ({
        get:  function() { return this; },
        exec: async () => [JSON.stringify({ id: 'from-json', status: 'done' })],
      }),
    });
    const result = await fetchJobs(redis, ['other-id']);
    assert.strictEqual(result[0].id, 'from-json');
  });
});

// ── fetchMetaStatus ───────────────────────────────────────────────────────────

describe('fetchMetaStatus', () => {
  test('returns null when key does not exist', async () => {
    const redis = makeMockRedis({ get: async () => null });
    assert.strictEqual(await fetchMetaStatus(redis, 'test-ns'), null);
  });

  test('returns parsed status object', async () => {
    const status = { status: 'running', currentTool: 'Read' };
    const redis = makeMockRedis({ get: async () => JSON.stringify(status) });
    assert.deepStrictEqual(await fetchMetaStatus(redis, 'test-ns'), status);
  });

  test('returns null when Redis throws', async () => {
    const redis = makeMockRedis({ get: async () => { throw new Error('conn error'); } });
    assert.strictEqual(await fetchMetaStatus(redis, 'ns'), null);
  });

  test('returns null when JSON is invalid', async () => {
    const redis = makeMockRedis({ get: async () => 'not-json' });
    // JSON.parse throws → caught by try/catch → returns null
    assert.strictEqual(await fetchMetaStatus(redis, 'ns'), null);
  });
});

// ── pollNewOutput ─────────────────────────────────────────────────────────────

describe('pollNewOutput', () => {
  test('returns empty array when Redis length equals stored length', async () => {
    const redis = makeMockRedis({ lLen: async () => 5 });
    const outputLengths = { job1: 5 };
    assert.deepStrictEqual(await pollNewOutput(redis, outputLengths, 'job1'), []);
  });

  test('returns empty array when Redis length is less than stored (should not happen, but safe)', async () => {
    const redis = makeMockRedis({ lLen: async () => 3 });
    const outputLengths = { job1: 5 };
    assert.deepStrictEqual(await pollNewOutput(redis, outputLengths, 'job1'), []);
  });

  test('returns new lines and updates outputLengths', async () => {
    const redis = makeMockRedis({
      lLen:   async () => 7,
      lRange: async () => ['line6', 'line7'],
    });
    const outputLengths = { job1: 5 };
    const result = await pollNewOutput(redis, outputLengths, 'job1');
    assert.deepStrictEqual(result, ['line6', 'line7']);
    assert.strictEqual(outputLengths.job1, 7);
  });

  test('defaults prev offset to 0 when job not in outputLengths', async () => {
    const redis = makeMockRedis({
      lLen:   async () => 3,
      lRange: async () => ['a', 'b', 'c'],
    });
    const outputLengths = {};
    const result = await pollNewOutput(redis, outputLengths, 'new-job');
    assert.deepStrictEqual(result, ['a', 'b', 'c']);
    assert.strictEqual(outputLengths['new-job'], 3);
  });

  test('returns empty array and does not throw when Redis throws', async () => {
    const redis = makeMockRedis({ lLen: async () => { throw new Error('redis down'); } });
    const outputLengths = {};
    assert.deepStrictEqual(await pollNewOutput(redis, outputLengths, 'job1'), []);
  });
});

// ── getOutputTail ─────────────────────────────────────────────────────────────

describe('getOutputTail', () => {
  test('returns lines from Redis when list is non-empty', async () => {
    const lines = ['line1', 'line2', 'line3'];
    const redis = makeMockRedis({
      lLen:   async () => 3,
      lRange: async () => lines,
    });
    const outputLengths = {};
    const result = await getOutputTail(redis, outputLengths, 'job1', 150);
    assert.deepStrictEqual(result, lines);
    assert.strictEqual(outputLengths.job1, 3);
  });

  test('returns empty array when Redis list is empty and no disk file', async () => {
    const redis = makeMockRedis({ lLen: async () => 0 });
    const outputLengths = {};
    const result = await getOutputTail(redis, outputLengths, 'no-such-job-xyz-9999', 150);
    assert.deepStrictEqual(result, []);
  });

  test('uses correct start offset when list has more lines than n', async () => {
    let capturedStart = null;
    const redis = makeMockRedis({
      lLen:   async () => 200,
      lRange: async (key, start, end) => { capturedStart = start; return []; },
    });
    const outputLengths = {};
    await getOutputTail(redis, outputLengths, 'job1', 150);
    // 200 - 150 = 50
    assert.strictEqual(capturedStart, 50);
  });

  test('updates outputLengths with current list length', async () => {
    const redis = makeMockRedis({
      lLen:   async () => 42,
      lRange: async () => [],
    });
    const outputLengths = {};
    await getOutputTail(redis, outputLengths, 'job1', 150);
    assert.strictEqual(outputLengths.job1, 42);
  });

  test('returns empty array when Redis throws', async () => {
    const redis = makeMockRedis({ lLen: async () => { throw new Error('timeout'); } });
    const outputLengths = {};
    const result = await getOutputTail(redis, outputLengths, 'job1', 150);
    assert.deepStrictEqual(result, []);
  });
});

// ── getSwarms ─────────────────────────────────────────────────────────────────

describe('getSwarms', () => {
  test('returns empty array when no keys', async () => {
    const redis = makeMockRedis({ keys: async () => [] });
    assert.deepStrictEqual(await getSwarms(redis), []);
  });

  test('returns empty array when Redis throws', async () => {
    const redis = makeMockRedis({ keys: async () => { throw new Error('conn'); } });
    assert.deepStrictEqual(await getSwarms(redis), []);
  });

  test('returns empty array when all keys have null values', async () => {
    const redis = makeMockRedis({
      keys: async () => ['cca:swarm:abc'],
      get:  async () => null,
    });
    assert.deepStrictEqual(await getSwarms(redis), []);
  });

  test('filters out records without swarm_id field', async () => {
    const redis = makeMockRedis({
      keys: async () => ['cca:swarm:requests'],
      get:  async () => JSON.stringify({ type: 'request_list' }),
    });
    assert.deepStrictEqual(await getSwarms(redis), []);
  });

  test('filters out invalid JSON values', async () => {
    const redis = makeMockRedis({
      keys: async () => ['cca:swarm:bad'],
      get:  async () => 'not-json',
    });
    assert.deepStrictEqual(await getSwarms(redis), []);
  });

  test('returns valid swarm records', async () => {
    const swarm = { swarm_id: 'abc123', goal: 'ship it', created_at: '2024-01-01T00:00:00Z' };
    const redis = makeMockRedis({
      keys: async () => ['cca:swarm:abc123'],
      get:  async () => JSON.stringify(swarm),
    });
    const result = await getSwarms(redis);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].swarm_id, 'abc123');
  });

  test('sorts swarms by created_at descending (newest first)', async () => {
    const data = {
      'cca:swarm:old': { swarm_id: 'old', created_at: '2024-01-01T00:00:00Z' },
      'cca:swarm:new': { swarm_id: 'new', created_at: '2024-06-01T00:00:00Z' },
    };
    const redis = makeMockRedis({
      keys: async () => Object.keys(data),
      get:  async (key) => JSON.stringify(data[key]),
    });
    const result = await getSwarms(redis);
    assert.strictEqual(result[0].swarm_id, 'new');
    assert.strictEqual(result[1].swarm_id, 'old');
  });

  test('mixes valid and invalid records — returns only valid ones', async () => {
    const data = {
      'cca:swarm:good': { swarm_id: 'good', created_at: '2024-01-01T00:00:00Z' },
      'cca:swarm:noid': { goal: 'no swarm_id here' },
      'cca:swarm:null': null,
    };
    const redis = makeMockRedis({
      keys: async () => Object.keys(data),
      get:  async (key) => data[key] ? JSON.stringify(data[key]) : null,
    });
    const result = await getSwarms(redis);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].swarm_id, 'good');
  });

  test('handles missing created_at — sorts those to the end', async () => {
    const data = {
      'cca:swarm:dated':   { swarm_id: 'dated',   created_at: '2024-06-01T00:00:00Z' },
      'cca:swarm:undated': { swarm_id: 'undated' },
    };
    const redis = makeMockRedis({
      keys: async () => Object.keys(data),
      get:  async (key) => JSON.stringify(data[key]),
    });
    const result = await getSwarms(redis);
    // new Date(0) = epoch, so undated sorts last
    assert.strictEqual(result[0].swarm_id, 'dated');
    assert.strictEqual(result[1].swarm_id, 'undated');
  });
});
