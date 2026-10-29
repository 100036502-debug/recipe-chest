// An in-memory stand-in for @upstash/redis, with the same async signatures the
// app uses. Handlers take the kv as an argument (see the createHandler
// convention), so a test can run real handler logic without any credentials.
//
// Expiry is honoured so a test can prove a key really disappears after its TTL.
export function createFakeKv() {
  const data = new Map();   // key -> { value, expiresAt }
  const lists = new Map();  // key -> array
  const sets = new Map();   // key -> Set

  function alive(key) {
    const entry = data.get(key);
    if (!entry) return false;
    if (entry.expiresAt && entry.expiresAt <= Date.now()) {
      data.delete(key);
      return false;
    }
    return true;
  }

  function readString(key) {
    return alive(key) ? data.get(key).value : null;
  }

  const kv = {
    // ---- strings / JSON -------------------------------------------------
    async get(key) {
      const value = readString(key);
      return value === undefined ? null : value;
    },

    async set(key, value, opts = {}) {
      const expiresAt = opts && opts.ex ? Date.now() + Number(opts.ex) * 1000 : null;
      lists.delete(key);
      sets.delete(key);
      data.set(key, { value, expiresAt });
      return 'OK';
    },

    async del(...keys) {
      let removed = 0;
      for (const key of keys.flat()) {
        const gone = data.delete(key) || lists.delete(key) || sets.delete(key);
        if (gone) removed += 1;
      }
      return removed;
    },

    async mget(...keys) {
      return keys.flat().map((key) => (alive(key) ? data.get(key).value : null));
    },

    async incr(key) {
      const next = Number(readString(key) || 0) + 1;
      data.set(key, { value: next, expiresAt: data.get(key)?.expiresAt || null });
      return next;
    },

    async expire(key, seconds) {
      const has = alive(key) || lists.has(key) || sets.has(key);
      if (!has) return 0;
      if (data.has(key)) data.get(key).expiresAt = Date.now() + Number(seconds) * 1000;
      return 1;
    },

    async strlen(key) {
      const value = readString(key);
      if (value === null || value === undefined) return 0;
      return typeof value === 'string' ? value.length : JSON.stringify(value).length;
    },

    async ping() {
      return 'PONG';
    },

    // ---- lists ----------------------------------------------------------
    async lrange(key, start, stop) {
      const list = lists.get(key);
      if (!list) return [];
      const end = stop === -1 || stop === undefined ? list.length : stop + 1;
      return list.slice(start, end);
    },

    async lpush(key, ...values) {
      const list = lists.get(key) || [];
      // Redis pushes each value to the head in order, so the last one ends first.
      for (const value of values.flat()) list.unshift(value);
      lists.set(key, list);
      return list.length;
    },

    async lrem(key, count, value) {
      const list = lists.get(key);
      if (!list) return 0;
      let removed = 0;
      const keep = [];
      for (const item of list) {
        const match = item === value;
        // count 0 removes every match; a positive count removes that many from the head.
        if (match && (count === 0 || removed < Math.abs(count))) {
          removed += 1;
          continue;
        }
        keep.push(item);
      }
      lists.set(key, keep);
      return removed;
    },

    // ---- sets -----------------------------------------------------------
    async sadd(key, ...members) {
      const set = sets.get(key) || new Set();
      let added = 0;
      for (const member of members.flat()) {
        if (!set.has(member)) { set.add(member); added += 1; }
      }
      sets.set(key, set);
      return added;
    },

    async srem(key, ...members) {
      const set = sets.get(key);
      if (!set) return 0;
      let removed = 0;
      for (const member of members.flat()) if (set.delete(member)) removed += 1;
      return removed;
    },

    async smembers(key) {
      const set = sets.get(key);
      return set ? [...set] : [];
    },

    // ---- test-only escape hatches --------------------------------------
    _raw(key) {
      return { string: readString(key), list: lists.get(key), set: sets.get(key) };
    },
    _keys() {
      return [...new Set([...data.keys(), ...lists.keys(), ...sets.keys()])];
    },
  };

  return kv;
}
