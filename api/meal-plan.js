import { Redis } from '@upstash/redis';
import { requireAuth } from '../lib/auth.js';
import { ID_PATTERN } from '../lib/recipes.js';
import { sendServerError } from '../lib/http.js';
import { refuseGuestWrite, resolveBucketId, bucketSetOptions } from '../lib/device-buckets.js';
import { writeBucket, missingBaseForShared } from '../lib/bucket-store.js';

// let, not const: tests swap in a fake store.
let kv = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

export function __setKvForTests(store) { kv = store; }

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DAYS = 400; // keys per plan
const DATE_WINDOW_DAYS = 400; // how far from today a date may sit

// One plan is one Redis value, so an unbounded number of date keys is both a
// storage and a read-amplification problem. Keep the window human (a little
// over a year either way) and cap the key count.
export function dateAllowed(date, now = Date.now()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const at = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(at)) return false;
  return Math.abs(at - now) <= DATE_WINDOW_DAYS * DAY_MS;
}

// A plan is { days, updatedAt } now. Plans written before this change are a
// bare date map, so reading tolerates both and the client never sees a break.
export function readPlan(stored) {
  if (!stored || typeof stored !== 'object') return { days: {}, updatedAt: null };
  if (stored.days && typeof stored.days === 'object') {
    return { days: stored.days, updatedAt: typeof stored.updatedAt === 'number' ? stored.updatedAt : null };
  }
  return { days: stored, updatedAt: null };
}

function keyFor(deviceId) {
  return `meal_plan:${deviceId}`;
}

function cleanDeviceId(raw) {
  return String(raw || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!(await requireAuth(req, res, { allowGuestWrite: true }))) return;

  const rawId = req.query?.deviceId || (req.body && req.body.deviceId);
  const requested = cleanDeviceId(rawId);
  if (!requested) {
    return res.status(400).json({ error: 'Missing or invalid deviceId' });
  }

  const deviceId = resolveBucketId(req, requested);
  const key = keyFor(deviceId);

  // Guests keep their own plan; the household plan is members only.
  if (req.method !== 'GET' && req.method !== 'OPTIONS'
    && await refuseGuestWrite(req, res, kv, { deviceId: requested, name: 'plan-write' })) return;

  // GET: return the whole plan for this device
  if (req.method === 'GET') {
    try {
      const stored = await kv.get(key);
      return res.status(200).json(readPlan(stored));
    } catch (e) {
      return sendServerError(res, e);
    }
  }

  // POST: set the recipes for one day for this device
  if (req.method === 'POST') {
    const body = req.body || {};
    const date = String(body.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Body must include date as YYYY-MM-DD' });
    }
    if (!dateAllowed(date)) {
      return res.status(400).json({ error: 'Date is more than 400 days from today' });
    }
    if (!Array.isArray(body.recipeIds)) {
      return res.status(400).json({ error: 'Body must include a recipeIds array' });
    }

    const ids = body.recipeIds
      .map((id) => String(id).trim())
      .filter((id) => ID_PATTERN.test(id))
      .slice(0, 10);

    try {
      const stored = await kv.get(key);
      const current = readPlan(stored);
      const days = { ...(current.days || {}) };

      // Dates outside the window can never be edited again, so they are
      // dropped rather than left to fill the cap with history.
      for (const d of Object.keys(days)) {
        if (!dateAllowed(d)) delete days[d];
      }

      const isNewDate = !Object.prototype.hasOwnProperty.call(days, date);
      if (ids.length > 0 && isNewDate) {
        // At the cap, make room by dropping the oldest PAST days before
        // refusing the new one.
        const today = new Date().toISOString().slice(0, 10);
        const oldestFirst = Object.keys(days).sort();
        while (oldestFirst.length >= MAX_DAYS && oldestFirst[0] < today) {
          delete days[oldestFirst.shift()];
        }
        if (Object.keys(days).length >= MAX_DAYS) {
          return res.status(400).json({ error: `A plan holds at most ${MAX_DAYS} days` });
        }
      }

      // The cap above is a limit, not a conflict, so it answers first. Then a
      // shared bucket with data needs to say which version it edited.
      if (missingBaseForShared({
        deviceId,
        stored: Object.keys(days).length ? stored : null,
        baseUpdatedAt: body.baseUpdatedAt,
        hasData: Object.keys(days).length > 0,
      })) {
        return res.status(409).json({ error: 'conflict', current });
      }
      if (ids.length === 0) {
        delete days[date];
      } else {
        days[date] = ids;
      }

      const payload = { days, updatedAt: Date.now() };
      // Compare-and-set, exactly as the shopping list does.
      const written = await writeBucket(kv, key, payload, {
        baseUpdatedAt: body.baseUpdatedAt,
        setOptions: bucketSetOptions(req),
      });
      if (!written.ok) return res.status(409).json({ error: 'conflict', current: readPlan(written.current) });
      return res.status(200).json(payload);
    } catch (e) {
      return sendServerError(res, e);
    }
  }

  // DELETE: clear the whole plan for this device
  if (req.method === 'DELETE') {
    try {
      await kv.del(key);
      return res.status(200).json({ success: true });
    } catch (e) {
      return sendServerError(res, e);
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
