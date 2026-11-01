// Optimistic concurrency for recipe:<id>.
//
// Every writer used to read the whole recipe, edit its copy and write the whole
// thing back, so two writers that overlapped lost one of the edits. Each recipe
// now carries an integer `rev` (absent means 0, so recipes written before this
// existed keep working), and a write only lands if the stored rev is still the
// one that was read. On a mismatch the mutation is re-applied to the fresh copy
// and retried: two different fields edited at once both survive, and only a
// genuine conflict (the same field, three attempts) comes back as 409.
//
// The compare-and-set itself is one Lua script so the read and the write cannot
// be interleaved by another function; a GET followed by a SET would leave the
// same window this is meant to close.
import { normalizeIncomingRecipe } from './recipes.js';

export const MAX_UPDATE_TRIES = 3;

// KEYS[1] recipe key. ARGV[1] expected rev, ARGV[2] the new JSON.
// Returns 1 when it wrote, 0 when the rev had moved on or the key was gone.
export const CAS_SCRIPT = [
  "local raw = redis.call('GET', KEYS[1])",
  'if not raw then return 0 end',
  'local ok, cur = pcall(cjson.decode, raw)',
  "if not ok or type(cur) ~= 'table' then return 0 end",
  'local expected = tonumber(ARGV[1])',
  'local rev = tonumber(cur.rev)',
  'if rev == nil then rev = 0 end',
  'if rev ~= expected then return 0 end',
  "redis.call('SET', KEYS[1], ARGV[2])",
  'return 1',
].join('\n');

/** A recipe's rev, treating anything missing or odd as 0. */
export function revOf(recipe) {
  const n = Number(recipe && recipe.rev);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

async function compareAndSet(kv, key, expectedRev, payload) {
  // Upstash exposes eval; the in-memory test store does not, and falls back to
  // the get/compare/set below, which is enough for a single-threaded test.
  if (typeof kv.eval === 'function') {
    const result = await kv.eval(CAS_SCRIPT, [key], [String(expectedRev), payload]);
    return Number(result) === 1;
  }
  const current = await kv.get(key);
  if (!current || revOf(current) !== expectedRev) return false;
  await kv.set(key, JSON.parse(payload));
  return true;
}

/**
 * Applies mutate to a recipe under compare-and-set.
 *
 * mutate receives a copy of the stored recipe and returns the object to store,
 * or nothing to leave the recipe untouched. baseRev comes from the client: when
 * it is present and stale the write is refused immediately, because the user's
 * text was written against a version that no longer exists.
 *
 * Resolves to { status, body }. 404 when the recipe is gone, 409 with the
 * current recipe when the change could not be applied.
 */
export async function updateRecipe(kv, id, mutate, opts = {}) {
  const key = `recipe:${id}`;
  const tries = Number.isInteger(opts.tries) && opts.tries > 0 ? opts.tries : MAX_UPDATE_TRIES;
  const hasBaseRev = opts.baseRev !== undefined && opts.baseRev !== null && opts.baseRev !== '';

  for (let attempt = 1; attempt <= tries; attempt += 1) {
    const current = await kv.get(key);
    if (!current || typeof current !== 'object') {
      return { status: 404, body: { error: 'Recipe not found' } };
    }

    const rev = revOf(current);
    if (hasBaseRev && Number(opts.baseRev) !== rev) {
      return {
        status: 409,
        body: { error: 'This recipe changed since you opened it. Reload to see the latest version.', current, rev },
      };
    }

    const mutated = await mutate({ ...current, rev });
    if (mutated === undefined || mutated === null) {
      return { status: 200, body: current, rev, changed: false };
    }

    const next = normalizeIncomingRecipe({ ...mutated, rev: rev + 1 });
    next.updatedAt = Date.now();
    const written = await compareAndSet(kv, key, rev, JSON.stringify(next));
    if (written) return { status: 200, body: next, rev: rev + 1, changed: true, tries: attempt };
  }

  const current = await kv.get(key);
  return {
    status: 409,
    body: {
      error: 'Someone else changed this recipe at the same time. Reload and try again.',
      current: current || null,
      rev: revOf(current),
    },
  };
}

/** Sends an updateRecipe result, for the handlers that just want to answer. */
export function sendUpdateResult(res, result) {
  return res.status(result.status).json(result.body);
}
