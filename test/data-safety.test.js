// Tests for the two data-safety decisions made on the server side:
//   1. a backup restore asks whether `recipe:<id>` is actually stored, not
//      whether the id appears in `recipe_ids`;
//   2. a delete keeps a short-lived copy that Undo can restore.
import { test } from 'node:test';
import assert from 'node:assert';
import { restoreDecision } from '../lib/recipes.js';
import {
  TRASH_TTL_SECONDS,
  buildTrashEntry,
  isRestorable,
  trashKey,
} from '../lib/trash.js';

// ---------- restoreDecision: existence is the stored value ----------

test('restoreDecision skips a recipe that is genuinely still stored', () => {
  const decision = restoreDecision({ id: 'r_1', title: 'Curry' }, true);
  assert.deepEqual(decision, { write: false, addToList: false });
});

test('restoreDecision restores a recipe whose id is listed but whose value is gone', () => {
  // This is the half-failed delete / dropped Redis key case: the id survives in
  // recipe_ids with nothing behind it, and the backup must be able to repair it.
  const decision = restoreDecision(null, true);
  assert.equal(decision.write, true);
  assert.equal(decision.addToList, false, 'the id is already listed, so it must not be pushed twice');
});

test('restoreDecision restores and lists a recipe that is completely absent', () => {
  assert.deepEqual(restoreDecision(undefined, false), { write: true, addToList: true });
  assert.deepEqual(restoreDecision(null, false), { write: true, addToList: true });
});

test('restoreDecision never treats an empty/falsy stored value as an existing recipe', () => {
  for (const stored of [null, undefined, '', 0, false]) {
    assert.equal(restoreDecision(stored, true).write, true, `${JSON.stringify(stored)} must not count as present`);
  }
});

// ---------- trash entries: only offer an undo that can work ----------

test('buildTrashEntry keeps the recipe and its photo for the undo window', () => {
  const recipe = { id: 'r_1', title: 'Curry' };
  const entry = buildTrashEntry(recipe, 'PHOTO', 'THUMB', 1700000000000);
  assert.equal(entry.recipe, recipe);
  assert.equal(entry.photo, 'PHOTO');
  assert.equal(entry.photothumb, 'THUMB');
  assert.equal(entry.deletedAt, 1700000000000);
});

test('buildTrashEntry omits photo keys that are missing or not strings', () => {
  const entry = buildTrashEntry({ id: 'r_1' }, null, undefined, 1);
  assert.equal('photo' in entry, false);
  assert.equal('photothumb' in entry, false);
  const partial = buildTrashEntry({ id: 'r_1' }, 'PHOTO', 42, 1);
  assert.equal(partial.photo, 'PHOTO');
  assert.equal('photothumb' in partial, false);
});

test('buildTrashEntry returns null when there is no recipe, so the delete reports not undoable', () => {
  assert.equal(buildTrashEntry(null, 'PHOTO', 'THUMB'), null);
  assert.equal(buildTrashEntry(undefined), null);
  assert.equal(buildTrashEntry('a string'), null);
  assert.equal(buildTrashEntry([]), null);
});

test('trash entries expire, and only a real entry is restorable', () => {
  assert.ok(TRASH_TTL_SECONDS > 0 && TRASH_TTL_SECONDS <= 3600);
  assert.equal(trashKey('r_1'), 'trash:r_1');
  assert.equal(isRestorable(null), false);
  assert.equal(isRestorable({}), false);
  assert.equal(isRestorable({ deletedAt: 1 }), false);
  assert.equal(isRestorable(buildTrashEntry({ id: 'r_1' })), true);
});
