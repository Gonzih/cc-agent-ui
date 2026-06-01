/**
 * Data access tests for cc-agent-ui server.js.
 *
 * Strategy:
 *   - Mock the `redis` npm module so no real Redis is required.
 *   - Dynamically import server.js (side-effecting) in beforeAll so it starts
 *     on TEST_PORT with the mocked client.
 *   - Each domain (jobs, crons, swarms, chat, meta-agents…) gets its own
 *     describe block.  beforeEach resets the Redis store and call history.
 *
 * Redis key constants are imported directly from @gonzih/cc-wire so the tests
 * stay in sync with the server without duplicating string literals.
 */

import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

// ── Mock must be declared before any imports that transitively load redis ──
vi.mock('redis', () => ({
  createClient: vi.fn(),
}));

import { createClient }       from 'redis';
import { createMockRedis }    from './helpers/redis-mock.js';
import {
  META_AGENTS_INDEX,
  CC_AGENT_VERSION_KEY,
  CC_TG_VERSION_KEY,
  SWARM_REQUESTS_KEY,
  jobKey,
  jobOutputKey,
  jobSignalKey,
  jobInputKey,
  cronsKey,
  chatLogKey,
  chatIncomingChannel,
  metaKey,
  metaInputKey,
  metaAgentStatusKey,
  swarmKey,
} from '@gonzih/cc-wire';

// ── Configuration ──────────────────────────────────────────────────────────
const TEST_PORT = 7798;
const TEST_NS   = 'test-ns';

// Set env BEFORE server.js is imported (server reads these at module level).
// CC_AGENT_NAMESPACE takes precedence over NAMESPACE in server.js (line 44),
// so we must override both to ensure the test namespace is used.
process.env.PORT               = String(TEST_PORT);
process.env.CC_AGENT_NAMESPACE = TEST_NS;
process.env.NAMESPACE          = TEST_NS;

// Create singleton mock and wire it up to the mocked createClient
const mockRedis = createMockRedis();
createClient.mockReturnValue(mockRedis);

// ── HTTP helper ────────────────────────────────────────────────────────────
async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res  = await fetch(`http://localhost:${TEST_PORT}${path}`, opts);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { /* leave json undefined */ }
  return { status: res.status, body: json ?? text, headers: res.headers };
}

// ── Server startup ─────────────────────────────────────────────────────────
let _server;
beforeAll(async () => {
  // Dynamic import ensures all mocks above are applied first.
  // server.js skips listen() when NODE_ENV=test (vitest sets this), so we
  // call it manually to get deterministic startup with the right port.
  const mod = await import('../server.js');
  _server = mod.server;
  await new Promise(r => _server.listen(TEST_PORT, '127.0.0.1', r));
}, 25000);

afterAll(async () => {
  _server?.closeAllConnections?.();
  await new Promise(r => (_server?.close(r) ?? r()));
});

// Reset Redis state between tests so each test is independent
beforeEach(() => {
  mockRedis._reset();
});

// ══════════════════════════════════════════════════════════════════════════════
// Job output  (getOutputTail via GET /api/job/output)
// ══════════════════════════════════════════════════════════════════════════════
describe('GET /api/job/output', () => {
  const id = 'aabbccdd-0000-1111-2222-333344445555';

  it('returns 400 when id is missing', async () => {
    const { status } = await api('GET', '/api/job/output');
    expect(status).toBe(400);
  });

  it('returns empty lines when Redis list is empty and no log file', async () => {
    const { status, body } = await api('GET', `/api/job/output?id=${id}`);
    expect(status).toBe(200);
    expect(body.lines).toEqual([]);
  });

  it('returns all lines when list is within tail limit', async () => {
    const lines = ['line A', 'line B', 'line C'];
    mockRedis._seedList(jobOutputKey(id), lines);

    const { status, body } = await api('GET', `/api/job/output?id=${id}`);
    expect(status).toBe(200);
    expect(body.lines).toEqual(lines);
  });

  it('reads from Redis using lLen + lRange (verifies data access pattern)', async () => {
    mockRedis._seedList(jobOutputKey(id), ['x', 'y']);
    await api('GET', `/api/job/output?id=${id}`);

    const lLenCall  = mockRedis._calls.find(c => c.op === 'lLen'  && c.key === jobOutputKey(id));
    const lRangeCall = mockRedis._calls.find(c => c.op === 'lRange' && c.key === jobOutputKey(id));
    expect(lLenCall).toBeDefined();
    expect(lRangeCall).toBeDefined();
  });

  it('returns last N lines when list exceeds tail limit', async () => {
    // Server fetches 5000 lines max for this endpoint
    const manyLines = Array.from({ length: 6000 }, (_, i) => `line ${i}`);
    mockRedis._seedList(jobOutputKey(id), manyLines);

    const { status, body } = await api('GET', `/api/job/output?id=${id}`);
    expect(status).toBe(200);
    // Should return the last 5000
    expect(body.lines.length).toBe(5000);
    expect(body.lines[0]).toBe('line 1000'); // 6000 - 5000
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Job actions  (POST /api/job/action)
// ══════════════════════════════════════════════════════════════════════════════
describe('POST /api/job/action', () => {
  const id  = 'job-1111-2222-3333-444455556666';
  const job = { id, status: 'running', namespace: TEST_NS, goal: 'test goal' };

  beforeEach(() => {
    mockRedis._seed(jobKey(id), JSON.stringify(job));
  });

  it('returns 400 when id is missing', async () => {
    const { status } = await api('POST', '/api/job/action', { action: 'cancel' });
    expect(status).toBe(400);
  });

  it('returns 400 when action is missing', async () => {
    const { status } = await api('POST', '/api/job/action', { id });
    expect(status).toBe(400);
  });

  it('returns 404 when job does not exist in Redis', async () => {
    const { status } = await api('POST', '/api/job/action', { id: 'nonexistent', action: 'cancel' });
    expect(status).toBe(404);
  });

  describe('cancel', () => {
    it('sets signal key to "cancel"', async () => {
      const { status, body } = await api('POST', '/api/job/action', { id, action: 'cancel' });
      expect(status).toBe(200);
      expect(body.ok).toBe(true);

      const setCall = mockRedis._calls.find(
        c => c.op === 'set' && c.key === jobSignalKey(id)
      );
      expect(setCall).toBeDefined();
      expect(setCall.value).toBe('cancel');
    });
  });

  describe('wake', () => {
    it('sets signal key to "wake"', async () => {
      const { status, body } = await api('POST', '/api/job/action', { id, action: 'wake' });
      expect(status).toBe(200);
      expect(body.ok).toBe(true);

      const setCall = mockRedis._calls.find(
        c => c.op === 'set' && c.key === jobSignalKey(id)
      );
      expect(setCall).toBeDefined();
      expect(setCall.value).toBe('wake');
    });
  });

  describe('message', () => {
    it('pushes message to job input queue', async () => {
      const message = 'Hello from UI';
      const { status, body } = await api('POST', '/api/job/action', { id, action: 'message', message });
      expect(status).toBe(200);
      expect(body.ok).toBe(true);

      const inputPush = mockRedis._calls.find(
        c => c.op === 'rPush' && c.key === jobInputKey(id)
      );
      expect(inputPush).toBeDefined();
      expect(inputPush.values).toContain(message);
    });

    it('also echoes message to job output list', async () => {
      await api('POST', '/api/job/action', { id, action: 'message', message: 'echo me' });

      const outputPush = mockRedis._calls.find(
        c => c.op === 'rPush' && c.key === jobOutputKey(id)
      );
      expect(outputPush).toBeDefined();
      expect(outputPush.values[0]).toContain('echo me');
    });

    it('ignores empty message', async () => {
      const { status } = await api('POST', '/api/job/action', { id, action: 'message', message: '' });
      // Empty message — server skips the rPush
      expect(status).toBe(200);
      const inputPush = mockRedis._calls.find(
        c => c.op === 'rPush' && c.key === jobInputKey(id)
      );
      expect(inputPush).toBeUndefined();
    });
  });

  describe('approve', () => {
    const pendingJob = { id, status: 'pending_approval', namespace: TEST_NS, goal: 'approve me' };

    beforeEach(() => {
      mockRedis._seed(jobKey(id), JSON.stringify(pendingJob));
    });

    it('writes updated job with approved=true to Redis', async () => {
      const { status, body } = await api('POST', '/api/job/action', { id, action: 'approve' });
      expect(status).toBe(200);
      expect(body.ok).toBe(true);

      const setCall = mockRedis._calls.find(
        c => c.op === 'set' && c.key === jobKey(id)
      );
      expect(setCall).toBeDefined();
      const stored = JSON.parse(setCall.value);
      expect(stored.approved).toBe(true);
      expect(stored.approvedAt).toBeDefined();
    });

    it('appends approval notice to job output list', async () => {
      await api('POST', '/api/job/action', { id, action: 'approve' });

      const outputPush = mockRedis._calls.find(
        c => c.op === 'rPush' && c.key === jobOutputKey(id)
      );
      expect(outputPush).toBeDefined();
      expect(outputPush.values[0]).toContain('Approved');
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Crons — GET /crons
// ══════════════════════════════════════════════════════════════════════════════
describe('GET /crons', () => {
  it('returns empty array when Redis key is absent', async () => {
    // mockRedis returns null for missing keys
    const { status, body } = await api('GET', '/crons');
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('reads from correct namespace key', async () => {
    await api('GET', '/crons');
    const getCall = mockRedis._calls.find(c => c.op === 'get' && c.key === cronsKey(TEST_NS));
    expect(getCall).toBeDefined();
  });

  it('returns stored cron array', async () => {
    const crons = [
      { id: 'c1', prompt: 'p1', schedule: '0 0 * * *', intervalMs: 3600000, chatId: 0, repoUrl: '', createdAt: '2024-01-01T00:00:00Z' },
      { id: 'c2', prompt: 'p2', schedule: 'manual',    intervalMs: 3600000, chatId: 0, repoUrl: '', createdAt: '2024-01-02T00:00:00Z' },
    ];
    mockRedis._seed(cronsKey(TEST_NS), JSON.stringify(crons));

    const { status, body } = await api('GET', '/crons');
    expect(status).toBe(200);
    expect(body).toHaveLength(2);
    expect(body[0].id).toBe('c1');
    expect(body[1].id).toBe('c2');
  });

  it('handles malformed JSON in Redis without crashing', async () => {
    mockRedis._seed(cronsKey(TEST_NS), '{not valid json}');
    const { status } = await api('GET', '/crons');
    // Server catches the JSON parse error and returns 500
    expect([200, 500]).toContain(status);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Crons — POST /crons
// ══════════════════════════════════════════════════════════════════════════════
describe('POST /crons', () => {
  it('returns 201 and the new cron object', async () => {
    const { status, body } = await api('POST', '/crons', {
      prompt:   'Run daily report',
      schedule: '0 9 * * *',
    });
    expect(status).toBe(201);
    expect(body.id).toBeDefined();
    expect(body.prompt).toBe('Run daily report');
    expect(body.schedule).toBe('0 9 * * *');
    expect(body.createdAt).toBeDefined();
  });

  it('persists cron to Redis', async () => {
    await api('POST', '/crons', { prompt: 'persist me', schedule: 'manual' });

    const setCall = mockRedis._calls.find(c => c.op === 'set' && c.key === cronsKey(TEST_NS));
    expect(setCall).toBeDefined();
    const stored = JSON.parse(setCall.value);
    expect(stored).toHaveLength(1);
    expect(stored[0].prompt).toBe('persist me');
  });

  it('appends to existing crons', async () => {
    const existing = [{ id: 'existing', prompt: 'old', schedule: 'manual', intervalMs: 3600000, chatId: 0, repoUrl: '', createdAt: '2024-01-01T00:00:00Z' }];
    mockRedis._seed(cronsKey(TEST_NS), JSON.stringify(existing));

    await api('POST', '/crons', { prompt: 'new cron', schedule: 'manual' });

    const setCall = mockRedis._calls.find(c => c.op === 'set' && c.key === cronsKey(TEST_NS));
    const stored = JSON.parse(setCall.value);
    expect(stored).toHaveLength(2);
    expect(stored[0].id).toBe('existing'); // original preserved
    expect(stored[1].prompt).toBe('new cron');
  });

  it('uses provided intervalMs', async () => {
    const { body } = await api('POST', '/crons', { prompt: 'x', intervalMs: 7200000 });
    expect(body.intervalMs).toBe(7200000);
  });

  it('defaults schedule to "manual" when omitted', async () => {
    const { body } = await api('POST', '/crons', { prompt: 'no schedule' });
    expect(body.schedule).toBe('manual');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Crons — DELETE /crons/:id
// ══════════════════════════════════════════════════════════════════════════════
describe('DELETE /crons/:id', () => {
  const cronA = { id: 'keep-me',   prompt: 'keep', schedule: 'manual', intervalMs: 3600000, chatId: 0, repoUrl: '', createdAt: '2024-01-01T00:00:00Z' };
  const cronB = { id: 'delete-me', prompt: 'del',  schedule: 'manual', intervalMs: 3600000, chatId: 0, repoUrl: '', createdAt: '2024-01-02T00:00:00Z' };

  beforeEach(() => {
    mockRedis._seed(cronsKey(TEST_NS), JSON.stringify([cronA, cronB]));
  });

  it('removes the specified cron and persists the remainder', async () => {
    const { status, body } = await api('DELETE', '/crons/delete-me');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);

    const setCall = mockRedis._calls.find(c => c.op === 'set' && c.key === cronsKey(TEST_NS));
    expect(setCall).toBeDefined();
    const stored = JSON.parse(setCall.value);
    expect(stored).toHaveLength(1);
    expect(stored[0].id).toBe('keep-me');
  });

  it('does not remove other crons when id does not match', async () => {
    await api('DELETE', '/crons/nonexistent');

    const setCall = mockRedis._calls.find(c => c.op === 'set' && c.key === cronsKey(TEST_NS));
    const stored = JSON.parse(setCall.value);
    expect(stored).toHaveLength(2); // nothing removed
  });

  it('writes empty array when the last cron is deleted', async () => {
    mockRedis._seed(cronsKey(TEST_NS), JSON.stringify([cronB]));
    await api('DELETE', '/crons/delete-me');

    const setCall = mockRedis._calls.find(c => c.op === 'set' && c.key === cronsKey(TEST_NS));
    expect(JSON.parse(setCall.value)).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Crons — PATCH /crons/:id
// ══════════════════════════════════════════════════════════════════════════════
describe('PATCH /crons/:id', () => {
  const cron = { id: 'cron-patch', prompt: 'original', schedule: '0 0 * * *', intervalMs: 3600000, chatId: 0, repoUrl: '', createdAt: '2024-01-01T00:00:00Z' };

  beforeEach(() => {
    mockRedis._seed(cronsKey(TEST_NS), JSON.stringify([cron]));
  });

  it('returns 404 when cron id does not exist', async () => {
    const { status } = await api('PATCH', '/crons/no-such-cron', { prompt: 'x' });
    expect(status).toBe(404);
  });

  it('merges updates into existing cron and persists', async () => {
    const { status, body } = await api('PATCH', '/crons/cron-patch', {
      prompt:   'updated prompt',
      schedule: '0 12 * * *',
    });
    expect(status).toBe(200);
    expect(body.id).toBe('cron-patch');
    expect(body.prompt).toBe('updated prompt');
    expect(body.schedule).toBe('0 12 * * *');
    expect(body.intervalMs).toBe(3600000); // unchanged original field

    const setCall = mockRedis._calls.find(c => c.op === 'set' && c.key === cronsKey(TEST_NS));
    const stored = JSON.parse(setCall.value);
    expect(stored[0].prompt).toBe('updated prompt');
    expect(stored[0].intervalMs).toBe(3600000);
  });

  it('id cannot be overridden by patch body', async () => {
    const { body } = await api('PATCH', '/crons/cron-patch', { id: 'hacked', prompt: 'x' });
    expect(body.id).toBe('cron-patch');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Swarms — GET /api/swarms
// ══════════════════════════════════════════════════════════════════════════════
describe('GET /api/swarms', () => {
  it('returns empty array when no swarm keys exist', async () => {
    const { status, body } = await api('GET', '/api/swarms');
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('returns valid swarm records', async () => {
    const s1 = { swarm_id: 's1', goal: 'goal 1', status: 'running', created_at: '2024-01-01T00:00:00Z', sub_job_ids: [] };
    const s2 = { swarm_id: 's2', goal: 'goal 2', status: 'done',    created_at: '2024-01-02T00:00:00Z', sub_job_ids: ['j1'] };
    mockRedis._seed(swarmKey('s1'), JSON.stringify(s1));
    mockRedis._seed(swarmKey('s2'), JSON.stringify(s2));

    const { status, body } = await api('GET', '/api/swarms');
    expect(status).toBe(200);
    expect(body).toHaveLength(2);
  });

  it('sorts swarms by created_at descending (newest first)', async () => {
    const older = { swarm_id: 'old', goal: 'old', created_at: '2024-01-01T00:00:00Z', sub_job_ids: [] };
    const newer = { swarm_id: 'new', goal: 'new', created_at: '2024-06-01T00:00:00Z', sub_job_ids: [] };
    mockRedis._seed(swarmKey('old'), JSON.stringify(older));
    mockRedis._seed(swarmKey('new'), JSON.stringify(newer));

    const { body } = await api('GET', '/api/swarms');
    expect(body[0].swarm_id).toBe('new');
    expect(body[1].swarm_id).toBe('old');
  });

  it('filters out keys without a swarm_id field (e.g. cca:swarm:requests)', async () => {
    // The requests key matches cca:swarm:* but is not a swarm record
    mockRedis._seed(swarmKey('requests'), JSON.stringify({ not_a_swarm: true }));
    const valid = { swarm_id: 'real', goal: 'x', created_at: '2024-01-01T00:00:00Z', sub_job_ids: [] };
    mockRedis._seed(swarmKey('real'), JSON.stringify(valid));

    const { body } = await api('GET', '/api/swarms');
    expect(body).toHaveLength(1);
    expect(body[0].swarm_id).toBe('real');
  });

  it('uses redis.keys() with swarm glob pattern', async () => {
    await api('GET', '/api/swarms');
    const keysCall = mockRedis._calls.find(c => c.op === 'keys' && c.pattern.includes('swarm'));
    expect(keysCall).toBeDefined();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Swarms — POST /api/swarm/trigger
// ══════════════════════════════════════════════════════════════════════════════
describe('POST /api/swarm/trigger', () => {
  it('returns 400 when goal is missing', async () => {
    const { status } = await api('POST', '/api/swarm/trigger', { repoUrl: 'https://github.com/x/y' });
    expect(status).toBe(400);
  });

  it('returns 202 with a generated id', async () => {
    const { status, body } = await api('POST', '/api/swarm/trigger', { goal: 'analyze the codebase' });
    expect(status).toBe(202);
    expect(body.ok).toBe(true);
    expect(body.id).toBeDefined();
  });

  it('queues request to SWARM_REQUESTS_KEY via lPush', async () => {
    await api('POST', '/api/swarm/trigger', { goal: 'fix all bugs', maxAgents: 10 });

    const lPushCall = mockRedis._calls.find(c => c.op === 'lPush' && c.key === SWARM_REQUESTS_KEY);
    expect(lPushCall).toBeDefined();

    const payload = JSON.parse(lPushCall.values[0]);
    expect(payload.goal).toBe('fix all bugs');
    expect(payload.maxAgents).toBe(10);
    expect(payload.id).toBeDefined();
    expect(payload.requestedAt).toBeDefined();
    expect(payload.namespace).toBe(TEST_NS);
  });

  it('clamps maxAgents to [1, 50]', async () => {
    await api('POST', '/api/swarm/trigger', { goal: 'test', maxAgents: 999 });
    const lPushCall = mockRedis._calls.find(c => c.op === 'lPush' && c.key === SWARM_REQUESTS_KEY);
    const payload = JSON.parse(lPushCall.values[0]);
    expect(payload.maxAgents).toBe(50);
  });

  it('defaults maxAgents to 5 when not provided', async () => {
    await api('POST', '/api/swarm/trigger', { goal: 'test' });
    const lPushCall = mockRedis._calls.find(c => c.op === 'lPush' && c.key === SWARM_REQUESTS_KEY);
    const payload = JSON.parse(lPushCall.values[0]);
    expect(payload.maxAgents).toBe(5);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Chat history  (GET /chat/history)
// ══════════════════════════════════════════════════════════════════════════════
describe('GET /chat/history', () => {
  it('returns empty array when no messages exist', async () => {
    const { status, body } = await api('GET', `/chat/history?namespace=${TEST_NS}`);
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('reads from chatLogKey for the given namespace', async () => {
    await api('GET', `/chat/history?namespace=${TEST_NS}`);
    const lRangeCall = mockRedis._calls.find(c => c.op === 'lRange' && c.key === chatLogKey(TEST_NS));
    expect(lRangeCall).toBeDefined();
    // Should read the first 100 entries (LIFO list)
    expect(lRangeCall.start).toBe(0);
    expect(lRangeCall.stop).toBe(99);
  });

  it('reverses LIFO storage so result is chronological (oldest first)', async () => {
    // Redis stores LIFO: index 0 = newest
    const storedLIFO = [
      JSON.stringify({ id: 'm3', role: 'assistant', content: 'newest', timestamp: '2024-01-03T00:00:00Z' }),
      JSON.stringify({ id: 'm2', role: 'user',      content: 'middle', timestamp: '2024-01-02T00:00:00Z' }),
      JSON.stringify({ id: 'm1', role: 'user',      content: 'oldest', timestamp: '2024-01-01T00:00:00Z' }),
    ];
    mockRedis._seedList(chatLogKey(TEST_NS), storedLIFO);

    const { body } = await api('GET', `/chat/history?namespace=${TEST_NS}`);
    expect(body).toHaveLength(3);
    // After .reverse(), oldest should be first
    expect(body[0].id).toBe('m1');
    expect(body[2].id).toBe('m3');
  });

  it('falls back to NAMESPACE when namespace param is omitted', async () => {
    mockRedis._seedList(
      chatLogKey(TEST_NS),
      [JSON.stringify({ id: 'x', role: 'user', content: 'hi', timestamp: '2024-01-01T00:00:00Z' })]
    );
    const { body } = await api('GET', '/chat/history');
    // Should still use TEST_NS (the server-level default)
    expect(body).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Chat send  (POST /chat/send)
// ══════════════════════════════════════════════════════════════════════════════
describe('POST /chat/send', () => {
  it('publishes to chatIncomingChannel when no meta-agent is running', async () => {
    // metaAgentStatusKey returns null → no running meta-agent
    const { status, body } = await api('POST', '/chat/send', {
      namespace: TEST_NS,
      message:   'Hello world',
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.id).toBeDefined();

    const pubCall = mockRedis._calls.find(
      c => c.op === 'publish' && c.channel === chatIncomingChannel(TEST_NS)
    );
    expect(pubCall).toBeDefined();
    const payload = JSON.parse(pubCall.message);
    expect(payload.content).toBe('Hello world');
    expect(payload.source).toBe('ui');
    expect(payload.role).toBe('user');
  });

  it('routes to meta-agent input queue when meta-agent is running', async () => {
    mockRedis._seed(
      metaAgentStatusKey(TEST_NS),
      JSON.stringify({ status: 'running', currentTool: null })
    );

    await api('POST', '/chat/send', { namespace: TEST_NS, message: 'agent msg' });

    const lPushCall = mockRedis._calls.find(
      c => c.op === 'lPush' && c.key === metaInputKey(TEST_NS)
    );
    expect(lPushCall).toBeDefined();
    const entry = JSON.parse(lPushCall.values[0]);
    expect(entry.content).toBe('agent msg');
    expect(entry.id).toBeDefined();
  });

  it('checks metaAgentStatusKey to decide routing', async () => {
    await api('POST', '/chat/send', { namespace: TEST_NS, message: 'x' });

    const getCall = mockRedis._calls.find(
      c => c.op === 'get' && c.key === metaAgentStatusKey(TEST_NS)
    );
    expect(getCall).toBeDefined();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Meta-agents — GET /api/meta-agents
// ══════════════════════════════════════════════════════════════════════════════
describe('GET /api/meta-agents', () => {
  it('returns empty array when registry is empty', async () => {
    const { status, body } = await api('GET', '/api/meta-agents');
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('reads from META_AGENTS_INDEX set', async () => {
    await api('GET', '/api/meta-agents');
    const sMembersCall = mockRedis._calls.find(
      c => c.op === 'sMembers' && c.key === META_AGENTS_INDEX
    );
    expect(sMembersCall).toBeDefined();
  });

  it('returns agents with state and chat log count', async () => {
    const ns    = 'my-agent';
    const state = { namespace: ns, status: 'idle', repoUrl: 'https://github.com/x/y', cwd: '/tmp/x' };
    mockRedis._seedSet(META_AGENTS_INDEX, [ns]);
    mockRedis._seed(metaKey(ns), JSON.stringify(state));
    mockRedis._seedList(chatLogKey(ns), [
      JSON.stringify({ id: 'm1', role: 'user', content: 'hi', timestamp: '2024-01-01T00:00:00Z' }),
    ]);

    const { status, body } = await api('GET', '/api/meta-agents');
    expect(status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0].namespace).toBe(ns);
    expect(body[0].count).toBe(1); // chat log length
  });

  it('skips "default" namespace from the registry', async () => {
    mockRedis._seedSet(META_AGENTS_INDEX, ['default', 'real-agent']);
    const state = { namespace: 'real-agent', status: 'idle', repoUrl: '', cwd: '' };
    mockRedis._seed(metaKey('real-agent'), JSON.stringify(state));

    const { body } = await api('GET', '/api/meta-agents');
    // Only real-agent should appear
    expect(body.every(a => a.namespace !== 'default')).toBe(true);
  });

  it('skips namespaces without stored state', async () => {
    mockRedis._seedSet(META_AGENTS_INDEX, ['ghost-ns']); // no metaKey seeded

    const { body } = await api('GET', '/api/meta-agents');
    expect(body).toHaveLength(0);
  });

  it('merges live status into agent response', async () => {
    const ns     = 'status-agent';
    const state  = { namespace: ns, status: 'idle', repoUrl: '', cwd: '' };
    const active = { status: 'running', currentTool: 'Bash', typing: false };
    mockRedis._seedSet(META_AGENTS_INDEX, [ns]);
    mockRedis._seed(metaKey(ns), JSON.stringify(state));
    mockRedis._seed(metaAgentStatusKey(ns), JSON.stringify(active));

    const { body } = await api('GET', '/api/meta-agents');
    expect(body[0].currentTool).toBe('Bash');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Meta-chat log — GET /api/meta-chat/log
// ══════════════════════════════════════════════════════════════════════════════
describe('GET /api/meta-chat/log', () => {
  it('returns 400 when ns param is missing', async () => {
    const { status } = await api('GET', '/api/meta-chat/log');
    expect(status).toBe(400);
  });

  it('returns empty array when no messages exist', async () => {
    const { status, body } = await api('GET', `/api/meta-chat/log?ns=${TEST_NS}`);
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('reverses LIFO storage to chronological order', async () => {
    const stored = [
      JSON.stringify({ id: '3', role: 'assistant', content: 'newest' }),
      JSON.stringify({ id: '2', role: 'user',      content: 'middle' }),
      JSON.stringify({ id: '1', role: 'user',      content: 'oldest' }),
    ];
    mockRedis._seedList(chatLogKey(TEST_NS), stored);

    const { body } = await api('GET', `/api/meta-chat/log?ns=${TEST_NS}`);
    expect(body).toHaveLength(3);
    expect(body[0].id).toBe('1'); // oldest first
    expect(body[2].id).toBe('3'); // newest last
  });

  it('filters out malformed (non-JSON) entries', async () => {
    mockRedis._seedList(chatLogKey(TEST_NS), [
      JSON.stringify({ id: 'ok', role: 'user', content: 'valid' }),
      'not-json-at-all',
    ]);

    const { body } = await api('GET', `/api/meta-chat/log?ns=${TEST_NS}`);
    // Only the valid entry should survive
    expect(body.every(m => m && m.id)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Meta-chat send — POST /api/meta-chat/send
// ══════════════════════════════════════════════════════════════════════════════
describe('POST /api/meta-chat/send', () => {
  it('returns 400 when ns is missing', async () => {
    const { status } = await api('POST', '/api/meta-chat/send', { message: 'hi' });
    expect(status).toBe(400);
  });

  it('returns 400 when message is missing', async () => {
    const { status } = await api('POST', '/api/meta-chat/send', { ns: TEST_NS });
    expect(status).toBe(400);
  });

  it('auto-provisions a new namespace (set + sAdd)', async () => {
    const newNs = 'brand-new-agent';
    await api('POST', '/api/meta-chat/send', { ns: newNs, message: 'first message' });

    const setCall = mockRedis._calls.find(c => c.op === 'set' && c.key === metaKey(newNs));
    expect(setCall).toBeDefined();
    const stored = JSON.parse(setCall.value);
    expect(stored.namespace).toBe(newNs);
    expect(stored.status).toBe('idle');
    // Should have been given a 30-day TTL
    expect(setCall.options?.EX).toBe(30 * 24 * 60 * 60);

    const sAddCall = mockRedis._calls.find(c => c.op === 'sAdd' && c.key === META_AGENTS_INDEX);
    expect(sAddCall).toBeDefined();
    expect(sAddCall.values).toContain(newNs);
  });

  it('does not re-provision an already-registered namespace', async () => {
    const ns = 'existing-agent';
    mockRedis._seedSet(META_AGENTS_INDEX, [ns]);

    await api('POST', '/api/meta-chat/send', { ns, message: 'hello' });

    const setCall = mockRedis._calls.find(c => c.op === 'set' && c.key === metaKey(ns));
    expect(setCall).toBeUndefined(); // no re-provisioning
  });

  it('pushes message to canonical input queue', async () => {
    const ns = 'push-test-agent';
    await api('POST', '/api/meta-chat/send', { ns, message: 'do something' });

    const lPushCall = mockRedis._calls.find(c => c.op === 'lPush' && c.key === metaInputKey(ns));
    expect(lPushCall).toBeDefined();
    const entry = JSON.parse(lPushCall.values[0]);
    expect(entry.content).toBe('do something');
    expect(entry.id).toBeDefined();
    expect(entry.timestamp).toBeDefined();
  });

  it('derives canonical short namespace from owner/repo format', async () => {
    // "gonzih/my-repo" → canonical "my-repo"
    await api('POST', '/api/meta-chat/send', { ns: 'gonzih/my-repo', message: 'hi' });

    const lPushCall = mockRedis._calls.find(c => c.op === 'lPush' && c.key === metaInputKey('my-repo'));
    expect(lPushCall).toBeDefined();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Config — GET /api/config
// ══════════════════════════════════════════════════════════════════════════════
describe('GET /api/config', () => {
  it('returns current namespace without touching Redis', async () => {
    const { status, body } = await api('GET', '/api/config');
    expect(status).toBe(200);
    expect(body.namespace).toBe(TEST_NS);
    // Config is purely in-memory — no Redis calls expected
    expect(mockRedis._calls).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Versions — GET /versions
// ══════════════════════════════════════════════════════════════════════════════
describe('GET /versions', () => {
  it('returns all three version fields', async () => {
    mockRedis._seed(CC_AGENT_VERSION_KEY, '2.3.4');
    mockRedis._seed(CC_TG_VERSION_KEY,    '1.0.1');

    const { status, body } = await api('GET', '/versions');
    expect(status).toBe(200);
    expect(body['cc-agent-ui']).toMatch(/^\d+\.\d+\.\d+/); // from package.json
    expect(body['cc-agent']).toBe('2.3.4');
    expect(body['cc-tg']).toBe('1.0.1');
  });

  it('falls back to "unknown" when Redis keys are absent', async () => {
    const { body } = await api('GET', '/versions');
    expect(body['cc-agent']).toBe('unknown');
    expect(body['cc-tg']).toBe('unknown');
  });

  it('reads CC_AGENT_VERSION_KEY and CC_TG_VERSION_KEY from Redis', async () => {
    await api('GET', '/versions');
    const getKeys = mockRedis._calls.filter(c => c.op === 'get').map(c => c.key);
    expect(getKeys).toContain(CC_AGENT_VERSION_KEY);
    expect(getKeys).toContain(CC_TG_VERSION_KEY);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// File browser security — GET /api/browse
// ══════════════════════════════════════════════════════════════════════════════
describe('GET /api/browse path security', () => {
  it('returns 400 when path param is missing', async () => {
    const { status } = await api('GET', '/api/browse');
    expect(status).toBe(400);
  });

  it('returns 403 for paths outside allowed roots', async () => {
    const { status } = await api('GET', '/api/browse?path=/etc/passwd');
    expect(status).toBe(403);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Wiki API  (GET /api/wiki, GET/PUT/DELETE /api/wiki/:repo/:page)
// ══════════════════════════════════════════════════════════════════════════════
describe('Wiki API', () => {
  const repo = 'gonzih-cc-agent';
  const page = 'getting-started';

  function wikiKey(slug)    { return `cca:wiki:${slug}`; }
  function wikiUpdKey(slug) { return `cca:wiki:${slug}:updated`; }

  // ── GET /api/wiki ──────────────────────────────────────────────────────────
  describe('GET /api/wiki', () => {
    it('returns empty repos array when no wiki keys exist', async () => {
      const { status, body } = await api('GET', '/api/wiki');
      expect(status).toBe(200);
      expect(body.repos).toEqual([]);
    });

    it('lists repos with page count and updatedAt', async () => {
      mockRedis._seedHash(wikiKey(repo), { 'getting-started': '# Hello', 'advanced': '# Adv' });
      mockRedis._seed(wikiUpdKey(repo), '2025-01-01T00:00:00.000Z');

      const { status, body } = await api('GET', '/api/wiki');
      expect(status).toBe(200);
      expect(body.repos).toHaveLength(1);
      expect(body.repos[0].slug).toBe(repo);
      expect(body.repos[0].pageCount).toBe(2);
      expect(body.repos[0].updatedAt).toBe('2025-01-01T00:00:00.000Z');
    });

    it('excludes :updated keys from repos list', async () => {
      mockRedis._seedHash(wikiKey(repo), { p1: 'content' });
      mockRedis._seed(wikiUpdKey(repo), '2025-01-01T00:00:00.000Z');
      // The :updated key is a STRING not a HASH — the listing should filter it out
      const { body } = await api('GET', '/api/wiki');
      expect(body.repos.every(r => !r.slug.endsWith(':updated'))).toBe(true);
    });
  });

  // ── GET /api/wiki/:repo ───────────────────────────────────────────────────
  describe('GET /api/wiki/:repo', () => {
    it('returns empty pages array for unknown repo', async () => {
      const { status, body } = await api('GET', `/api/wiki/${repo}`);
      expect(status).toBe(200);
      expect(body.pages).toEqual([]);
    });

    it('lists page names sorted alphabetically', async () => {
      mockRedis._seedHash(wikiKey(repo), { 'z-page': 'z', 'a-page': 'a' });
      const { status, body } = await api('GET', `/api/wiki/${repo}`);
      expect(status).toBe(200);
      expect(body.pages.map(p => p.name)).toEqual(['a-page', 'z-page']);
    });

    it('does not expose content for path traversal attempt (URL normalization resolves it)', async () => {
      // new URL('/api/wiki/../../etc', base) normalizes to /etc — route doesn't match → 404
      const { status } = await api('GET', '/api/wiki/../../etc');
      expect(status).toBe(404);
    });
  });

  // ── GET /api/wiki/:repo/:page ────────────────────────────────────────────
  describe('GET /api/wiki/:repo/:page', () => {
    it('returns page content by slug', async () => {
      mockRedis._seedHash(wikiKey(repo), { [page]: '# Getting Started\nHello world.' });
      const { status, body } = await api('GET', `/api/wiki/${repo}/${page}`);
      expect(status).toBe(200);
      expect(body.name).toBe(page);
      expect(body.content).toContain('Getting Started');
    });

    it('returns 404 for non-existent page', async () => {
      mockRedis._seedHash(wikiKey(repo), { 'other-page': 'content' });
      const { status } = await api('GET', `/api/wiki/${repo}/nonexistent`);
      expect(status).toBe(404);
    });

    it('URL normalization resolves traversal to a safe repo lookup', async () => {
      // /api/wiki/bad/slug/../../etc normalizes to /api/wiki/etc — lists (empty) pages for "etc"
      // No sensitive data is exposed; the wiki handler returns empty pages list
      const { status, body } = await api('GET', '/api/wiki/bad/slug/../../etc');
      expect(status).toBe(200);
      expect(body.pages).toBeDefined();
    });
  });

  // ── PUT /api/wiki/:repo/:page ────────────────────────────────────────────
  describe('PUT /api/wiki/:repo/:page', () => {
    it('creates a new page', async () => {
      const { status, body } = await api('PUT', `/api/wiki/${repo}/${page}`, { content: '# New page\n' });
      expect(status).toBe(200);
      expect(body.ok).toBe(true);

      const hSetCall = mockRedis._calls.find(c => c.op === 'hSet' && c.key === wikiKey(repo));
      expect(hSetCall).toBeDefined();
      expect(hSetCall.field).toBe(page);
      expect(hSetCall.value).toBe('# New page\n');
    });

    it('updates the :updated timestamp', async () => {
      await api('PUT', `/api/wiki/${repo}/${page}`, { content: 'Updated content' });

      const setCall = mockRedis._calls.find(c => c.op === 'set' && c.key === wikiUpdKey(repo));
      expect(setCall).toBeDefined();
      expect(setCall.value).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('returns 400 when content is not a string', async () => {
      const { status } = await api('PUT', `/api/wiki/${repo}/${page}`, { content: 42 });
      expect(status).toBe(400);
    });

    it('returns 400 for slug with invalid chars (contains @)', async () => {
      const { status } = await api('PUT', `/api/wiki/@bad/page`, { content: 'x' });
      expect(status).toBe(400);
    });
  });

  // ── DELETE /api/wiki/:repo/:page ─────────────────────────────────────────
  describe('DELETE /api/wiki/:repo/:page', () => {
    it('deletes an existing page and returns ok', async () => {
      mockRedis._seedHash(wikiKey(repo), { [page]: 'content' });

      const { status, body } = await api('DELETE', `/api/wiki/${repo}/${page}`);
      expect(status).toBe(200);
      expect(body.ok).toBe(true);

      const hDelCall = mockRedis._calls.find(c => c.op === 'hDel' && c.key === wikiKey(repo));
      expect(hDelCall).toBeDefined();
      expect(hDelCall.fields).toContain(page);
    });

    it('returns 404 when page does not exist', async () => {
      const { status } = await api('DELETE', `/api/wiki/${repo}/nonexistent`);
      expect(status).toBe(404);
    });

    it('updates the :updated timestamp after deletion', async () => {
      mockRedis._seedHash(wikiKey(repo), { [page]: 'content' });
      await api('DELETE', `/api/wiki/${repo}/${page}`);

      const setCall = mockRedis._calls.find(c => c.op === 'set' && c.key === wikiUpdKey(repo));
      expect(setCall).toBeDefined();
    });
  });
});
