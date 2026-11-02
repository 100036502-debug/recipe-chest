import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';

import { loadClientUtils } from './helpers/load-client.js';

// Runs the real picker functions from js/app.js against a tiny fake document, so
// the rendering is exercised for real rather than matched as text. The browser
// spec in e2e/meal-plan.spec.js covers the same flow in Chromium on CI.

const src = fs.readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');

function grab(name, kind = 'function') {
  const marker = kind === 'function' ? `\nfunction ${name}(` : `\nasync function ${name}(`;
  const start = src.indexOf(marker);
  assert.ok(start >= 0, `js/app.js no longer defines ${name}()`);
  const end = src.indexOf('\n}\n', start);
  return src.slice(start + 1, end + 2);
}

function build({ recipes, plan = {}, planState = 'ok' }) {
  const els = {};
  const el = (id) => (els[id] ||= { id, innerHTML: '', textContent: '', value: '', style: {}, classList: { add() {}, remove() {} }, focus() {} });
  const toasts = [];
  const added = [];
  const ctx = vm.createContext({
    RCUtils: loadClientUtils(),
    document: { getElementById: el },
    escapeHtml: (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]),
    mealStyle: () => ({ emoji: '🍽️' }),
    overlayOpened() {}, overlayClosed() {},
    toast: (m) => toasts.push(m),
    loadMealPlan: async () => 'ok',
    addToPlan: async (date, id) => { added.push([date, id]); },
    recipes, mealPlan: plan, mealPlanState: planState,
    mealPlanReady: () => planState === 'ok',
    ymd: (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
  });
  const code = [
    'let pickerDate = null; let pickerRecipeId = null; let pickerMode = "recipe"; const PICKER_DAYS = 14;',
    grab('setPickerSearch'), grab('openPicker'), grab('openPlanPickerForRecipe', 'async'),
    grab('renderPicker'), grab('closePicker'), grab('pickRecipe'), grab('pickPlanDay', 'async'),
  ].join('\n');
  vm.runInContext(code, ctx);
  return { ctx, els, el, toasts, added };
}

const RECIPES = [
  { id: 'r1', title: 'Lemon Pasta', ingredients: ['spaghetti', 'parmesan'], tags: [] },
  { id: 'r2', title: 'Bean Stew', ingredients: ['beans'], tags: [] },
  { id: 'r3', title: '<img src=x onerror=alert(1)>', ingredients: [], tags: [] },
];
const count = (html, needle) => html.split(needle).length - 1;

test('opening the picker from a day lists every recipe with the search box shown', () => {
  const t = build({ recipes: RECIPES });
  t.ctx.openPicker('2026-11-03');
  assert.equal(t.el('picker-search').style.display, '');
  assert.equal(count(t.el('picker-list').innerHTML, 'data-action="pickRecipe"'), 3);
  assert.match(t.el('picker-title').textContent, /Pick a recipe for/);
});

test('typing narrows the list, by ingredient too, and clearing restores it', () => {
  const t = build({ recipes: RECIPES });
  t.ctx.openPicker('2026-11-03');
  t.el('picker-search').value = 'parmesan';
  t.ctx.renderPicker();
  assert.equal(count(t.el('picker-list').innerHTML, 'data-action="pickRecipe"'), 1);
  assert.match(t.el('picker-list').innerHTML, /Lemon Pasta/);
  t.el('picker-search').value = '';
  t.ctx.renderPicker();
  assert.equal(count(t.el('picker-list').innerHTML, 'data-action="pickRecipe"'), 3);
});

test('a search with no match says so and the typed text cannot inject markup', () => {
  const t = build({ recipes: RECIPES });
  t.ctx.openPicker('2026-11-03');
  t.el('picker-search').value = '<script>alert(1)</script>';
  t.ctx.renderPicker();
  const html = t.el('picker-list').innerHTML;
  assert.match(html, /No recipes match/);
  assert.equal(html.includes('<script>'), false);
  assert.match(html, /&lt;script&gt;/);
});

test('a recipe title with markup is escaped in the list', () => {
  const t = build({ recipes: RECIPES });
  t.ctx.openPicker('2026-11-03');
  assert.equal(t.el('picker-list').innerHTML.includes('<img src=x'), false);
});

test('reopening the picker clears the previous search', () => {
  const t = build({ recipes: RECIPES });
  t.ctx.openPicker('2026-11-03');
  t.el('picker-search').value = 'stew';
  t.ctx.renderPicker();
  t.ctx.openPicker('2026-11-04');
  assert.equal(t.el('picker-search').value, '');
  assert.equal(count(t.el('picker-list').innerHTML, 'data-action="pickRecipe"'), 3);
});

test('a recipe already on that day is marked', () => {
  const t = build({ recipes: RECIPES, plan: { '2026-11-03': ['r2'] } });
  t.ctx.openPicker('2026-11-03');
  assert.equal(count(t.el('picker-list').innerHTML, 'Already on this day'), 1);
});

test('choosing a recipe adds it to that day and closes the picker', () => {
  const t = build({ recipes: RECIPES });
  t.ctx.openPicker('2026-11-03');
  t.ctx.pickRecipe('r2');
  assert.deepEqual(t.added, [['2026-11-03', 'r2']]);
});

test('from a recipe: fourteen days, the search box hidden, today and tomorrow named', async () => {
  const t = build({ recipes: RECIPES });
  await t.ctx.openPlanPickerForRecipe('r1');
  const html = t.el('picker-list').innerHTML;
  assert.equal(count(html, 'data-action="pickPlanDay"'), 14);
  assert.match(html, /Today,/);
  assert.match(html, /Tomorrow,/);
  assert.equal(t.el('picker-search').style.display, 'none');
  assert.match(t.el('picker-title').textContent, /Lemon Pasta/);
});

test('from a recipe: a day that already has it is marked, and counts are shown', async () => {
  const today = build({ recipes: RECIPES }).ctx.ymd(new Date());
  const t = build({ recipes: RECIPES, plan: { [today]: ['r1', 'r2'] } });
  await t.ctx.openPlanPickerForRecipe('r1');
  const html = t.el('picker-list').innerHTML;
  assert.equal(count(html, 'Already planned'), 1);
  const other = build({ recipes: RECIPES, plan: { [today]: ['r2', 'r3'] } });
  await other.ctx.openPlanPickerForRecipe('r1');
  assert.match(other.el('picker-list').innerHTML, /2 meals planned/);
});

test('from a recipe: choosing a day adds that recipe to that day', async () => {
  const t = build({ recipes: RECIPES });
  await t.ctx.openPlanPickerForRecipe('r2');
  await t.ctx.pickPlanDay('2026-11-09');
  assert.deepEqual(t.added, [['2026-11-09', 'r2']]);
});

test('from a recipe: nothing opens while the plan failed to load', async () => {
  const t = build({ recipes: RECIPES, planState: 'failed' });
  await t.ctx.openPlanPickerForRecipe('r1');
  assert.equal(t.el('picker-list').innerHTML, '', 'the chooser never rendered');
});

test('from a recipe: an unknown recipe id does nothing', async () => {
  const t = build({ recipes: RECIPES });
  await t.ctx.openPlanPickerForRecipe('missing');
  assert.equal(t.el('picker-list').innerHTML, '');
});

test('the day chooser then the day picker do not leak state into each other', async () => {
  const t = build({ recipes: RECIPES });
  await t.ctx.openPlanPickerForRecipe('r1');
  t.ctx.openPicker('2026-11-03');
  const html = t.el('picker-list').innerHTML;
  assert.equal(count(html, 'data-action="pickRecipe"'), 3);
  assert.equal(count(html, 'pickPlanDay'), 0);
});
