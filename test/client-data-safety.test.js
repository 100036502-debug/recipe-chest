// Tests for the client-side data-safety decisions in js/app.js:
//   - a failed list load is not an empty list, and must block writes;
//   - Undo is only offered when the server says it kept a copy.
//
// js/app.js is a classic script, so the pure helpers are extracted by name and
// evaluated in a vm context (same harness as test/import-queue.test.js). If a
// helper is renamed, the extraction fails loudly rather than testing nothing.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appSource = fs.readFileSync(path.join(here, '..', 'js', 'app.js'), 'utf8');

function loadHelpers(names) {
  const parts = names.map((name) => {
    const start = appSource.indexOf(`\nfunction ${name}(`);
    assert.ok(start >= 0, `js/app.js no longer defines ${name}()`);
    const end = appSource.indexOf('\n}\n', start);
    assert.ok(end > start, `could not find the end of ${name}()`);
    return appSource.slice(start + 1, end + 2);
  });
  const ctx = vm.createContext({});
  vm.runInContext(parts.join('\n'), ctx);
  return ctx;
}

const app = loadHelpers(['loadOutcome', 'listWriteBlocked', 'undoOffer']);

// ---------- loadOutcome: "no list yet" vs "the load failed" ----------

test('loadOutcome reports a failed load as unknown, never as an empty list', () => {
  const out = app.loadOutcome(false, null);
  assert.equal(out.status, 'failed');
  assert.equal(out.data, null, 'a failed load must not hand back a body to save');
  assert.equal(app.loadOutcome(false, { items: [] }).status, 'failed');
});

test('loadOutcome accepts a real empty list from the server as a successful load', () => {
  const out = app.loadOutcome(true, { items: [], updatedAt: null });
  assert.equal(out.status, 'ok');
  assert.deepEqual(out.data.items, []);
});

test('loadOutcome tolerates a missing or non-object body on a 2xx', () => {
  assert.equal(app.loadOutcome(true, null).status, 'ok');
  assert.deepEqual(app.loadOutcome(true, null).data, {});
  assert.deepEqual(app.loadOutcome(true, [1, 2]).data, {});
  assert.deepEqual(app.loadOutcome(true, { items: ['a'] }).data, { items: ['a'] });
});

// ---------- listWriteBlocked: no write until a load has succeeded ----------

test('listWriteBlocked allows a write only after a successful load', () => {
  assert.equal(app.listWriteBlocked('ok'), false);
});

test('listWriteBlocked blocks every other state, including "not loaded yet"', () => {
  for (const state of ['failed', 'unknown', 'loading', undefined, null, '']) {
    assert.equal(app.listWriteBlocked(state), true, `${String(state)} must block writes`);
  }
});

test('a failed load cannot become a writable empty list', () => {
  // The bug: GET fails -> local list becomes {items: []} -> POST replaces the
  // server's real list. The decision that prevents it:
  const out = app.loadOutcome(false, null);
  assert.equal(app.listWriteBlocked(out.status), true);
  // ...while a genuinely empty list from the server may be written back.
  assert.equal(app.listWriteBlocked(app.loadOutcome(true, { items: [] }).status), false);
});

// ---------- undoOffer: never promise an undo that cannot work ----------

test('undoOffer offers Undo when the server kept a copy, and carries the window', () => {
  const offer = app.undoOffer(true, { success: true, undoable: true, undoWindowSeconds: 600 });
  assert.deepEqual(offer, { offer: true, seconds: 600 });
});

test('undoOffer offers nothing when the server did not keep a copy', () => {
  assert.equal(app.undoOffer(true, { success: true, undoable: false, undoWindowSeconds: 0 }).offer, false);
  assert.equal(app.undoOffer(true, { success: true }).offer, false);
  assert.equal(app.undoOffer(true, null).offer, false);
});

test('undoOffer offers nothing when the delete itself failed', () => {
  assert.equal(app.undoOffer(false, { undoable: true, undoWindowSeconds: 600 }).offer, false);
});

test('undoOffer falls back to "no known window" rather than inventing one', () => {
  const offer = app.undoOffer(true, { undoable: true });
  assert.equal(offer.offer, true);
  assert.equal(offer.seconds, 0);
  assert.equal(app.undoOffer(true, { undoable: true, undoWindowSeconds: 'abc' }).seconds, 0);
});
