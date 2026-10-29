import test from 'node:test';
import assert from 'node:assert';

import { loadClientUtils } from './helpers/load-client.js';

// Everything here runs against js/utils.js exactly as the browser loads it.
const RC = loadClientUtils();

test('js/utils.js assigns one global and nothing else', () => {
  const expected = ['parseIngredientLine', 'formatQty', 'normalizeIngredientName', 'parseTimersFromStep',
    'createTimer', 'pauseTimer', 'resumeTimer', 'addTime', 'remainingMs', 'isDone', 'formatDuration',
    'isCookStateFresh', 'classifyAisle', 'mergeShoppingItems', 'matchRecipesToPantry', 'cookStats'];
  assert.equal(Object.keys(RC).sort().join(','), expected.slice().sort().join(','));
});

test('parseIngredientLine reads quantities, units and names', () => {
  const cases = [
    ['2 cups flour', { qty: 2, unit: 'cup', name: 'flour' }],
    ['1 1/2 tsp salt', { qty: 1.5, unit: 'tsp', name: 'salt' }],
    ['1½ cups milk', { qty: 1.5, unit: 'cup', name: 'milk' }],
    ['½ cup sugar', { qty: 0.5, unit: 'cup', name: 'sugar' }],
    ['3/4 lb ground beef', { qty: 0.75, unit: 'lb', name: 'ground beef' }],
    ['2-3 cloves garlic', { qty: 2, unit: 'clove', name: 'garlic' }],
    ['2 to 3 tablespoons olive oil', { qty: 2, unit: 'tbsp', name: 'olive oil' }],
    ['a pinch of salt', { qty: null, unit: 'pinch', name: 'salt' }],
    ['an ounce of butter', { qty: null, unit: 'oz', name: 'butter' }],
    ['3 eggs', { qty: 3, unit: '', name: 'eggs' }],
    ['1 kilogram potatoes', { qty: 1, unit: 'kg', name: 'potatoes' }],
    ['2 cups flour, sifted', { qty: 2, unit: 'cup', name: 'flour' }],
    ['1 l stock', { qty: 1, unit: 'l', name: 'stock' }],
  ];
  for (const [line, expected] of cases) {
    const got = RC.parseIngredientLine(line);
    assert.strictEqual(got.qty, expected.qty, `qty for ${line}`);
    assert.strictEqual(got.unit, expected.unit, `unit for ${line}`);
    assert.strictEqual(got.name, expected.name, `name for ${line}`);
    assert.strictEqual(got.raw, line, `raw for ${line}`);
  }
});

test('parseIngredientLine copes with empty and unit-only input', () => {
  // The object comes from the vm realm, so compare fields, not prototypes.
  const empty = RC.parseIngredientLine('');
  assert.strictEqual(empty.qty, null);
  assert.strictEqual(empty.unit, '');
  assert.strictEqual(empty.name, '');
  assert.strictEqual(empty.raw, '');
  assert.strictEqual(RC.parseIngredientLine(null).qty, null);
  const salt = RC.parseIngredientLine('Salt');
  assert.strictEqual(salt.qty, null);
  assert.strictEqual(salt.name, 'Salt');
});

test('parseIngredientLine prefers the lower number in a range', () => {
  assert.strictEqual(RC.parseIngredientLine('2–3 cloves garlic').qty, 2);
  assert.strictEqual(RC.parseIngredientLine('4 to 6 slices bread').qty, 4);
});

test('formatQty rounds to a common fraction within the inherited tolerance', () => {
  // js/app.js used a 0.03 window around each common fraction. Kept as-is so
  // scaled ingredients render exactly as they always have; 0.1 therefore
  // reads as 1/8 rather than 0.1.
  assert.strictEqual(RC.formatQty(0.1), '1/8');
  assert.strictEqual(RC.formatQty(0.5), '1/2');
});

test('formatQty renders whole numbers and common fractions', () => {
  assert.strictEqual(RC.formatQty(2), '2');
  assert.strictEqual(RC.formatQty(1.5), '1 1/2');
  assert.strictEqual(RC.formatQty(2.5), '2 1/2');
  assert.strictEqual(RC.formatQty(0.25), '1/4');
  assert.strictEqual(RC.formatQty(0.75), '3/4');
  assert.strictEqual(RC.formatQty(1 / 3), '1/3');
  assert.strictEqual(RC.formatQty(2.25), '2 1/4');
  assert.strictEqual(RC.formatQty(0.2), '0.2');
  assert.strictEqual(RC.formatQty(0), '');
  assert.strictEqual(RC.formatQty(-1), '');
  assert.strictEqual(RC.formatQty(NaN), '');
});

test('normalizeIngredientName strips prep words, parentheses and plurals', () => {
  const cases = [
    ['Fresh ripe tomatoes (drained)', 'tomato'],
    ['Chopped fresh basil', 'basil'],
    ['Onions', 'onion'],
    ['Berries', 'berry'],
    ['Leaves', 'leaf'],
    ['Asparagus', 'asparagus'],
    ['Grass', 'grass'],
  ];
  for (const [input, expected] of cases) {
    assert.strictEqual(RC.normalizeIngredientName(input), expected, `normalize ${input}`);
  }
});

test('normalizeIngredientName applies the synonym map', () => {
  const cases = [
    ['Scallions', 'green onion'],
    ['Coriander leaves', 'cilantro leaf'],
    ['Garbanzo beans', 'chickpea'],
    ['Courgette', 'zucchini'],
    ['Aubergine', 'eggplant'],
    ['Caster sugar', 'sugar'],
    ['Confectioners sugar', 'powdered sugar'],
  ];
  for (const [input, expected] of cases) {
    assert.strictEqual(RC.normalizeIngredientName(input), expected, `normalize ${input}`);
  }
});

test('normalizeIngredientName is safe on empty input', () => {
  assert.strictEqual(RC.normalizeIngredientName(''), '');
  assert.strictEqual(RC.normalizeIngredientName(null), '');
  assert.strictEqual(RC.normalizeIngredientName('   '), '');
});

test('loading the client utils does not need a DOM', () => {
  // The loader uses a bare vm context; if utils.js touched document or window
  // at load, this whole file would already have thrown.
  assert.strictEqual(typeof RC.parseIngredientLine, 'function');
});

// ---- timers (task 7) ----
test('parseTimersFromStep reads the durations a recipe actually writes', () => {
  const cases = [
    ['Simmer for 25 minutes.', 1, '25 min', 1500],
    ['Bake 25 min.', 1, '25 min', 1500],
    ['Rest 25 mins.', 1, '25 min', 1500],
    ['Roast for 1 hour.', 1, '1 hr', 3600],
    ['Chill 2 hrs.', 1, '2 hr', 7200],
    ['Blanch 30 seconds.', 1, '30 sec', 30],
    ['Cook 10-12 minutes.', 1, '10-12 min', 600],
    ['Cook 10 to 12 minutes.', 1, '10-12 min', 600],
    ['Braise 1 1/2 hours.', 1, '1 1/2 hr', 5400],
    ['Braise 1½ hours.', 1, '1½ hr', 5400],
    ['Wait an hour.', 1, '1 hr', 3600],
    ['Rest half an hour.', 1, '30 min', 1800],
    ['Steep a minute.', 1, '1 min', 60],
  ];
  for (const [text, count, label, seconds] of cases) {
    const found = RC.parseTimersFromStep(text);
    assert.equal(found.length, count, text);
    assert.equal(found[0].label, label, text);
    assert.equal(found[0].seconds, seconds, text);
  }
});

test('parseTimersFromStep ignores things that only look like durations', () => {
  const negatives = [
    'Heat the oven to 350 degrees.',
    'Add 2 cups of flour.',
    'Stir in 3 eggs.',
    'Stand for 25 hours.',
    'Serves 4 people.',
    '',
  ];
  for (const text of negatives) {
    assert.deepEqual(RC.parseTimersFromStep(text), [], text);
  }
  assert.deepEqual(RC.parseTimersFromStep(null), []);
  assert.deepEqual(RC.parseTimersFromStep(undefined), []);
});

test('parseTimersFromStep finds several timers in one step', () => {
  const found = RC.parseTimersFromStep('Bake 10 minutes, then rest 5 minutes and cool 2 hrs.');
  assert.equal(found.length, 3);
  assert.deepEqual(found.map((t) => t.seconds), [600, 300, 7200]);
});

test('a timer counts down, pauses, resumes and gains time', () => {
  const now = 1_000_000;
  const t = RC.createTimer({ id: 'x', label: '25 min', seconds: 1500, now });
  assert.equal(t.totalMs, 1_500_000);
  assert.equal(t.endsAt, now + 1_500_000);
  assert.equal(t.pausedRemainingMs, null);
  assert.equal(RC.remainingMs(t, now), 1_500_000);
  assert.equal(RC.isDone(t, now), false);

  const later = now + 600_000;
  assert.equal(RC.remainingMs(t, later), 900_000);

  const paused = RC.pauseTimer(t, later);
  assert.equal(paused.pausedRemainingMs, 900_000);
  // A paused timer does not lose time while the phone sits in a pocket.
  assert.equal(RC.remainingMs(paused, later + 60_000_000), 900_000);

  const resumed = RC.resumeTimer(paused, later + 60_000_000);
  assert.equal(resumed.pausedRemainingMs, null);
  assert.equal(resumed.endsAt, later + 60_000_000 + 900_000);

  // Resumed at later+60M, so measure from that moment, not from "later".
  const atResume = later + 60_000_000;
  const longer = RC.addTime(resumed, 60_000, atResume);
  assert.equal(RC.remainingMs(longer, atResume), 960_000);

  // Adding time to a paused timer extends the pause, not the end time.
  const pausedLonger = RC.addTime(RC.pauseTimer(t, later), 60_000, later);
  assert.equal(pausedLonger.pausedRemainingMs, 960_000);
});

test('a timer clamps at zero and reports done', () => {
  const t = RC.createTimer({ id: 'x', label: '1 min', seconds: 60, now: 0 });
  assert.equal(RC.isDone(t, 59_999), false);
  assert.equal(RC.isDone(t, 60_000), true);
  assert.equal(RC.remainingMs(t, 999_999), 0);
});

test('addTime restarts a finished timer from now', () => {
  const t = RC.createTimer({ id: 'x', label: '1 min', seconds: 60, now: 0 });
  const now = 500_000;
  assert.equal(RC.isDone(t, now), true);
  const restarted = RC.addTime(t, 60_000, now);
  assert.equal(RC.isDone(restarted, now), false);
  assert.equal(RC.remainingMs(restarted, now), 60_000);
});

test('formatDuration reads like a clock', () => {
  assert.equal(RC.formatDuration(0), '0:00');
  assert.equal(RC.formatDuration(59_000), '0:59');
  assert.equal(RC.formatDuration(65_000), '1:05');
  assert.equal(RC.formatDuration(3_600_000), '1:00:00');
  assert.equal(RC.formatDuration(90_061_000), '25:01:01');
  assert.equal(RC.formatDuration(-1), '0:00');
});

test('cook state expires after a day', () => {
  const now = 1_000_000_000;
  assert.equal(RC.isCookStateFresh({ ts: now - 1000 }, now), true);
  assert.equal(RC.isCookStateFresh({ ts: now - 86_400_000 }, now), false);
  assert.equal(RC.isCookStateFresh({ ts: now - 86_399_000 }, now), true);
  assert.equal(RC.isCookStateFresh({}, now), false);
  assert.equal(RC.isCookStateFresh(null, now), false);
  assert.equal(RC.isCookStateFresh({ ts: now + 5_000 }, now), false);
});

// ---- cooking log stats (task 11) ----
test('cookStats of an empty or missing log', () => {
  const empty = RC.cookStats([]);
  assert.equal(empty.count, 0);
  assert.equal(empty.lastDate, null);
  assert.equal(empty.avgRating, null);
  assert.equal(RC.cookStats(undefined).count, 0);
});

test('cookStats counts, finds the newest date and averages one decimal', () => {
  const stats = RC.cookStats([
    { id: 'a', date: '2025-10-02', rating: 4 },
    { id: 'b', date: '2025-10-12', rating: 5 },
    { id: 'c', date: '2025-09-01', rating: null },
  ]);
  assert.equal(stats.count, 3);
  assert.equal(stats.lastDate, '2025-10-12');
  assert.equal(stats.avgRating, 4.5);
});

test('cookStats rounds to one decimal and ignores bad ratings', () => {
  assert.equal(RC.cookStats([{ date: '2025-01-01', rating: 4 }, { date: '2025-01-02', rating: 4 }, { date: '2025-01-03', rating: 5 }]).avgRating, 4.3);
  assert.equal(RC.cookStats([{ date: '2025-01-01', rating: 9 }, { date: '2025-01-02', rating: null }]).avgRating, null);
});
