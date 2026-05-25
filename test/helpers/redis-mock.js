import { vi } from 'vitest';

/**
 * Creates a stateful in-memory Redis mock.
 *
 * Tracks every operation in `._calls` so tests can assert exactly what keys
 * and values were read/written.  Three backing stores mirror Redis types:
 *   _store  → STRING keys  (get / set / del)
 *   _lists  → LIST keys    (lPush / rPush / lRange / lLen / lTrim)
 *   _sets   → SET keys     (sAdd / sMembers)
 */
export function createMockRedis() {
  const store = new Map();
  const lists = new Map();
  const sets  = new Map();
  const calls = [];

  function matchesGlob(key, pattern) {
    const re = new RegExp(
      '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'
    );
    return re.test(key);
  }

  function allKeys() {
    return [...new Set([...store.keys(), ...lists.keys(), ...sets.keys()])];
  }

  const client = {
    _calls: calls,
    _store: store,
    _lists: lists,
    _sets:  sets,

    /** Seed a STRING key */
    _seed(key, value) { store.set(key, value); },
    /** Seed a LIST key (index 0 = head, appended to tail with rPush) */
    _seedList(key, items) { lists.set(key, [...items]); },
    /** Seed a SET key */
    _seedSet(key, items) { sets.set(key, new Set(items)); },

    /** Reset all backing stores and call history between tests */
    _reset() {
      store.clear();
      lists.clear();
      sets.clear();
      calls.length = 0;
      for (const val of Object.values(client)) {
        if (typeof val?.mockClear === 'function') val.mockClear();
      }
    },

    // ── Connection ──────────────────────────────────────────────────────────
    connect:    vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    quit:       vi.fn().mockResolvedValue(undefined),
    on:         vi.fn(),

    // ── String commands ─────────────────────────────────────────────────────
    get: vi.fn(async (key) => {
      calls.push({ op: 'get', key });
      return store.get(key) ?? null;
    }),

    set: vi.fn(async (key, value, options) => {
      calls.push({ op: 'set', key, value, options });
      store.set(key, value);
      return 'OK';
    }),

    del: vi.fn(async (...args) => {
      const keys = args.flat();
      calls.push({ op: 'del', keys });
      let count = 0;
      for (const k of keys) {
        if (store.delete(k) || lists.delete(k) || sets.delete(k)) count++;
      }
      return count;
    }),

    keys: vi.fn(async (pattern) => {
      calls.push({ op: 'keys', pattern });
      return allKeys().filter(k => matchesGlob(k, pattern));
    }),

    // ── List commands ───────────────────────────────────────────────────────
    lLen: vi.fn(async (key) => {
      calls.push({ op: 'lLen', key });
      return (lists.get(key) ?? []).length;
    }),

    lRange: vi.fn(async (key, start, stop) => {
      calls.push({ op: 'lRange', key, start, stop });
      const list = lists.get(key) ?? [];
      const len  = list.length;
      const s    = start >= 0 ? start : Math.max(0, len + start);
      const e    = stop  >= 0 ? Math.min(stop, len - 1) : len + stop;
      if (s > e || len === 0) return [];
      return list.slice(s, e + 1);
    }),

    /** LPUSH — prepends each value (in Redis, last arg ends at head) */
    lPush: vi.fn(async (key, ...args) => {
      const values = args.flat();
      calls.push({ op: 'lPush', key, values });
      const list = lists.get(key) ?? [];
      // Redis LPUSH semantics: elements pushed left-to-right, so last arg is head
      for (let i = values.length - 1; i >= 0; i--) list.unshift(values[i]);
      lists.set(key, list);
      return list.length;
    }),

    /** RPUSH — appends to tail */
    rPush: vi.fn(async (key, ...args) => {
      const values = args.flat();
      calls.push({ op: 'rPush', key, values });
      const list = lists.get(key) ?? [];
      list.push(...values);
      lists.set(key, list);
      return list.length;
    }),

    lTrim: vi.fn(async (key, start, stop) => {
      calls.push({ op: 'lTrim', key, start, stop });
      const list = lists.get(key) ?? [];
      const len  = list.length;
      const s    = start >= 0 ? start : Math.max(0, len + start);
      const e    = stop  >= 0 ? Math.min(stop, len - 1) : len + stop;
      lists.set(key, s <= e ? list.slice(s, e + 1) : []);
      return 'OK';
    }),

    // ── Set commands ────────────────────────────────────────────────────────
    sMembers: vi.fn(async (key) => {
      calls.push({ op: 'sMembers', key });
      return [...(sets.get(key) ?? new Set())];
    }),

    sAdd: vi.fn(async (key, ...args) => {
      const values = args.flat();
      calls.push({ op: 'sAdd', key, values });
      const set = sets.get(key) ?? new Set();
      let added = 0;
      for (const v of values) { if (!set.has(v)) { set.add(v); added++; } }
      sets.set(key, set);
      return added;
    }),

    // ── Pub/Sub ─────────────────────────────────────────────────────────────
    publish: vi.fn(async (channel, message) => {
      calls.push({ op: 'publish', channel, message });
      return 0;
    }),

    subscribe: vi.fn(async (channel) => {
      calls.push({ op: 'subscribe', channel });
    }),

    unsubscribe: vi.fn(async (channel) => {
      calls.push({ op: 'unsubscribe', channel });
    }),

    // ── Pipeline (multi) ────────────────────────────────────────────────────
    multi: vi.fn(function () {
      const ops = [];
      const pipeline = {
        get:   (key)          => { ops.push(() => client.get(key));             return pipeline; },
        set:   (key, val, o)  => { ops.push(() => client.set(key, val, o));     return pipeline; },
        lLen:  (key)          => { ops.push(() => client.lLen(key));            return pipeline; },
        lRange:(key, s, e)    => { ops.push(() => client.lRange(key, s, e));    return pipeline; },
        rPush: (key, ...v)    => { ops.push(() => client.rPush(key, ...v));     return pipeline; },
        lPush: (key, ...v)    => { ops.push(() => client.lPush(key, ...v));     return pipeline; },
        exec:  async ()       => Promise.all(ops.map(fn => fn())),
      };
      return pipeline;
    }),

    /** Returns a new independent client (used for pub/sub subscriptions) */
    duplicate: vi.fn(function () {
      const dup = {
        connect:     vi.fn().mockResolvedValue(undefined),
        disconnect:  vi.fn().mockResolvedValue(undefined),
        subscribe:   vi.fn().mockResolvedValue(undefined),
        unsubscribe: vi.fn().mockResolvedValue(undefined),
        on:          vi.fn(),
      };
      return dup;
    }),
  };

  return client;
}
