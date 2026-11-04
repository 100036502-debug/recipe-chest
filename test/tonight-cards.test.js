import test from 'node:test';
import assert from 'node:assert';

import { loadClientUtils } from './helpers/load-client.js';

const RC = loadClientUtils();
const TODAY = '2026-11-03';
const cook = (date, rating) => ({ id: 'c' + date, date, ...(rating ? { rating } : {}) });
const recipe = (id, extra) => ({ id, title: 'Recipe ' + id, ...(extra || {}) });

// ---------- minutesFromText: a time is only reported when it can be read ----------

test('times written the usual ways are read', () => {
  const cases = {
    '20 min': 20, '20 mins': 20, '20 minutes': 20, '1 hr': 60, '1 hr 15 mins': 75,
    '1 hour 30 minutes': 90, '1h30': 90, '1h 30m': 90, '45': 45, 'about 1.5 hours': 90,
    '15 minutes + 1 hr resting': 75,
  };
  for (const [text, want] of Object.entries(cases)) assert.equal(RC.minutesFromText(text), want, text);
});

test('text that is not a time reads as nothing, never as a guess', () => {
  for (const text of ['', null, undefined, 'overnight', '2 days', 'a few minutes', 'serves 4', '0 min', 'quick', '99 hours']) {
    assert.equal(RC.minutesFromText(text), null, String(text));
  }
});

test('ready-in adds prep and cook, and uses one when only one is readable', () => {
  assert.equal(RC.readyInMinutes({ prepTime: '10 min', cookTime: '15 min' }), 25);
  assert.equal(RC.readyInMinutes({ prepTime: '10 min' }), 10);
  assert.equal(RC.readyInMinutes({ cookTime: 'overnight', prepTime: '5 min' }), 5);
  assert.equal(RC.readyInMinutes({ prepTime: 'overnight' }), null);
  assert.equal(RC.readyInMinutes({}), null);
  assert.equal(RC.readyInMinutes(null), null);
});

// ---------- cardCaption: only what the data supports ----------

test('a recipe never cooked says so', () => {
  assert.equal(RC.cardCaption(recipe('a'), TODAY), 'Never cooked');
  assert.equal(RC.cardCaption(recipe('a', { cookLog: [] }), TODAY), 'Never cooked');
});

test('a cooked recipe says when, how often and how it rated', () => {
  assert.equal(RC.cardCaption(recipe('a', { cookLog: [cook('2026-11-01', 5)] }), TODAY), 'Cooked this week · 1× · ★ 5');
  assert.equal(RC.cardCaption(recipe('a', { cookLog: [cook('2026-10-12', 5), cook('2026-10-20', 4)] }), TODAY), 'Cooked last month · 2× · ★ 4.5');
  assert.equal(RC.cardCaption(recipe('a', { cookLog: [cook('2026-11-01')] }), TODAY), 'Cooked this week · 1×', 'no rating, no star');
});

test('an older cook is not called "last month"', () => {
  assert.equal(RC.cardCaption(recipe('a', { cookLog: [cook('2025-01-05', 3)] }), TODAY), 'Cooked before · 1× · ★ 3');
  assert.equal(RC.cardCaption(recipe('a', { cookLog: [cook('2026-09-20', 3)] }), TODAY), 'Cooked before · 1× · ★ 3');
});

test('without a date to compare to, only the count is claimed', () => {
  assert.equal(RC.cardCaption(recipe('a', { cookLog: [cook('2026-10-12', 5)] })), 'Cooked before · 1× · ★ 5');
});

test('last month is last month across a year boundary', () => {
  assert.match(RC.cardCaption(recipe('a', { cookLog: [cook('2026-12-15', 5)] }), '2027-01-10'), /^Cooked last month/);
});

// ---------- cardMeta ----------

test('the meta line is the meal type then one more true fact', () => {
  assert.equal(RC.cardMeta(recipe('a', { tags: ['vegetarian', 'quick'] }), 'Dinner'), 'Dinner · vegetarian');
  assert.equal(RC.cardMeta(recipe('a', { prepTime: '20 min' }), 'Dinner'), 'Dinner · 20 min');
  assert.equal(RC.cardMeta(recipe('a'), 'Dinner'), 'Dinner');
  assert.equal(RC.cardMeta(recipe('a', { tags: ['', '  '] }), 'Dinner'), 'Dinner');
  assert.equal(RC.cardMeta(null, 'Dinner'), '');
});

// ---------- pickSuggestions ----------

test('three real recipes are suggested: one never cooked, one quick, one cooked before', () => {
  const list = [
    recipe('cooked', { cookLog: [cook('2026-10-10', 5)] }),
    recipe('never', {}),
    recipe('quick', { prepTime: '5 min', cookTime: '10 min' }),
  ];
  const out = RC.pickSuggestions(list, TODAY, 3);
  assert.equal(out.length, 3);
  const byId = Object.fromEntries(out.map((s) => [s.recipe.id, s.caption]));
  assert.equal(byId.never, 'Never cooked');
  assert.equal(byId.quick, 'Ready in 15 minutes', 'the quick one shows its time');
  assert.match(byId.cooked, /^Cooked last month · 1× · ★ 5$/);
});

test('a quick recipe that has not been cooked shows its time', () => {
  const list = [recipe('q', { prepTime: '5 min', cookTime: '10 min' }), recipe('n')];
  const out = RC.pickSuggestions(list, TODAY, 3);
  const q = out.find((s) => s.recipe.id === 'q');
  // 'n' is the never-cooked pick, so q takes the quick slot and its time.
  assert.equal(q.caption, 'Ready in 15 minutes');
});

test('a cooked recipe never loses its cook line to a time caption', () => {
  const list = [recipe('a', { prepTime: '5 min', cookLog: [cook('2026-11-01', 4)] })];
  const out = RC.pickSuggestions(list, TODAY, 3);
  assert.equal(out[0].caption, 'Cooked this week · 1× · ★ 4');
});

test('no recipe is suggested twice, and fewer than three recipes gives fewer cards', () => {
  const one = RC.pickSuggestions([recipe('a')], TODAY, 3);
  assert.equal(one.length, 1);
  const many = RC.pickSuggestions(Array.from({ length: 10 }, (_, i) => recipe('r' + i)), TODAY, 3);
  assert.equal(many.length, 3);
  assert.equal(new Set(many.map((s) => s.recipe.id)).size, 3);
});

test('captions are never invented: every caption is one of the true forms', () => {
  const list = [
    recipe('a'), recipe('b', { prepTime: 'overnight' }), recipe('c', { prepTime: 'serves 4' }),
    recipe('d', { cookLog: [cook('2020-01-01', 2)] }), recipe('e', { prepTime: '10 min' }),
  ];
  for (const { caption } of RC.pickSuggestions(list, TODAY, 3)) {
    assert.match(caption, /^(Never cooked|Ready in \d+ minutes|Cooked (this week|this month|last month|before) · \d+×( · ★ [\d.]+)?)$/, caption);
  }
});

test('an empty or bad list gives no suggestions rather than an error', () => {
  assert.deepEqual(RC.pickSuggestions([], TODAY, 3), []);
  assert.deepEqual(RC.pickSuggestions(null, TODAY, 3), []);
  assert.deepEqual(RC.pickSuggestions([null, {}, { id: 'x' }], TODAY, 3), [], 'a recipe needs an id and a title');
});

test('the same input always gives the same suggestions', () => {
  const list = [recipe('a'), recipe('b', { prepTime: '5 min' }), recipe('c', { cookLog: [cook('2026-10-01', 5)] })];
  assert.deepEqual(RC.pickSuggestions(list, TODAY, 3), RC.pickSuggestions(list, TODAY, 3));
});
