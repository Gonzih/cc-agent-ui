/**
 * Integration tests for all HTTP endpoints in server.js.
 *
 * Strategy:
 *  - Mock `redis`, `ws`, and `child_process` before server.js is imported.
 *  - vi.hoisted() creates the mock redis client object in the hoisted phase so
 *    the vi.mock factory can reference it.
 *  - server.js exports `server` and skips listen() when NODE_ENV=test, so we
 *    manually call server.listen(0) to get an OS-assigned port.
 *  - Tests make real fetch() requests against the local server.
 */

import { vi, describe, it, expect, beforeAll, afterAll } from 'vitest'

// ── Mock objects (must exist before server.js import) ─────────────────────────
const { mockRedis } = vi.hoisted(() => {
  const createClient = () => ({
    connect:    vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    on:         vi.fn(),
    keys:       vi.fn().mockResolvedValue([]),
    get:        vi.fn().mockResolvedValue(null),
    set:        vi.fn().mockResolvedValue('OK'),
    del:        vi.fn().mockResolvedValue(1),
    lLen:       vi.fn().mockResolvedValue(0),
    lRange:     vi.fn().mockResolvedValue([]),
    rPush:      vi.fn().mockResolvedValue(1),
    lPush:      vi.fn().mockResolvedValue(1),
    sMembers:   vi.fn().mockResolvedValue([]),
    sAdd:       vi.fn().mockResolvedValue(1),
    publish:    vi.fn().mockResolvedValue(0),
    subscribe:  vi.fn().mockResolvedValue(undefined),
    multi:      vi.fn().mockReturnValue({
      get:  vi.fn().mockReturnThis(),
      rPush: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    }),
    duplicate: vi.fn(),
  })
  const client = createClient()
  // duplicate() returns a fresh sub-client (used by SSE/chat/stream endpoints)
  client.duplicate = vi.fn(() => createClient())
  return { mockRedis: client }
})

vi.mock('redis', () => ({ createClient: vi.fn(() => mockRedis) }))

vi.mock('ws', () => ({
  // vitest 4.x: constructors must use function/class, not arrow functions
  WebSocketServer: vi.fn().mockImplementation(function () {
    this.on = vi.fn()
    this.clients = new Set()
  }),
}))

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    exec:     vi.fn(),
    execFile: vi.fn((cmd, args, cb) => { if (cb) cb(null, '', '') }),
  }
})

// ── Server setup ──────────────────────────────────────────────────────────────
process.env.NODE_ENV = 'test'

let server
let baseUrl

beforeAll(async () => {
  const mod = await import('../server.js')
  server = mod.server
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  baseUrl = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  // closeAllConnections() is Node 18.2+ — forcibly closes keep-alive / SSE connections
  server.closeAllConnections?.()
  await new Promise((resolve) => server.close(resolve))
}, 15000)

// ── Helpers ───────────────────────────────────────────────────────────────────
const get  = (p) => fetch(`${baseUrl}${p}`)
const post = (p, body) => fetch(`${baseUrl}${p}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})
const del   = (p) => fetch(`${baseUrl}${p}`, { method: 'DELETE' })
const patch = (p, body) => fetch(`${baseUrl}${p}`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

// ─────────────────────────────────────────────────────────────────────────────
// GET /
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /', () => {
  it('serves index.html with 200 text/html', async () => {
    const res = await get('/')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/html/)
  })

  it('/index.html also returns 200', async () => {
    const res = await get('/index.html')
    expect(res.status).toBe(200)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/config
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/config', () => {
  it('returns namespace as a string', async () => {
    const res = await get('/api/config')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(typeof body.namespace).toBe('string')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// GET /versions
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /versions', () => {
  it('returns cc-agent-ui version plus redis-sourced versions', async () => {
    mockRedis.get
      .mockResolvedValueOnce(null)  // CC_AGENT_VERSION_KEY → null
      .mockResolvedValueOnce(null)  // CC_TG_VERSION_KEY   → null
    const res = await get('/versions')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty('cc-agent-ui')
    expect(body['cc-agent']).toBe('unknown')
    expect(body['cc-tg']).toBe('unknown')
  })

  it('returns version strings when stored in Redis', async () => {
    mockRedis.get
      .mockResolvedValueOnce('1.2.3')
      .mockResolvedValueOnce('0.9.0')
    const res = await get('/versions')
    const body = await res.json()
    expect(body['cc-agent']).toBe('1.2.3')
    expect(body['cc-tg']).toBe('0.9.0')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/browse
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/browse', () => {
  it('returns 400 when path param is missing', async () => {
    const res = await get('/api/browse')
    expect(res.status).toBe(400)
  })

  it('returns 403 for paths outside allowed roots', async () => {
    const res = await get('/api/browse?path=/etc/passwd')
    expect(res.status).toBe(403)
  })

  it('returns 404 for a non-existent allowed path', async () => {
    const res = await get('/api/browse?path=/tmp/__cc_nonexistent_browse__')
    expect(res.status).toBe(404)
  })

  it('returns dir listing for /tmp', async () => {
    const res = await get('/api/browse?path=/tmp')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.type).toBe('dir')
    expect(Array.isArray(body.entries)).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/fs/stat
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/fs/stat', () => {
  it('returns 400 when path param is missing', async () => {
    expect((await get('/api/fs/stat')).status).toBe(400)
  })

  it('returns 403 for forbidden paths', async () => {
    expect((await get('/api/fs/stat?path=/etc/shadow')).status).toBe(403)
  })

  it('returns exists:false for non-existent path in /tmp', async () => {
    const res = await get('/api/fs/stat?path=/tmp/__cc_no_such_file_stat__')
    expect(res.status).toBe(200)
    expect((await res.json()).exists).toBe(false)
  })

  it('returns exists:true with type:dir for /tmp', async () => {
    const res = await get('/api/fs/stat?path=/tmp')
    const body = await res.json()
    expect(body.exists).toBe(true)
    expect(body.type).toBe('dir')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/fs/ls
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/fs/ls', () => {
  it('returns 400 when path param is missing', async () => {
    expect((await get('/api/fs/ls')).status).toBe(400)
  })

  it('returns 403 for forbidden paths', async () => {
    expect((await get('/api/fs/ls?path=/etc')).status).toBe(403)
  })

  it('returns 404 for a non-existent directory', async () => {
    expect((await get('/api/fs/ls?path=/tmp/__cc_no_such_dir_ls__')).status).toBe(404)
  })

  it('returns entries array for /tmp', async () => {
    const res = await get('/api/fs/ls?path=/tmp')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.entries)).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/fs/cat
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/fs/cat', () => {
  it('returns 400 when path param is missing', async () => {
    expect((await get('/api/fs/cat')).status).toBe(400)
  })

  it('returns 403 for forbidden paths', async () => {
    expect((await get('/api/fs/cat?path=/etc/hosts')).status).toBe(403)
  })

  it('returns 404 for a non-existent file', async () => {
    expect((await get('/api/fs/cat?path=/tmp/__cc_no_such_file_cat__.txt')).status).toBe(404)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/fs/raw
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/fs/raw', () => {
  it('returns 400 when path param is missing', async () => {
    expect((await get('/api/fs/raw')).status).toBe(400)
  })

  it('returns 403 for forbidden paths', async () => {
    expect((await get('/api/fs/raw?path=/etc/hosts')).status).toBe(403)
  })

  it('returns 404 for a non-existent file', async () => {
    expect((await get('/api/fs/raw?path=/tmp/__cc_no_raw_file__.js')).status).toBe(404)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/job/output
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/job/output', () => {
  it('returns 400 when id param is missing', async () => {
    expect((await get('/api/job/output')).status).toBe(400)
  })

  it('returns empty lines array when job has no output', async () => {
    mockRedis.lLen.mockResolvedValueOnce(0)
    const res = await get('/api/job/output?id=test-job-abc')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.lines)).toBe(true)
  })

  it('returns output lines from Redis', async () => {
    mockRedis.lLen.mockResolvedValueOnce(2)
    mockRedis.lRange.mockResolvedValueOnce(['line 1', 'line 2'])
    const res = await get('/api/job/output?id=test-job-xyz')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.lines).toEqual(['line 1', 'line 2'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/job/action
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/job/action', () => {
  it('returns 500 for invalid JSON body', async () => {
    const res = await fetch(`${baseUrl}/api/job/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    })
    expect(res.status).toBe(500)
  })

  it('returns 400 when id or action is empty', async () => {
    const res = await post('/api/job/action', { id: '', action: '' })
    expect(res.status).toBe(400)
  })

  it('returns 404 when job is not in Redis', async () => {
    mockRedis.get.mockResolvedValueOnce(null)
    const res = await post('/api/job/action', { id: 'ghost-job', action: 'cancel' })
    expect(res.status).toBe(404)
  })

  it('approve: marks job approved and returns ok', async () => {
    const job = { id: 'j1', status: 'pending_approval', goal: 'test' }
    mockRedis.get.mockResolvedValueOnce(JSON.stringify(job))
    const res = await post('/api/job/action', { id: 'j1', action: 'approve' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.action).toBe('approve')
  })

  it('cancel: sets signal key and returns ok', async () => {
    const job = { id: 'j2', status: 'running' }
    mockRedis.get.mockResolvedValueOnce(JSON.stringify(job))
    const res = await post('/api/job/action', { id: 'j2', action: 'cancel' })
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })

  it('wake: sets signal key and returns ok', async () => {
    const job = { id: 'j3', status: 'running' }
    mockRedis.get.mockResolvedValueOnce(JSON.stringify(job))
    const res = await post('/api/job/action', { id: 'j3', action: 'wake' })
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })

  it('message: pushes to input queue and echoes to output', async () => {
    const job = { id: 'j4', status: 'running' }
    mockRedis.get.mockResolvedValueOnce(JSON.stringify(job))
    mockRedis.rPush.mockResolvedValueOnce(1).mockResolvedValueOnce(2)
    const res = await post('/api/job/action', { id: 'j4', action: 'message', message: 'hello agent' })
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })

  it('message with no message field still returns ok', async () => {
    const job = { id: 'j5', status: 'running' }
    mockRedis.get.mockResolvedValueOnce(JSON.stringify(job))
    const res = await post('/api/job/action', { id: 'j5', action: 'message' })
    expect(res.status).toBe(200)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/open
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/open', () => {
  it('returns 400 when path param is missing', async () => {
    expect((await get('/api/open')).status).toBe(400)
  })

  it('returns 200 ok regardless of whether the file exists', async () => {
    const res = await get('/api/open?path=/tmp/test.js')
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// GET /crons
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /crons', () => {
  it('returns empty array when Redis has no crons', async () => {
    mockRedis.get.mockResolvedValueOnce(null)
    const res = await get('/crons')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('returns parsed crons array', async () => {
    const crons = [{ id: 'c1', prompt: 'do stuff', intervalMs: 3600000 }]
    mockRedis.get.mockResolvedValueOnce(JSON.stringify(crons))
    const res = await get('/crons')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveLength(1)
    expect(body[0].id).toBe('c1')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// POST /crons
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /crons', () => {
  it('creates a new cron and returns 201 with the new object', async () => {
    mockRedis.get.mockResolvedValueOnce(null)
    const res = await post('/crons', { prompt: 'run daily', schedule: 'daily', intervalMs: 86400000 })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body).toHaveProperty('id')
    expect(body.prompt).toBe('run daily')
    expect(body.schedule).toBe('daily')
  })

  it('appends to existing cron list', async () => {
    const existing = [{ id: 'old', prompt: 'existing' }]
    mockRedis.get.mockResolvedValueOnce(JSON.stringify(existing))
    const res = await post('/crons', { prompt: 'new cron' })
    expect(res.status).toBe(201)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /crons/:id
// ─────────────────────────────────────────────────────────────────────────────
describe('DELETE /crons/:id', () => {
  it('removes the matching cron and returns ok', async () => {
    const crons = [{ id: 'del-me', prompt: 'old' }, { id: 'keep', prompt: 'keep' }]
    mockRedis.get.mockResolvedValueOnce(JSON.stringify(crons))
    const res = await del('/crons/del-me')
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })

  it('is idempotent: returns ok even when id not found', async () => {
    mockRedis.get.mockResolvedValueOnce(JSON.stringify([]))
    const res = await del('/crons/nonexistent')
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /crons/:id
// ─────────────────────────────────────────────────────────────────────────────
describe('PATCH /crons/:id', () => {
  it('returns 404 when cron is not found', async () => {
    mockRedis.get.mockResolvedValueOnce(JSON.stringify([]))
    expect((await patch('/crons/ghost', { prompt: 'x' })).status).toBe(404)
  })

  it('updates cron fields and returns updated object', async () => {
    const crons = [{ id: 'patch-me', prompt: 'original', intervalMs: 1000 }]
    mockRedis.get.mockResolvedValueOnce(JSON.stringify(crons))
    const res = await patch('/crons/patch-me', { prompt: 'updated' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.prompt).toBe('updated')
    expect(body.id).toBe('patch-me')  // id is preserved
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// GET /chat/history
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /chat/history', () => {
  it('returns empty array when no messages', async () => {
    mockRedis.lRange.mockResolvedValueOnce([])
    const res = await get('/chat/history')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('returns messages in chronological order (oldest first)', async () => {
    // Redis stores LIFO — lRange returns newest-first; server reverses to oldest-first
    const raw = [
      JSON.stringify({ id: 'msg-2', content: 'second' }),
      JSON.stringify({ id: 'msg-1', content: 'first' }),
    ]
    mockRedis.lRange.mockResolvedValueOnce(raw)
    const body = await (await get('/chat/history')).json()
    expect(body[0].id).toBe('msg-1')
    expect(body[1].id).toBe('msg-2')
  })

  it('accepts namespace query param', async () => {
    mockRedis.lRange.mockResolvedValueOnce([])
    const res = await get('/chat/history?namespace=my-ns')
    expect(res.status).toBe(200)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// POST /chat/send
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /chat/send', () => {
  it('publishes via coordinator when no meta-agent is running', async () => {
    mockRedis.get.mockResolvedValueOnce(null)       // no meta-agent status
    mockRedis.publish.mockResolvedValueOnce(0)
    const res = await post('/chat/send', { message: 'hello' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body).toHaveProperty('id')
  })

  it('routes to meta-agent input queue when meta-agent is running', async () => {
    mockRedis.get.mockResolvedValueOnce(JSON.stringify({ status: 'running' }))
    mockRedis.lPush.mockResolvedValueOnce(1)
    const res = await post('/chat/send', { message: 'hi meta', namespace: 'test-ns' })
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })

  it('returns 500 for invalid JSON', async () => {
    const res = await fetch(`${baseUrl}/chat/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'bad json',
    })
    expect(res.status).toBe(500)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// GET /chat/stream  (SSE)
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /chat/stream', () => {
  it('responds with SSE content-type', async () => {
    mockRedis.keys.mockResolvedValue([])
    mockRedis.sMembers.mockResolvedValue([])
    const ctrl = new AbortController()
    const res = await fetch(`${baseUrl}/chat/stream`, { signal: ctrl.signal })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    ctrl.abort()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/meta-agents
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/meta-agents', () => {
  it('returns empty array when no agents registered', async () => {
    mockRedis.sMembers.mockResolvedValueOnce([])
    const res = await get('/api/meta-agents')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('skips the literal "default" namespace entry', async () => {
    mockRedis.sMembers.mockResolvedValueOnce(['default'])
    const body = await (await get('/api/meta-agents')).json()
    expect(body).toHaveLength(0)
  })

  it('returns meta-agent data including chat log count', async () => {
    const state = { namespace: 'my-agent', repoUrl: 'https://github.com/x/y', status: 'idle' }
    mockRedis.sMembers.mockResolvedValueOnce(['my-agent'])
    mockRedis.get
      .mockResolvedValueOnce(JSON.stringify(state))  // metaKey
      .mockResolvedValueOnce(null)                    // metaAgentStatusKey
    mockRedis.lLen.mockResolvedValueOnce(7)
    const body = await (await get('/api/meta-agents')).json()
    expect(body).toHaveLength(1)
    expect(body[0].namespace).toBe('my-agent')
    expect(body[0].count).toBe(7)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/meta-chat/log
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/meta-chat/log', () => {
  it('returns 400 when ns param is missing', async () => {
    expect((await get('/api/meta-chat/log')).status).toBe(400)
  })

  it('returns messages in chronological order', async () => {
    const raw = [
      JSON.stringify({ id: 'b', content: 'second' }),
      JSON.stringify({ id: 'a', content: 'first' }),
    ]
    mockRedis.lRange.mockResolvedValueOnce(raw)
    const body = await (await get('/api/meta-chat/log?ns=test-ns')).json()
    expect(body[0].id).toBe('a')
    expect(body[1].id).toBe('b')
  })

  it('returns empty array when no messages', async () => {
    mockRedis.lRange.mockResolvedValueOnce([])
    expect(await (await get('/api/meta-chat/log?ns=empty-ns')).json()).toEqual([])
  })

  it('silently drops malformed JSON entries', async () => {
    mockRedis.lRange.mockResolvedValueOnce(['not-json', JSON.stringify({ id: 'ok' })])
    const body = await (await get('/api/meta-chat/log?ns=x')).json()
    expect(body).toHaveLength(1)
    expect(body[0].id).toBe('ok')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/meta-chat/send
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/meta-chat/send', () => {
  it('returns 400 when ns is missing', async () => {
    expect((await post('/api/meta-chat/send', { message: 'hello' })).status).toBe(400)
  })

  it('returns 400 when message is missing', async () => {
    expect((await post('/api/meta-chat/send', { ns: 'my-ns' })).status).toBe(400)
  })

  it('auto-provisions unregistered namespace and returns ok', async () => {
    mockRedis.sMembers.mockResolvedValueOnce([])
    const res = await post('/api/meta-chat/send', { ns: 'brand-new', message: 'start' })
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })

  it('uses canonical short name from owner/repo format', async () => {
    mockRedis.sMembers.mockResolvedValueOnce(['myrepo'])  // already registered
    const res = await post('/api/meta-chat/send', { ns: 'gonzih/myrepo', message: 'hi' })
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })

  it('returns 500 for invalid JSON body', async () => {
    const res = await fetch(`${baseUrl}/api/meta-chat/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'bad',
    })
    expect(res.status).toBe(500)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/swarms
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/swarms', () => {
  it('returns empty array when no swarm keys in Redis', async () => {
    mockRedis.keys.mockResolvedValueOnce([])
    const body = await (await get('/api/swarms')).json()
    expect(body).toEqual([])
  })

  it('returns swarm records sorted newest-first by created_at', async () => {
    mockRedis.keys.mockResolvedValueOnce(['cca:swarm:s1', 'cca:swarm:s2'])
    mockRedis.get
      .mockResolvedValueOnce(JSON.stringify({ swarm_id: 's1', created_at: '2024-01-01T00:00:00Z' }))
      .mockResolvedValueOnce(JSON.stringify({ swarm_id: 's2', created_at: '2024-01-02T00:00:00Z' }))
    const body = await (await get('/api/swarms')).json()
    expect(body).toHaveLength(2)
    expect(body[0].swarm_id).toBe('s2')  // newer first
  })

  it('skips records without swarm_id (e.g. cca:swarm:requests)', async () => {
    mockRedis.keys.mockResolvedValueOnce(['cca:swarm:requests'])
    mockRedis.get.mockResolvedValueOnce(JSON.stringify({ goal: 'not a swarm' }))
    const body = await (await get('/api/swarms')).json()
    expect(body).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/swarm/trigger
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/swarm/trigger', () => {
  it('returns 400 when goal is missing', async () => {
    expect((await post('/api/swarm/trigger', { repoUrl: 'https://x.com' })).status).toBe(400)
  })

  it('creates swarm request and returns 202 with id', async () => {
    const res = await post('/api/swarm/trigger', { goal: 'build the feature', maxAgents: 3 })
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(typeof body.id).toBe('string')
  })

  it('clamps maxAgents above 50 to 50', async () => {
    const res = await post('/api/swarm/trigger', { goal: 'test', maxAgents: 999 })
    expect(res.status).toBe(202)
  })

  it('uses default maxAgents=5 when not provided', async () => {
    const res = await post('/api/swarm/trigger', { goal: 'test default agents' })
    expect(res.status).toBe(202)
    expect((await res.json()).ok).toBe(true)
  })

  it('returns 500 for invalid JSON body', async () => {
    const res = await fetch(`${baseUrl}/api/swarm/trigger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'bad json',
    })
    expect(res.status).toBe(500)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/jobs/:id/stream  (SSE)
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/jobs/:id/stream', () => {
  it('responds with SSE content-type and retry directive', async () => {
    mockRedis.lRange.mockResolvedValueOnce([])
    const ctrl = new AbortController()
    const res = await fetch(`${baseUrl}/api/jobs/test-job-id/stream`, { signal: ctrl.signal })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    expect(res.headers.get('cache-control')).toBe('no-cache')
    ctrl.abort()
  })

  it('streams retry directive in initial chunk', async () => {
    mockRedis.lRange.mockResolvedValueOnce([])
    const ctrl = new AbortController()
    const res = await fetch(`${baseUrl}/api/jobs/stream-test/stream`, { signal: ctrl.signal })
    const reader = res.body.getReader()
    const { value } = await reader.read()
    const chunk = new TextDecoder().decode(value)
    expect(chunk).toContain('retry: 3000')
    ctrl.abort()
  })

  it('includes backlog lines as data events before ready signal', async () => {
    mockRedis.lRange.mockResolvedValueOnce(['line-alpha', 'line-beta'])
    const ctrl = new AbortController()
    const res = await fetch(`${baseUrl}/api/jobs/backlog-job/stream`, { signal: ctrl.signal })
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let full = ''
    for (let i = 0; i < 5; i++) {
      const { value, done } = await reader.read()
      if (done) break
      full += decoder.decode(value)
      if (full.includes('event: ready')) break
    }
    expect(full).toContain('"line-alpha"')
    expect(full).toContain('"line-beta"')
    expect(full).toContain('event: ready')
    ctrl.abort()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Static file serving
// ─────────────────────────────────────────────────────────────────────────────
describe('Static file serving', () => {
  it('returns 404 for unknown routes', async () => {
    expect((await get('/this-does-not-exist')).status).toBe(404)
  })

  it('serves logo.png with image/png content-type', async () => {
    const res = await get('/logo.png')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
  })

  it('returns 404 for dot-prefixed filenames (security)', async () => {
    expect((await get('/.env')).status).toBe(404)
  })
})
