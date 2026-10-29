import test from 'node:test';
import assert from 'node:assert';

import { cleanItems, decideWrite } from '../lib/shopping-list.js';

test('decideWrite allows a write when the client sent no baseUpdatedAt', () => {
  // An older client that does not send the field keeps last-write-wins.
  assert.deepEqual(decideWrite({ stored: { updatedAt: 99 }, baseUpdatedAt: undefined }), { write: true });
  assert.deepEqual(decideWrite({ stored: { updatedAt: 99 }, baseUpdatedAt: null }), { write: true });
});

test('decideWrite allows a write when the stored list has not moved on', () => {
  assert.deepEqual(decideWrite({ stored: { updatedAt: 100 }, baseUpdatedAt: 100 }), { write: true });
  assert.deepEqual(decideWrite({ stored: { updatedAt: 100 }, baseUpdatedAt: 101 }), { write: true });
});

test('decideWrite refuses a write that would clobber a newer list', () => {
  const current = { items: [{ text: 'milk', checked: false }], updatedAt: 200 };
  const verdict = decideWrite({ stored: current, baseUpdatedAt: 100 });
  assert.equal(verdict.write, false);
  assert.deepEqual(verdict.current, current);
});

test('decideWrite writes when there is nothing stored yet', () => {
  assert.deepEqual(decideWrite({ stored: null, baseUpdatedAt: 100 }), { write: true });
});

test('decideWrite writes when the stored list has no timestamp', () => {
  assert.deepEqual(decideWrite({ stored: { items: [] }, baseUpdatedAt: 100 }), { write: true });
});

test('decideWrite ignores a baseUpdatedAt that is not a number', () => {
  assert.deepEqual(decideWrite({ stored: { updatedAt: 5 }, baseUpdatedAt: 'later' }), { write: true });
});

test('cleanItems trims, drops blanks and keeps the three known fields', () => {
  const out = cleanItems([
    { text: '  milk  ', checked: 1, recipeId: 'r1' },
    { text: '   ', checked: true },
    { text: 'eggs' },
    null,
  ]);
  assert.deepEqual(out, [
    { text: 'milk', checked: true, recipeId: 'r1' },
    { text: 'eggs', checked: false, recipeId: null },
  ]);
});

test('cleanItems caps the text length and the number of items', () => {
  const long = cleanItems([{ text: 'x'.repeat(500) }]);
  assert.equal(long[0].text.length, 200);

  const many = cleanItems(Array.from({ length: 250 }, (_, i) => ({ text: 'item ' + i })));
  assert.equal(many.length, 200);
});

test('cleanItems returns null for a body that is not an array', () => {
  assert.equal(cleanItems(undefined), null);
  assert.equal(cleanItems('nope'), null);
  assert.deepEqual(cleanItems([]), []);
});
