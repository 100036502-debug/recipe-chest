import test from 'node:test';
import assert from 'node:assert';

import { loadClientUtils } from './helpers/load-client.js';

const RC = loadClientUtils();

// ---------- ymdOf / parseYmd ----------

test('a date key uses local parts, so an evening stays on its own day', () => {
  assert.equal(RC.ymdOf(new Date(2026, 10, 3, 23, 59, 59)), '2026-11-03');
  assert.equal(RC.ymdOf(new Date(2026, 10, 3, 0, 0, 1)), '2026-11-03');
  assert.equal(RC.ymdOf(new Date(2026, 0, 5)), '2026-01-05');
});

test('parseYmd reads real dates and refuses everything else', () => {
  assert.equal(RC.ymdOf(RC.parseYmd('2026-11-03')), '2026-11-03');
  assert.equal(RC.parseYmd('2026-11-03').getHours(), 12, 'noon, clear of any DST shift');
  for (const bad of ['', null, undefined, '2026-13-01', '2026-02-30', '2026-2-3', '03/11/2026', 'tomorrow', '2026-11-03T10:00', 2026]) {
    assert.equal(RC.parseYmd(bad), null, String(bad));
  }
  assert.ok(RC.parseYmd('2028-02-29'), 'a leap day is real');
  assert.equal(RC.parseYmd('2027-02-29'), null, 'and not in a common year');
});

// ---------- monthGrid ----------

const flat = (g) => g.flat();

test('every row has seven days and there are four to six rows', () => {
  for (let y = 2024; y <= 2028; y += 1) {
    for (let m = 0; m < 12; m += 1) {
      const g = RC.monthGrid(y, m);
      assert.ok(g.length >= 4 && g.length <= 6, `${y}-${m + 1} has ${g.length} rows`);
      for (const row of g) assert.equal(row.length, 7);
    }
  }
});

test('the grid is consecutive days with no gap or repeat', () => {
  for (let y = 2025; y <= 2027; y += 1) {
    for (let m = 0; m < 12; m += 1) {
      const days = flat(RC.monthGrid(y, m));
      for (let i = 1; i < days.length; i += 1) {
        assert.equal(days[i].date, RC.shiftDay(days[i - 1].date, 1), `${y}-${m + 1} day ${i}`);
      }
    }
  }
});

test('the first column is Sunday, and the 1st lands in the right column', () => {
  // 1 Nov 2026 is a Sunday; 1 Mar 2026 is a Sunday; 1 Jan 2026 is a Thursday.
  assert.equal(RC.monthGrid(2026, 10)[0][0].date, '2026-11-01');
  assert.equal(RC.monthGrid(2026, 10)[0][0].inMonth, true);
  const jan = RC.monthGrid(2026, 0)[0];
  assert.equal(jan[4].date, '2026-01-01', 'Thursday is the fifth column');
  assert.equal(jan[0].date, '2025-12-28');
  assert.equal(jan[0].inMonth, false, 'the days before are marked as outside the month');
});

test('only the month\'s own days are marked in the month', () => {
  for (const [y, m, n] of [[2026, 1, 28], [2028, 1, 29], [2026, 10, 30], [2026, 11, 31]]) {
    assert.equal(flat(RC.monthGrid(y, m)).filter((d) => d.inMonth).length, n, `${y}-${m + 1}`);
  }
});

test('a month that fits exactly in four weeks gets four rows, not a blank fifth', () => {
  // Feb 2026 starts on a Sunday and has 28 days.
  assert.equal(RC.monthGrid(2026, 1).length, 4);
  assert.equal(flat(RC.monthGrid(2026, 1)).every((d) => d.inMonth), true);
});

test('a month spanning six weeks gets six rows', () => {
  // Aug 2026 starts on a Saturday and has 31 days.
  assert.equal(RC.monthGrid(2026, 7).length, 6);
});

test('the grid crosses a daylight-saving change without skipping a day', () => {
  // US clocks change 8 Mar 2026 and 1 Nov 2026.
  const mar = flat(RC.monthGrid(2026, 2)).map((d) => d.date);
  assert.ok(mar.includes('2026-03-08') && mar.includes('2026-03-09'));
  assert.equal(new Set(mar).size, mar.length);
  const nov = flat(RC.monthGrid(2026, 10)).map((d) => d.date);
  assert.ok(nov.includes('2026-11-01') && nov.includes('2026-11-02'));
  assert.equal(new Set(nov).size, nov.length);
});

// ---------- shiftMonth / shiftDay ----------

test('months roll over the year in both directions', () => {
  assert.deepEqual(RC.shiftMonth(2026, 11, 1), { year: 2027, month: 0 });
  assert.deepEqual(RC.shiftMonth(2026, 0, -1), { year: 2025, month: 11 });
  assert.deepEqual(RC.shiftMonth(2026, 5, 0), { year: 2026, month: 5 });
  assert.deepEqual(RC.shiftMonth(2026, 0, 14), { year: 2027, month: 2 });
});

test('days step across month ends, leap days and daylight saving', () => {
  assert.equal(RC.shiftDay('2026-11-30', 1), '2026-12-01');
  assert.equal(RC.shiftDay('2026-12-31', 1), '2027-01-01');
  assert.equal(RC.shiftDay('2027-01-01', -1), '2026-12-31');
  assert.equal(RC.shiftDay('2028-02-28', 1), '2028-02-29');
  assert.equal(RC.shiftDay('2027-02-28', 1), '2027-03-01');
  assert.equal(RC.shiftDay('2026-03-08', 1), '2026-03-09', 'spring forward');
  assert.equal(RC.shiftDay('2026-11-01', 1), '2026-11-02', 'fall back');
  assert.equal(RC.shiftDay('2026-11-01', 7), '2026-11-08');
  assert.equal(RC.shiftDay('nonsense', 1), null);
});

// ---------- dayChips ----------

const byId = { a: { title: 'Lemon Pasta' }, b: { title: 'Bean Stew' }, c: { title: 'Pad Thai' }, d: { title: 'Dal' } };

test('a day shows up to two chips and counts the rest', () => {
  const plan = { '2026-11-03': ['a', 'b', 'c', 'd'] };
  assert.deepEqual(RC.dayChips(plan, '2026-11-03', byId), { shown: ['Lemon Pasta', 'Bean Stew'], more: 2, total: 4 });
  assert.deepEqual(RC.dayChips(plan, '2026-11-03', byId, 3), { shown: ['Lemon Pasta', 'Bean Stew', 'Pad Thai'], more: 1, total: 4 });
});

test('one or two meals show no "more"', () => {
  assert.deepEqual(RC.dayChips({ x: ['a'] }, 'x', byId), { shown: ['Lemon Pasta'], more: 0, total: 1 });
  assert.deepEqual(RC.dayChips({ x: ['a', 'b'] }, 'x', byId), { shown: ['Lemon Pasta', 'Bean Stew'], more: 0, total: 2 });
});

test('an empty or unplanned day shows nothing', () => {
  assert.deepEqual(RC.dayChips({}, '2026-11-03', byId), { shown: [], more: 0, total: 0 });
  assert.deepEqual(RC.dayChips({ x: [] }, 'x', byId), { shown: [], more: 0, total: 0 });
  assert.deepEqual(RC.dayChips(null, 'x', byId), { shown: [], more: 0, total: 0 });
  assert.deepEqual(RC.dayChips({ x: 'not a list' }, 'x', byId), { shown: [], more: 0, total: 0 });
});

test('a deleted recipe never makes an empty chip or inflates the count', () => {
  const plan = { x: ['gone', 'a', 'also-gone', 'b', 'c'] };
  assert.deepEqual(RC.dayChips(plan, 'x', byId), { shown: ['Lemon Pasta', 'Bean Stew'], more: 1, total: 3 });
  assert.deepEqual(RC.dayChips({ x: ['gone'] }, 'x', byId), { shown: [], more: 0, total: 0 });
});
