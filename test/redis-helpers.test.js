/**
 * Unit tests for lib/redis-helpers.js using a mock Redis client.
 * The mock implements only the methods each tested function calls.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  getNamespaces,
  getJobIds,
  fetchJob,
  fetchJobs,
  fetchMetaStatus,
  getOutputTail,
  pollNewOutput,
  getSwarms,
  cleanGhostChatLogs,
} from '../lib/redis-helpers.js';

// ─── Mock helpers ──────────────────────────────────────────────────────────

/**
 * Build a minimal mock Redis client.  Only the methods actually used by the
 * function under test need to be provided; defaults to throwing for anything
 * else so we don't silently swallow unexpected calls.
 */
function mockRedis(overrides = {}) {
  const noop = async () => { throw new Error('unexpected redis call'); };
  return {
    keys:     noop,
    get:      noop,
    lLen:     noop,
    lRange:   noop,
    sMembers: noop,
    del:      noop,
    multi:    () => {
      const cmds = [];
      const pipeline = {
        get: () => pipeline,          // fluent builder
        exec: async () => cmds,       // return accumulated results
      };
      return pipeline;
    },
    ...overrides,
  };
}

// cc-wire key builders (use the same values the real code uses for assertions)
// Imported indirectly via the helper itself — we just need to know the key strings.
import { jobKey, jobIndexKey, metaAgentStatusKey, jobOutputKey, chatLogKey, META_AGENTS_INDEX, swarmKey } from '@gonzih/cc-wire';

// ─── getNamespaces ────────────────────────────────────────────────────────

describe('getNamespaces', () => {
  it('returns empty array when no keys exist', async () => {
    const r = mockRedis({ keys: async () => [] });
    assert.deepEqual(await getNamespaces(r), []);
  });

  it('maps cca:jobs:{ns} keys to namespace strings', async () => {
    // jobIndexKey('money-brain') → 'cca:jobs:money-brain'
    const r = mockRedis({
      keys: async () => [jobIndexKey('money-brain'), jobIndexKey('staging')],
    });
    const ns = await getNamespaces(r);
    assert.ok(ns.includes('money-brain'));
    assert.ok(ns.includes('staging'));
    assert.equal(ns.length, 2);
  });

  it('filters keys that include ":index" (legacy keys)', async () => {
    const r = mockRedis({
      keys: async () => ['cca:jobs:ns1', 'cca:jobs:ns1:index'],
    });
    const ns = await getNamespaces(r);
    assert.equal(ns.length, 1);
  });
});

// ─── getJobIds ────────────────────────────────────────────────────────────

describe('getJobIds', () => {
  it('returns sMembers result for the namespace index key', async () => {
    const ids = ['uuid-1', 'uuid-2'];
    const r = mockRedis({ sMembers: async () => ids });
    assert.deepEqual(await getJobIds(r, 'my-ns'), ids);
  });

  it('returns empty array when namespace has no jobs', async () => {
    const r = mockRedis({ sMembers: async () => [] });
    assert.deepEqual(await getJobIds(r, 'empty-ns'), []);
  });
});

// ─── fetchJob ─────────────────────────────────────────────────────────────

describe('fetchJob', () => {
  it('returns null when Redis has no value for the key', async () => {
    const r = mockRedis({ get: async () => null });
    assert.equal(await fetchJob(r, 'missing-id'), null);
  });

  it('returns null when Redis value is invalid JSON', async () => {
    const r = mockRedis({ get: async () => '{bad json' });
    assert.equal(await fetchJob(r, 'bad-id'), null);
  });

  it('returns the parsed job with _id injected', async () => {
    const job = { id: 'abc', status: 'running', goal: 'fix bug' };
    const r = mockRedis({ get: async () => JSON.stringify(job) });
    const result = await fetchJob(r, 'abc');
    assert.deepEqual(result, { ...job, _id: 'abc' });
  });

  it('injects _id even when job object has no id field', async () => {
    const job = { status: 'done', goal: 'test' };
    const r = mockRedis({ get: async () => JSON.stringify(job) });
    const result = await fetchJob(r, 'xyz');
    assert.equal(result._id, 'xyz');
  });
});

// ─── fetchJobs ────────────────────────────────────────────────────────────

describe('fetchJobs', () => {
  it('returns empty array immediately for empty ids list', async () => {
    const r = mockRedis();
    assert.deepEqual(await fetchJobs(r, []), []);
  });

  it('filters out null pipeline results', async () => {
    // Pipeline returns null for missing keys
    const r = {
      multi: () => {
        const results = [null, JSON.stringify({ id: 'id2', status: 'done' }), null];
        let callCount = 0;
        return {
          get: function() { return this; },
          exec: async () => results,
        };
      },
    };
    const jobs = await fetchJobs(r, ['id1', 'id2', 'id3']);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].id, 'id2');
  });

  it('filters out invalid JSON pipeline results', async () => {
    const r = {
      multi: () => ({
        get: function() { return this; },
        exec: async () => ['{invalid', JSON.stringify({ id: 'ok', status: 'running' })],
      }),
    };
    const jobs = await fetchJobs(r, ['bad', 'ok']);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].id, 'ok');
  });

  it('assigns id from ids param when job.id is missing', async () => {
    const r = {
      multi: () => ({
        get: function() { return this; },
        exec: async () => [JSON.stringify({ status: 'running' })],
      }),
    };
    const jobs = await fetchJobs(r, ['my-id']);
    assert.equal(jobs[0].id, 'my-id');
  });
});

// ─── fetchMetaStatus ──────────────────────────────────────────────────────

describe('fetchMetaStatus', () => {
  it('returns null when key does not exist', async () => {
    const r = mockRedis({ get: async () => null });
    assert.equal(await fetchMetaStatus(r, 'ns'), null);
  });

  it('returns null when Redis throws', async () => {
    const r = mockRedis({ get: async () => { throw new Error('redis down'); } });
    assert.equal(await fetchMetaStatus(r, 'ns'), null);
  });

  it('returns null for invalid JSON', async () => {
    const r = mockRedis({ get: async () => 'not-json' });
    assert.equal(await fetchMetaStatus(r, 'ns'), null);
  });

  it('returns parsed status object', async () => {
    const status = { status: 'running', currentTool: 'Read' };
    const r = mockRedis({ get: async () => JSON.stringify(status) });
    assert.deepEqual(await fetchMetaStatus(r, 'ns'), status);
  });
});

// ─── getOutputTail ────────────────────────────────────────────────────────

describe('getOutputTail', () => {
  it('returns empty array when both Redis and disk fail', async () => {
    const r = mockRedis({
      lLen:   async () => { throw new Error('redis error'); },
      lRange: async () => { throw new Error('redis error'); },
    });
    const lengths = {};
    const result = await getOutputTail(r, 'nonexistent-uuid', lengths);
    assert.deepEqual(result, []);
  });

  it('falls back to disk when Redis lLen returns 0', async () => {
    // Create a real temp log file for this test
    const id = 'fallback-test-id';
    const jobsDir = path.join(os.homedir(), '.cc-agent', 'jobs');
    fs.mkdirSync(jobsDir, { recursive: true });
    const logFile = path.join(jobsDir, `${id}.log`);
    fs.writeFileSync(logFile, 'line1\nline2\nline3\n');

    try {
      const r = mockRedis({ lLen: async () => 0 });
      const lengths = {};
      const lines = await getOutputTail(r, id, lengths);
      assert.ok(lines.includes('line1'));
      assert.ok(lines.includes('line2'));
      assert.ok(lines.includes('line3'));
    } finally {
      fs.unlinkSync(logFile);
    }
  });

  it('returns Redis lines when lLen > 0', async () => {
    const lines = ['line-a', 'line-b', 'line-c'];
    const r = mockRedis({
      lLen:   async () => 3,
      lRange: async () => lines,
    });
    const lengths = {};
    const result = await getOutputTail(r, 'some-id', lengths);
    assert.deepEqual(result, lines);
    assert.equal(lengths['some-id'], 3);
  });

  it('slices to last n lines from Redis', async () => {
    // When len > n, start = len - n; lRange is called with that offset
    const r = mockRedis({
      lLen:   async () => 10,
      lRange: async (key, start, end) => {
        assert.equal(start, 7); // 10 - 3 = 7
        assert.equal(end, -1);
        return ['l8', 'l9', 'l10'];
      },
    });
    const lengths = {};
    await getOutputTail(r, 'id', lengths, 3);
  });

  it('updates outputLengths when reading from disk', async () => {
    const id = 'lengths-update-id';
    const jobsDir = path.join(os.homedir(), '.cc-agent', 'jobs');
    fs.mkdirSync(jobsDir, { recursive: true });
    const logFile = path.join(jobsDir, `${id}.log`);
    fs.writeFileSync(logFile, 'a\nb\nc\n');

    try {
      const r = mockRedis({ lLen: async () => 0 });
      const lengths = {};
      await getOutputTail(r, id, lengths);
      assert.equal(lengths[id], 3);
    } finally {
      fs.unlinkSync(logFile);
    }
  });
});

// ─── pollNewOutput ────────────────────────────────────────────────────────

describe('pollNewOutput', () => {
  it('returns [] on Redis error', async () => {
    const r = mockRedis({ lLen: async () => { throw new Error('down'); } });
    assert.deepEqual(await pollNewOutput(r, 'id', {}), []);
  });

  it('returns [] when len <= prev', async () => {
    const r = mockRedis({ lLen: async () => 5 });
    const lengths = { 'id': 5 };
    assert.deepEqual(await pollNewOutput(r, 'id', lengths), []);
  });

  it('returns [] when len < prev (unexpected Redis shrink)', async () => {
    const r = mockRedis({ lLen: async () => 3 });
    const lengths = { 'id': 5 };
    assert.deepEqual(await pollNewOutput(r, 'id', lengths), []);
  });

  it('returns new lines and updates lengths', async () => {
    const newLines = ['new-line-1', 'new-line-2'];
    const r = mockRedis({
      lLen:   async () => 7,
      lRange: async (key, start, end) => {
        assert.equal(start, 5);
        assert.equal(end, -1);
        return newLines;
      },
    });
    const lengths = { 'id': 5 };
    const result = await pollNewOutput(r, 'id', lengths);
    assert.deepEqual(result, newLines);
    assert.equal(lengths['id'], 7);
  });

  it('treats missing prev length as 0', async () => {
    const r = mockRedis({
      lLen:   async () => 3,
      lRange: async () => ['a', 'b', 'c'],
    });
    const lengths = {};
    const result = await pollNewOutput(r, 'new-id', lengths);
    assert.deepEqual(result, ['a', 'b', 'c']);
  });
});

// ─── getSwarms ────────────────────────────────────────────────────────────

describe('getSwarms', () => {
  it('returns [] when Redis keys() throws', async () => {
    const r = mockRedis({ keys: async () => { throw new Error('redis down'); } });
    assert.deepEqual(await getSwarms(r), []);
  });

  it('returns [] when no swarm keys exist', async () => {
    const r = mockRedis({ keys: async () => [] });
    assert.deepEqual(await getSwarms(r), []);
  });

  it('skips keys with null values', async () => {
    const r = mockRedis({
      keys: async () => ['cca:swarm:abc'],
      get:  async () => null,
    });
    assert.deepEqual(await getSwarms(r), []);
  });

  it('skips keys with invalid JSON', async () => {
    const r = mockRedis({
      keys: async () => ['cca:swarm:abc'],
      get:  async () => '{bad json',
    });
    assert.deepEqual(await getSwarms(r), []);
  });

  it('filters records without swarm_id field', async () => {
    // e.g. cca:swarm:requests is a list key but might be scanned
    const r = mockRedis({
      keys: async () => ['cca:swarm:foo'],
      get:  async () => JSON.stringify({ goal: 'test', status: 'running' }), // no swarm_id
    });
    assert.deepEqual(await getSwarms(r), []);
  });

  it('returns valid swarm records', async () => {
    const swarm = { swarm_id: 's1', goal: 'refactor', status: 'running', created_at: '2024-01-01T00:00:00Z' };
    const r = mockRedis({
      keys: async () => ['cca:swarm:s1'],
      get:  async () => JSON.stringify(swarm),
    });
    const result = await getSwarms(r);
    assert.equal(result.length, 1);
    assert.equal(result[0].swarm_id, 's1');
  });

  it('sorts swarms newest-first by created_at', async () => {
    const calls = {};
    const swarms = {
      'cca:swarm:old': { swarm_id: 'old', created_at: '2024-01-01T00:00:00Z' },
      'cca:swarm:new': { swarm_id: 'new', created_at: '2024-06-01T00:00:00Z' },
    };
    const r = mockRedis({
      keys: async () => Object.keys(swarms),
      get:  async (key) => JSON.stringify(swarms[key]),
    });
    const result = await getSwarms(r);
    assert.equal(result[0].swarm_id, 'new');
    assert.equal(result[1].swarm_id, 'old');
  });

  it('handles mix of valid and invalid records gracefully', async () => {
    let callCount = 0;
    const r = mockRedis({
      keys: async () => ['cca:swarm:ok', 'cca:swarm:bad', 'cca:swarm:noid'],
      get:  async (key) => {
        if (key.includes('ok'))   return JSON.stringify({ swarm_id: 'ok', created_at: '2024-01-01Z' });
        if (key.includes('bad'))  return '{invalid json}';
        if (key.includes('noid')) return JSON.stringify({ goal: 'no id field' });
        return null;
      },
    });
    const result = await getSwarms(r);
    assert.equal(result.length, 1);
    assert.equal(result[0].swarm_id, 'ok');
  });

  it('handles swarms with missing created_at (sorts to end)', async () => {
    const swarms = {
      'cca:swarm:dated':   { swarm_id: 'dated',   created_at: '2024-06-01Z' },
      'cca:swarm:nodated': { swarm_id: 'nodated' },
    };
    const r = mockRedis({
      keys: async () => Object.keys(swarms),
      get:  async (key) => JSON.stringify(swarms[key]),
    });
    const result = await getSwarms(r);
    assert.equal(result.length, 2);
    assert.equal(result[0].swarm_id, 'dated'); // most recent first
  });
});

// ─── cleanGhostChatLogs ──────────────────────────────────────────────────

describe('cleanGhostChatLogs', () => {
  it('does nothing when there are no chat log keys', async () => {
    let delCalled = false;
    const r = mockRedis({
      keys:     async () => [],
      sMembers: async () => [],
      del:      async () => { delCalled = true; },
    });
    await cleanGhostChatLogs(r);
    assert.ok(!delCalled);
  });

  it('skips the "default" namespace key', async () => {
    let delCalled = false;
    const r = mockRedis({
      keys:     async () => [chatLogKey('default')],
      sMembers: async () => [],
      del:      async () => { delCalled = true; },
    });
    await cleanGhostChatLogs(r);
    assert.ok(!delCalled);
  });

  it('skips namespace keys that do not contain a slash', async () => {
    // Non-owner/repo format (e.g. "money-brain") — should not be deleted
    let delCalled = false;
    const r = mockRedis({
      keys:     async () => [chatLogKey('money-brain')],
      sMembers: async () => [],
      del:      async () => { delCalled = true; },
    });
    await cleanGhostChatLogs(r);
    assert.ok(!delCalled);
  });

  it('deletes owner/repo format keys NOT in the canonical registry', async () => {
    let deleted = [];
    const r = mockRedis({
      keys:     async () => [chatLogKey('gonzih/ghost-repo')],
      sMembers: async () => [], // canonical registry is empty
      del:      async (key) => { deleted.push(key); },
    });
    await cleanGhostChatLogs(r);
    assert.equal(deleted.length, 1);
    assert.ok(deleted[0].includes('gonzih'));
  });

  it('does NOT delete owner/repo keys that ARE in the canonical registry', async () => {
    let deleted = [];
    const r = mockRedis({
      keys:     async () => [chatLogKey('gonzih/cc-agent')],
      sMembers: async () => ['gonzih/cc-agent'],
      del:      async (key) => { deleted.push(key); },
    });
    await cleanGhostChatLogs(r);
    assert.equal(deleted.length, 0);
  });

  it('handles Redis error gracefully (does not throw)', async () => {
    const r = mockRedis({ keys: async () => { throw new Error('redis down'); } });
    await assert.doesNotReject(() => cleanGhostChatLogs(r));
  });
});
