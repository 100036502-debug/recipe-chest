// Compare-and-set for the two per-device buckets (shopping list, meal plan).
//
// The shopping list already refused a write built on a stale copy, but it did so
// with a GET followed by a SET, which leaves a window for the other device to
// land in between. The meal plan had no check at all. Both now go through one
// Lua script: the stored `updatedAt` is compared and the value written in a
// single step, so a write either applies to the version it was built from or is
// refused.
import { decideWrite } from './shopping-list.js';

export const BUCKET_CAS_SCRIPT = [
  "local raw = redis.call('GET', KEYS[1])",
  "local expected = ARGV[1]",
  // An empty base means the caller sent none: legacy clients and a first write.
  "if expected ~= '' then",
  '  if not raw then return 0 end',
  "  local ok, cur = pcall(cjson.decode, raw)",
  "  if not ok or type(cur) ~= 'table' then return 0 end",
  '  local current = tonumber(cur.updatedAt)',
  '  local base = tonumber(expected)',
  '  if current ~= nil and base ~= nil and current > base then return 0 end',
  'end',
  "redis.call('SET', KEYS[1], ARGV[2])",
  'local ttl = tonumber(ARGV[3])',
  "if ttl and ttl > 0 then redis.call('EXPIRE', KEYS[1], ttl) end",
  'return 1',
].join('\n');

function ttlSeconds(setOptions) {
  const ex = setOptions && Number(setOptions.ex);
  return Number.isFinite(ex) && ex > 0 ? String(ex) : '';
}

// One rule for both stores, shared with lib/shopping-list.js so the in-process
// fallback cannot drift from the script above.
export function valuesMatch(stored, baseUpdatedAt) {
  return decideWrite({ stored, baseUpdatedAt }).write;
}

/**
 * Writes `payload` only if the stored copy's updatedAt is not newer than
 * baseUpdatedAt. Resolves to { ok: true } or { ok: false, current }.
 */
export async function writeBucket(kv, key, payload, { baseUpdatedAt, setOptions } = {}) {
  const wantsCheck = baseUpdatedAt !== undefined && baseUpdatedAt !== null && baseUpdatedAt !== ''
    && Number.isFinite(Number(baseUpdatedAt));

  if (typeof kv.eval === 'function') {
    const result = await kv.eval(
      BUCKET_CAS_SCRIPT,
      [key],
      [
        wantsCheck ? String(baseUpdatedAt) : '',
        JSON.stringify(payload),
        ttlSeconds(setOptions),
      ],
    );
    if (Number(result) === 1) return { ok: true };
    return { ok: false, current: await kv.get(key) };
  }

  const stored = await kv.get(key);
  if (!valuesMatch(stored, wantsCheck ? baseUpdatedAt : undefined)) {
    return { ok: false, current: stored };
  }
  await kv.set(key, payload, setOptions || {});
  return { ok: true };
}

/**
 * The plan used to be the raw date map. A bucket that a member shares with the
 * household may not be written blind: without a base the writer cannot know what
 * it is overwriting.
 */
export function missingBaseForShared({ deviceId, stored, baseUpdatedAt, hasData }) {
  if (deviceId !== 'shared') return false;
  if (!hasData || !stored) return false;
  return baseUpdatedAt === undefined || baseUpdatedAt === null || baseUpdatedAt === '';
}
