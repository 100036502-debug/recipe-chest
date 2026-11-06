/* eslint-disable no-undef -- the callbacks below run in the browser, not in Node. */
import { test, expect, unlock, openCalendar, ACCESS_CODE } from './helpers.js';

// Calendar, Tonight, the shared meta line and the recipe window (UI round 2).

const pad = (n) => String(n).padStart(2, '0');
const key = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => key(new Date());
const inDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return key(d); };

// Serve a plan that was "saved before this change", so a test can check that
// existing meals show on the right dates. Registered after the mock API, so it
// takes the request first.
async function withPlan(page, days) {
  await page.route('**/api/meal-plan**', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ days, updatedAt: 1 }) });
  });
}

const cell = (page, date) => page.locator(`.cal-day[data-date="${date}"]`);

// ---------------------------------------------------------------- Calendar

test('the calendar is a 7-column month with weekday headings and a serif month name', async ({ page, api }) => {
  await unlock(page);
  await openCalendar(page);
  await expect(page.locator('.cal-weekdays span')).toHaveText(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
  expect(await page.locator('.cal-row').first().evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length)).toBe(7);
  const title = page.locator('#calendar-title');
  await expect(title).toContainText(String(new Date().getFullYear()));
  expect(await title.evaluate((el) => getComputedStyle(el).fontFamily)).toContain('DM Serif Display');
  expect(await title.evaluate((el) => getComputedStyle(el).fontSize)).toBe('32px');
});

test('day cells are at least 96px tall on a wide screen, on the surface colour, with a muted number', async ({ page, api }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await unlock(page);
  await openCalendar(page);
  const c = page.locator('.cal-day').nth(10);
  expect((await c.boundingBox()).height).toBeGreaterThanOrEqual(96);
  expect(await c.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(38, 32, 26)');
  expect(await c.locator('.cal-num').evaluate((el) => getComputedStyle(el).color)).toBe('rgb(185, 173, 155)');
  expect(await c.locator('.cal-num').evaluate((el) => getComputedStyle(el).fontSize)).toBe('14px');
});

test('days outside the month are dimmed, and today has the accent outline', async ({ page, api }) => {
  await unlock(page);
  await openCalendar(page);
  const out = page.locator('.cal-day.out');
  if (await out.count()) expect(Number(await out.first().evaluate((el) => getComputedStyle(el).opacity))).toBeLessThan(1);
  const t = cell(page, today());
  await expect(t).toHaveAttribute('aria-current', 'date');
  await page.locator('.cal-day:not(.sel)').first().hover(); // so the selected style is not what is measured
  const o = await t.evaluate((el) => { const c = getComputedStyle(el); return [c.outlineWidth, c.outlineStyle, c.outlineColor]; });
  expect(o).toEqual(['2px', 'solid', 'rgb(240, 138, 75)']);
});

test('meals planned before this change show on the right dates', async ({ page, api }) => {
  await withPlan(page, { [today()]: ['r1'], [inDays(1)]: ['r2'] });
  await unlock(page);
  await openCalendar(page);
  await expect(cell(page, today()).locator('.cal-chip')).toHaveText(['Lemon Pasta']);
  await expect(cell(page, inDays(1)).first().locator('.cal-chip')).toHaveText(['Bean Stew']);
  await expect(cell(page, inDays(2)).first().locator('.cal-chip')).toHaveCount(0);
});

test('a day with three meals shows two chips and "+1 more"', async ({ page, api }) => {
  api.recipes.push({ id: 'r3', title: 'Pad Thai', tags: [], mealType: 'dinner', ingredients: ['noodles'], addedBy: '' });
  await withPlan(page, { [today()]: ['r1', 'r2', 'r3'] });
  await unlock(page);
  await openCalendar(page);
  await expect(cell(page, today()).locator('.cal-chip')).toHaveCount(2);
  await expect(cell(page, today()).locator('.cal-more')).toHaveText('+1 more');
});

test('a chip is one line, truncated with an ellipsis', async ({ page, api }) => {
  api.recipes[0].title = 'An extremely long recipe name that could never fit in one small calendar cell';
  await withPlan(page, { [today()]: ['r1'] });
  await unlock(page);
  await openCalendar(page);
  const chip = cell(page, today()).locator('.cal-chip');
  const s = await chip.evaluate((el) => { const c = getComputedStyle(el); return [c.whiteSpace, c.textOverflow, c.overflow, c.fontSize, c.borderRadius, c.backgroundColor]; });
  expect(s).toEqual(['nowrap', 'ellipsis', 'hidden', '13px', '6px', 'rgba(240, 138, 75, 0.15)']);
});

test('selecting a day opens its panel with the full date and highlights the cell', async ({ page, api }) => {
  await unlock(page);
  await openCalendar(page);
  const target = cell(page, inDays(0));
  await target.click();
  await expect(target).toHaveClass(/sel/);
  await expect(target).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#cal-panel-title')).toContainText(String(new Date().getFullYear()));
  expect(await page.locator('#cal-panel-title').evaluate((el) => getComputedStyle(el).fontFamily)).toContain('DM Serif Display');
  await page.locator('.cal-day:not(.sel)').first().hover();
  expect(await target.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(46, 38, 31)'); // #2E261F
});

test('the panel is about 360px wide beside the grid on a wide screen', async ({ page, api }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await unlock(page);
  await openCalendar(page);
  const w = (await page.locator('#cal-panel').boundingBox()).width;
  expect(w).toBeGreaterThan(340);
  expect(w).toBeLessThan(380);
});

test('adding a meal puts it on the day, in the plan data, and the chip appears', async ({ page, api }) => {
  await unlock(page);
  await openCalendar(page);
  await cell(page, today()).click();
  await page.locator('.cal-add').click();
  await expect(page.locator('#picker-search')).toBeVisible();
  await page.locator('#picker-list .mp-pick', { hasText: 'Lemon Pasta' }).click();
  await expect(page.locator('.cal-meals')).toContainText('Lemon Pasta');
  await expect(cell(page, today()).locator('.cal-chip')).toHaveText(['Lemon Pasta']);
  const saved = Object.values(api.lists).find((l) => l.days);
  expect(saved.days[today()]).toEqual(['r1']);
});

test('there are no meal slots: nothing asks for breakfast, lunch or dinner', async ({ page, api }) => {
  await unlock(page);
  await openCalendar(page);
  await page.locator('.cal-add').click();
  await expect(page.locator('#picker-overlay')).not.toContainText(/breakfast|lunch/i);
});

test('removing a meal takes it off the plan only; the recipe is kept', async ({ page, api }) => {
  await withPlan(page, { [today()]: ['r1'] });
  await unlock(page);
  await openCalendar(page);
  await cell(page, today()).click();
  await expect(page.locator('.cal-meals')).toContainText('Lemon Pasta');
  await page.getByRole('button', { name: /^Remove Lemon Pasta from the plan/ }).click();
  await expect(page.locator('.cal-meals')).toHaveCount(0);
  await expect(page.locator('.cal-none')).toBeVisible();
  const saved = Object.values(api.lists).find((l) => l.days);
  expect(saved.days[today()] || []).toEqual([]);
  expect(api.recipes.map((r) => r.id)).toContain('r1');
});

test('clicking a meal title in the panel opens that recipe', async ({ page, api }) => {
  await withPlan(page, { [today()]: ['r1'] });
  await unlock(page);
  await openCalendar(page);
  await cell(page, today()).click();
  await page.locator('.cal-meal-title', { hasText: 'Lemon Pasta' }).click();
  await expect(page.locator('#detail-overlay')).toHaveClass(/on/);
  await expect(page.locator('#detail-title')).toHaveText('Lemon Pasta');
});

test('a deleted recipe left on a day does not break the panel and can be removed', async ({ page, api }) => {
  await withPlan(page, { [today()]: ['gone-id', 'r1'] });
  await unlock(page);
  await openCalendar(page);
  await expect(cell(page, today()).locator('.cal-chip')).toHaveText(['Lemon Pasta']);
  await cell(page, today()).click();
  await expect(page.locator('.cal-meal.gone')).toContainText('A deleted recipe');
  await page.locator('.cal-meal.gone .cal-remove').click();
  await expect(page.locator('.cal-meal.gone')).toHaveCount(0);
  await expect(page.locator('.cal-meals')).toContainText('Lemon Pasta');
});

test('previous, next and Today move between months and back', async ({ page, api }) => {
  await unlock(page);
  await openCalendar(page);
  const here = await page.locator('#calendar-title').innerText();
  await page.getByRole('button', { name: 'Next month' }).click();
  const next = await page.locator('#calendar-title').innerText();
  expect(next).not.toBe(here);
  await page.getByRole('button', { name: 'Previous month' }).click();
  await page.getByRole('button', { name: 'Previous month' }).click();
  expect(await page.locator('#calendar-title').innerText()).not.toBe(here);
  await page.getByRole('button', { name: 'Today' }).click();
  await expect(page.locator('#calendar-title')).toHaveText(here);
  await expect(cell(page, today())).toHaveClass(/sel/);
});

test('the month and Today buttons are 44px, and the arrows have accessible names', async ({ page, api }) => {
  await unlock(page);
  await openCalendar(page);
  for (const name of ['Previous month', 'Next month', 'Today']) {
    const b = await page.getByRole('button', { name }).boundingBox();
    expect(b.height, name).toBeGreaterThanOrEqual(44);
  }
  const round = page.getByRole('button', { name: 'Next month' });
  expect(await round.evaluate((el) => getComputedStyle(el).borderRadius)).toBe('50%');
});

test('arrow keys move between days, across month ends', async ({ page, api }) => {
  await unlock(page);
  await openCalendar(page);
  await cell(page, today()).focus();
  await page.keyboard.press('ArrowRight');
  await expect(cell(page, inDays(1))).toBeFocused();
  await expect(cell(page, inDays(1))).toHaveClass(/sel/);
  await page.keyboard.press('ArrowDown');
  await expect(cell(page, inDays(8))).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowUp');
  await expect(cell(page, inDays(0))).toBeFocused();
});

test('every day cell is a real button with a descriptive label, and only one is in the Tab order', async ({ page, api }) => {
  await withPlan(page, { [today()]: ['r1'] });
  await unlock(page);
  await openCalendar(page);
  expect(await page.locator('.cal-day').evaluateAll((els) => els.every((e) => e.tagName === 'BUTTON'))).toBe(true);
  await expect(cell(page, today())).toHaveAttribute('aria-label', /1 meal planned/);
  await expect(cell(page, inDays(3))).toHaveAttribute('aria-label', /nothing planned/);
  expect(await page.locator('.cal-day[tabindex="0"]').count()).toBe(1);
});

for (const [hash, view] of [['#plan', 'view-calendar'], ['#meal-plan', 'view-calendar'], ['#list', 'view-shopping'], ['#calendar', 'view-calendar'], ['#shopping', 'view-shopping'], ['#nonsense', 'view-recipes']]) {
  test(`the address ${hash} lands on ${view}`, async ({ page, api }) => {
    await page.goto('/' + hash);
    await page.fill('#lock-input', ACCESS_CODE);
    await page.getByRole('button', { name: 'Enter', exact: true }).click();
    await expect(page.locator('#app-content')).toBeVisible();
    await expect(page.locator('.view:not([hidden])')).toHaveAttribute('id', view);
  });
}

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 780 } });

  test('the month is a compact grid with dots, and the day list sits underneath', async ({ page, api }) => {
    await withPlan(page, { [today()]: ['r1'] });
    await unlock(page);
    await page.locator('#drawer-btn').click();
    await page.locator('.sidebar-nav').getByRole('link', { name: 'Calendar' }).click();
    await expect(cell(page, today()).locator('.cal-dot')).toBeVisible();
    await expect(cell(page, today()).locator('.cal-chip')).toBeHidden();
    await expect(cell(page, inDays(3)).locator('.cal-dot')).toBeHidden();
    expect((await cell(page, today()).boundingBox()).height).toBeGreaterThanOrEqual(44);
    const grid = await page.locator('#cal-grid').boundingBox();
    const panel = await page.locator('#cal-panel').boundingBox();
    expect(panel.y).toBeGreaterThan(grid.y + grid.height - 2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
});

// ------------------------------------------------------------------ Tonight

test('Tonight shows only today\'s planned meals, as cards, with no search or suggestions', async ({ page, api }) => {
  await withPlan(page, { [today()]: ['r1'], [inDays(1)]: ['r2'] });
  await unlock(page);
  await page.locator('.sidebar-nav').getByRole('link', { name: 'Tonight' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Tonight');
  await expect(page.locator('#grid .card')).toHaveCount(1);
  await expect(page.locator('#grid')).toContainText('Lemon Pasta');
  await expect(page.locator('#grid')).not.toContainText('Bean Stew');
  await expect(page.locator('#search-field')).toBeHidden();
  await expect(page.locator('#tonight-date')).toContainText(String(new Date().getFullYear()));
  expect(await page.locator('#tonight-title').evaluate((el) => getComputedStyle(el).fontSize)).toBe('56px');
});

test('clicking a Tonight card opens the recipe', async ({ page, api }) => {
  await withPlan(page, { [today()]: ['r1'] });
  await unlock(page);
  await page.locator('.sidebar-nav').getByRole('link', { name: 'Tonight' }).click();
  await page.locator('#grid .card').first().click();
  await expect(page.locator('#detail-title')).toHaveText('Lemon Pasta');
});

test('with nothing planned, Tonight says so and links to the Calendar with today selected', async ({ page, api }) => {
  await withPlan(page, { [inDays(1)]: ['r2'] });
  await unlock(page);
  await page.locator('.sidebar-nav').getByRole('link', { name: 'Tonight' }).click();
  const box = page.locator('.tonight-empty');
  await expect(box).toHaveText('You haven’t planned any meals for tonight. Go to Calendar to add one.');
  const css = await box.evaluate((el) => { const c = getComputedStyle(el); return [c.backgroundColor, c.borderRadius, c.paddingTop, c.maxWidth]; });
  expect(css).toEqual(['rgb(38, 32, 26)', '16px', '28px', '560px']);
  const link = box.getByRole('link', { name: 'Calendar' });
  expect(await link.evaluate((el) => getComputedStyle(el).color)).toBe('rgb(240, 138, 75)');
  await link.click();
  await expect(page.locator('#view-calendar')).toBeVisible();
  await expect(cell(page, today())).toHaveClass(/sel/);
});

test('Tonight moves on to the new day after midnight without a reload', async ({ page, api }) => {
  await withPlan(page, { [today()]: ['r1'], [inDays(1)]: ['r2'] });
  // Start the page's clock at 11:50pm today, so midnight is ten minutes away.
  const start = new Date(); start.setHours(23, 50, 0, 0);
  await page.clock.install({ time: start });
  await unlock(page);
  await page.locator('.sidebar-nav').getByRole('link', { name: 'Tonight' }).click();
  await expect(page.locator('#grid')).toContainText('Lemon Pasta');
  await expect(page.locator('#grid')).not.toContainText('Bean Stew');
  await page.clock.fastForward('15:00'); // fifteen minutes: the clock passes midnight
  await expect(page.locator('#grid')).toContainText('Bean Stew');
  await expect(page.locator('#grid')).not.toContainText('Lemon Pasta');
  await expect(page.locator('#tonight-date')).toContainText(String(new Date(start.getTime() + 20 * 60 * 1000).getDate()));
});

// ----------------------------------------------------------------- Meta line

test('a card never repeats the category as a tag', async ({ page, api }) => {
  api.recipes[0].tags = ['dinner', 'pasta'];
  api.recipes[0].mealType = 'dinner';
  api.recipes[1].tags = ['  DINNER '];
  api.recipes[1].addedBy = '';
  await unlock(page);
  const lemon = await page.locator('#grid .card', { hasText: 'Lemon Pasta' }).locator('.card-meta-line').innerText();
  expect(lemon).toMatch(/^Dinner · pasta/);
  expect(lemon).not.toMatch(/dinner · dinner/i);
  await expect(page.locator('#grid .card', { hasText: 'Bean Stew' }).locator('.card-meta-line')).toHaveText('Dinner');
});

test('a card with nothing to put in the meta line leaves it out', async ({ page, api }) => {
  api.recipes[1].mealType = '';
  api.recipes[1].tags = [];
  api.recipes[1].addedBy = '';
  await unlock(page);
  const stew = page.locator('#grid .card', { hasText: 'Bean Stew' });
  const text = await stew.locator('.card-meta-line').count() ? await stew.locator('.card-meta-line').innerText() : '';
  expect(text).not.toMatch(/·\s*$|^\s*·/);
});

// -------------------------------------------------------------------- Images

test('photos sit in a wrapper with the dimming filter and the tint layer', async ({ page, api }) => {
  api.recipes[0].image = { url: 'https://images.unsplash.com/x.jpg', thumb: 'https://images.unsplash.com/x.jpg', photographer: 'T' };
  await page.route('https://images.unsplash.com/**', (route) => route.fulfill({ status: 200, contentType: 'image/gif', body: Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64') }));
  await unlock(page);
  const wrap = page.locator('#grid .card', { hasText: 'Lemon Pasta' }).locator('.img-wrap');
  await expect(wrap).toHaveCount(1);
  // noir is the default blend: black and white, dimmed, dissolving into the card.
  expect(await wrap.locator('img').evaluate((el) => getComputedStyle(el).filter)).toContain('grayscale(1)');
  expect(await wrap.evaluate((el) => getComputedStyle(el, '::after').backgroundImage)).toContain('linear-gradient');
  expect(await wrap.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
});

test('the heart stays above the tint and is still pressable', async ({ page, api }) => {
  await unlock(page);
  const heart = page.locator('#grid .card', { hasText: 'Lemon Pasta' }).locator('.fav-btn');
  const z = await heart.evaluate((el) => Number(getComputedStyle(el).zIndex));
  expect(z).toBeGreaterThan(1);
  const b = await heart.boundingBox();
  expect([Math.round(b.width), Math.round(b.height)]).toEqual([44, 44]);
  const top = await page.evaluate(([x, y]) => document.elementFromPoint(x, y).className, [b.x + b.width / 2, b.y + b.height / 2]);
  expect(String(top)).toContain('fav-btn');
  await heart.click();
  await expect(heart).toHaveClass(/on/);
});

test('a recipe with no image gets the plain muted block', async ({ page, api }) => {
  await unlock(page);
  const wrap = page.locator('#grid .card', { hasText: 'Bean Stew' }).locator('.img-wrap');
  expect(await wrap.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(58, 49, 40)'); // #3A3128
});

// ------------------------------------------------------------ Recipe window

async function openRecipe(page, title = 'Lemon Pasta') {
  await page.locator('#grid .card', { hasText: title }).first().click();
  await expect(page.locator('#detail-overlay')).toHaveClass(/on/);
}

test('the recipe window has one filled button, four outlined ones and a "..." menu', async ({ page, api }) => {
  await unlock(page);
  await openRecipe(page);
  const names = await page.locator('.recipe-actions > .act').allInnerTexts();
  expect(names.map((t) => t.trim())).toEqual(['Cook mode', 'Add to calendar', 'Add to shopping list', 'Favorite', 'Edit']);
  const bg = (loc) => loc.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(await bg(page.getByRole('button', { name: 'Cook mode' }))).toBe('rgb(240, 138, 75)');
  for (const n of ['Add to calendar', 'Add to shopping list', 'Edit']) {
    const b = page.locator('.recipe-actions').getByRole('button', { name: n, exact: true });
    expect(await bg(b), n).toBe('rgba(0, 0, 0, 0)');
    expect(await b.evaluate((el) => getComputedStyle(el).borderTopColor), n).toBe('rgb(74, 63, 52)');
    expect((await b.boundingBox()).height, n).toBeGreaterThanOrEqual(44);
  }
  const more = page.getByRole('button', { name: 'More actions' });
  await expect(more).toHaveAttribute('aria-haspopup', 'menu');
  expect(await more.evaluate((el) => getComputedStyle(el).borderRadius)).toBe('50%');
});

test('every action that existed is still reachable, and the old names are gone', async ({ page, api }) => {
  await unlock(page);
  await openRecipe(page);
  const text = await page.locator('#detail-modal').innerText();
  expect(text).not.toMatch(/Add to meal plan|Add to list\b/);
  await page.getByRole('button', { name: 'More actions' }).click();
  const items = await page.locator('#more-actions-menu [role=menuitem]').allInnerTexts();
  expect(items.map((t) => t.trim())).toEqual(['Share link', 'AI tools', 'Add my photo', 'Print', 'Print card']);
  await expect(page.getByRole('button', { name: 'I cooked this' })).toBeVisible();
});

test('"Add to shopping list" adds to the one shopping list', async ({ page, api }) => {
  await unlock(page);
  await openRecipe(page);
  await page.getByRole('button', { name: 'Add to shopping list' }).click();
  await expect(page.locator('#toast')).toContainText('added');
  await page.keyboard.press('Escape');
  await page.locator('.sidebar-nav').getByRole('link', { name: 'Shopping list', exact: true }).click();
  await expect(page.locator('#sl-list')).toContainText('spaghetti');
});

test('the "..." menu opens on click, moves with the arrow keys, and Esc closes only it', async ({ page, api }) => {
  await unlock(page);
  await openRecipe(page);
  const more = page.getByRole('button', { name: 'More actions' });
  await more.click();
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  const items = page.locator('#more-actions-menu [role=menuitem]');
  await expect(items.first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press('End');
  await expect(items.last()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(items.first()).toBeFocused();
  for (const el of await items.all()) expect((await el.boundingBox()).height).toBeGreaterThanOrEqual(44);
  await page.keyboard.press('Escape');
  await expect(page.locator('#more-actions-menu')).toBeHidden();
  await expect(more).toBeFocused();
  await expect(page.locator('#detail-overlay')).toHaveClass(/on/);
});

test('the recipe window closes with Esc, a backdrop click or the close button, and gives focus back', async ({ page, api }) => {
  await unlock(page);
  const card = page.locator('#grid .card', { hasText: 'Lemon Pasta' }).locator('.card-title-btn');
  await card.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#detail-overlay')).toHaveClass(/on/);
  const close = page.getByRole('button', { name: 'Close', exact: true });
  const b = await close.boundingBox();
  expect([Math.round(b.width), Math.round(b.height)]).toEqual([44, 44]);
  await page.keyboard.press('Escape');
  await expect(page.locator('#detail-overlay')).not.toHaveClass(/on/);
  await expect(card).toBeFocused();
  await openRecipe(page);
  await close.click();
  await expect(page.locator('#detail-overlay')).not.toHaveClass(/on/);
  await openRecipe(page);
  await page.mouse.click(5, 5);
  await expect(page.locator('#detail-overlay')).not.toHaveClass(/on/);
});

test('the window is a labelled dialog, with no emoji, and the page behind does not scroll', async ({ page, api }) => {
  await unlock(page);
  await openRecipe(page);
  const dlg = page.locator('#detail-modal');
  await expect(dlg).toHaveAttribute('role', 'dialog');
  await expect(dlg).toHaveAttribute('aria-modal', 'true');
  await expect(dlg).toHaveAttribute('aria-labelledby', 'detail-title');
  expect(await dlg.innerText()).not.toMatch(/\p{Extended_Pictographic}/u);
  expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).toBe('hidden');
  const css = await dlg.evaluate((el) => { const c = getComputedStyle(el); return [c.maxWidth, c.backgroundColor, c.borderRadius]; });
  expect(css).toEqual(['860px', 'rgb(38, 32, 26)', '20px']);
});

test('the title and description use the specified type', async ({ page, api }) => {
  await unlock(page);
  await openRecipe(page);
  const t = await page.locator('#detail-title').evaluate((el) => { const c = getComputedStyle(el); return [c.fontFamily.split(',')[0], c.fontSize, c.fontWeight, c.color]; });
  expect(t).toEqual(['"DM Serif Display"', '40px', '400', 'rgb(243, 235, 221)']);
  const d = page.locator('.recipe-desc');
  if (await d.count()) {
    const dd = await d.evaluate((el) => { const c = getComputedStyle(el); return [c.fontSize, c.color]; });
    expect(dd).toEqual(['17px', 'rgb(185, 173, 155)']);
    // 65 characters of its own font: whatever the glyph width, the line is capped there.
    const chars = await d.evaluate((el) => { const c = getComputedStyle(el); const probe = document.createElement('span'); probe.style.cssText = 'font:' + c.font + ';position:absolute;visibility:hidden'; probe.textContent = '0'; document.body.appendChild(probe); const w = probe.getBoundingClientRect().width; probe.remove(); return parseFloat(c.maxWidth) / w; });
    expect(Math.round(chars)).toBe(65);
  }
});

test('info chips share one style, and tags are muted not orange', async ({ page, api }) => {
  await unlock(page);
  await openRecipe(page);
  const chips = page.locator('.recipe-meta .meta-pill');
  expect(await chips.count()).toBeGreaterThan(1);
  for (const c of await chips.all()) {
    const s = await c.evaluate((el) => { const x = getComputedStyle(el); return [x.borderTopColor, x.borderRadius, x.backgroundColor]; });
    expect(s[0]).toBe('rgb(74, 63, 52)');
    expect(parseFloat(s[1])).toBeGreaterThan(20);
    expect(s[2]).toBe('rgba(0, 0, 0, 0)');
    expect((await c.boundingBox()).height).toBeGreaterThanOrEqual(36);
  }
  const tag = page.locator('.recipe-tags .tag').first();
  expect(await tag.evaluate((el) => getComputedStyle(el).color)).toBe('rgb(185, 173, 155)');
  await expect(page.getByRole('button', { name: /^Remove tag/ }).first()).toBeVisible();
  const add = page.locator('.tag-add-btn').first();
  expect(await add.evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe('dashed');
});

test('the servings control is a real select and still scales the ingredients', async ({ page, api }) => {
  api.recipes[0].servings = '4';
  api.recipes[0].ingredients = ['200 g spaghetti', '2 cups milk'];
  await unlock(page);
  await openRecipe(page);
  const sel = page.locator('select.servings-select');
  await expect(sel).toHaveCount(1);
  const before = await page.locator('.ing-list').innerText();
  await sel.selectOption({ index: 3 });
  expect(await page.locator('.ing-list').innerText()).not.toBe(before);
});

test('the source link is a real link that opens safely in a new tab', async ({ page, api }) => {
  api.recipes[0].sourceUrl = 'https://www.example.com/a/very/long/path';
  await unlock(page);
  await openRecipe(page);
  const a = page.locator('a.meta-link');
  await expect(a).toHaveAttribute('target', '_blank');
  await expect(a).toHaveAttribute('rel', /noopener/);
  await expect(a).toHaveAttribute('rel', /noreferrer/);
  expect(await a.evaluate((el) => getComputedStyle(el).color)).toBe('rgb(240, 138, 75)');
  expect(await a.locator('svg').count()).toBe(1);
});

test('an unsafe source address is shown as text, never as a link', async ({ page, api }) => {
  api.recipes[0].sourceUrl = 'javascript:alert(1)';
  await unlock(page);
  await openRecipe(page);
  await expect(page.locator('a.meta-link')).toHaveCount(0);
  await expect(page.locator('a[href^="javascript"]')).toHaveCount(0);
});

test('the cooking log has an outlined button and the status beside it', async ({ page, api }) => {
  await unlock(page);
  await openRecipe(page);
  const btn = page.getByRole('button', { name: 'I cooked this' });
  const s = await btn.evaluate((el) => { const c = getComputedStyle(el); return [c.backgroundColor, c.borderTopColor, c.color, c.borderRadius]; });
  expect(s).toEqual(['rgba(0, 0, 0, 0)', 'rgb(240, 138, 75)', 'rgb(240, 138, 75)', '10px']);
  await expect(page.locator('.cooked-summary')).toContainText('Not cooked yet');
  const bb = await btn.boundingBox();
  const sb = await page.locator('.cooked-summary').boundingBox();
  expect(Math.abs((bb.y + bb.height / 2) - (sb.y + sb.height / 2))).toBeLessThan(20);
  expect(sb.x).toBeGreaterThan(bb.x + bb.width);
});

test('instruction steps are numbered in 28px circles', async ({ page, api }) => {
  api.recipes[0].instructions = ['Boil the pasta.', 'Add the lemon.'];
  await unlock(page);
  await openRecipe(page);
  const s = await page.locator('.step-list li').first().evaluate((el) => { const c = getComputedStyle(el, '::before'); return [c.width, c.height, c.borderRadius, c.color]; });
  expect(s).toEqual(['28px', '28px', '50%', 'rgb(240, 138, 75)']);
});

test('on a phone the primary button spans the width and the others sit in two columns', async ({ page, api }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await unlock(page);
  await openRecipe(page);
  const modal = await page.locator('#detail-modal').boundingBox();
  const primary = await page.getByRole('button', { name: 'Cook mode' }).boundingBox();
  expect(primary.width).toBeGreaterThan(modal.width * 0.8);
  const a = await page.getByRole('button', { name: 'Add to calendar' }).boundingBox();
  const b = await page.getByRole('button', { name: 'Add to shopping list' }).boundingBox();
  expect(Math.abs(a.y - b.y)).toBeLessThan(4);
  expect((await page.locator('.recipe-hero').boundingBox()).height).toBeLessThanOrEqual(200);
  expect(await page.locator('#detail-title').evaluate((el) => getComputedStyle(el).fontSize)).toBe('30px');
});
