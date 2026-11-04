/* eslint-disable no-undef -- the callbacks below run in the browser, not in Node. */
import { test, expect, unlock, openAllRecipes } from './helpers.js';

// The "Tonight" design: sidebar, home screen, search, cards, footer, drawer.

test('the home screen asks what is cooking and shows suggestions, not the whole chest', async ({ page, api }) => {
  api.recipes.push(...[3, 4, 5, 6].map((n) => ({ id: 'x' + n, title: 'Extra ' + n, tags: [], mealType: 'dinner', ingredients: ['salt'], addedBy: 'Sam' })));
  await unlock(page);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('What’s cooking?');
  await expect(page.locator('#grid .card')).toHaveCount(3);
  await expect(page.locator('#stats')).toBeHidden();
  await expect(page.locator('.sidebar-nav a[aria-current="page"]')).toHaveText('Tonight');
});

test('search has a visible label and filters by name, ingredient and tag', async ({ page, api }) => {
  await unlock(page);
  await expect(page.getByLabel('Search for a recipe')).toBeVisible();
  await expect(page.locator('#search-input')).toHaveAttribute('placeholder', 'Search recipes, ingredients, tags...');

  await page.fill('#search-input', 'lemon');           // a name
  await expect(page.locator('#grid .card')).toHaveCount(1);
  await expect(page.locator('#grid')).toContainText('Lemon Pasta');

  await page.fill('#search-input', 'beans');           // an ingredient
  await expect(page.locator('#grid')).toContainText('Bean Stew');
  await expect(page.locator('#grid .card')).toHaveCount(1);

  await page.fill('#search-input', 'stew');            // a tag
  await expect(page.locator('#grid .card')).toHaveCount(1);

  await page.fill('#search-input', '');                // empty: suggestions are back
  await expect(page.locator('#grid .card')).toHaveCount(2);
});

test('a search with no matches does not leave stale cards', async ({ page, api }) => {
  await unlock(page);
  await page.fill('#search-input', 'zzzzqq');
  await expect(page.locator('#grid .card')).toHaveCount(0);
});

test('a card shows an image block, a caption, a bold title and a meta line, and no invented author', async ({ page, api }) => {
  api.recipes[0].addedBy = 'Anonymous';
  api.recipes[1].addedBy = 'Sam';
  await unlock(page);
  const lemon = page.locator('#grid .card', { hasText: 'Lemon Pasta' });
  await expect(lemon.locator('.card-media')).toBeVisible();
  expect((await lemon.locator('.card-media').boundingBox()).height).toBe(150);
  await expect(lemon.locator('.card-caption')).not.toBeEmpty();
  await expect(lemon.locator('.card-title-line')).toHaveText('Lemon Pasta');
  await expect(lemon.locator('.card-meta-line')).toContainText('Dinner');
  await expect(lemon.locator('.card-meta-line')).not.toContainText('Anonymous');
  await expect(page.locator('#grid .card', { hasText: 'Bean Stew' }).locator('.card-meta-line')).toContainText('by Sam');
});

test('a recipe with no picture gets a plain block, not a broken image or an emoji', async ({ page, api }) => {
  await unlock(page);
  const stew = page.locator('#grid .card', { hasText: 'Bean Stew' });
  await expect(stew.locator('.card-media')).toBeVisible();
  await expect(stew.locator('img')).toHaveCount(0);
  expect(await stew.locator('.card-media').evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
});

test('an image that fails to load is removed, leaving the plain block', async ({ page, api }) => {
  api.recipes[0].image = { url: 'https://images.unsplash.com/nope-does-not-exist.jpg', thumb: 'https://images.unsplash.com/nope-does-not-exist.jpg', photographer: 'T' };
  await unlock(page, { allowConsoleErrors: true });
  const lemon = page.locator('#grid .card', { hasText: 'Lemon Pasta' });
  await expect(lemon.locator('.card-media')).toBeVisible();
  await expect(lemon.locator('img')).toHaveCount(0);
});

test('the heart is a 44px target over the picture and still favourites', async ({ page, api }) => {
  await unlock(page);
  const heart = page.locator('#grid .card', { hasText: 'Lemon Pasta' }).locator('.fav-btn');
  const box = await heart.boundingBox();
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
  await heart.click();
  await expect(heart).toHaveAttribute('aria-pressed', 'true');
});

test('All recipes keeps the count, sort, filters and collections', async ({ page, api }) => {
  await unlock(page);
  await openAllRecipes(page);
  await expect(page.locator('#stats')).toContainText('2 recipes');
  await expect(page.locator('#stats .sort-select')).toBeVisible();
  await expect(page.locator('#stats .filter-chip', { hasText: 'all' })).toHaveClass(/on/);
  await expect(page.locator('#grid .card')).toHaveCount(2);

  await page.selectOption('#stats .sort-select', 'az');
  await expect(page.locator('#grid .card .card-title-line').first()).toHaveText('Bean Stew');
});

test('the active filter chip is the accent colour with dark text', async ({ page, api }) => {
  await unlock(page);
  await openAllRecipes(page);
  const on = page.locator('#stats .filter-chip.on').first();
  expect(await on.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(240, 138, 75)');
  expect(await on.evaluate((el) => getComputedStyle(el).color)).toBe('rgb(27, 22, 18)');
  const off = page.locator('#stats .filter-chip:not(.on)').first();
  expect(await off.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
  expect((await off.boundingBox()).height).toBeGreaterThanOrEqual(36);
});

test('Pantry opens a placeholder page rather than nothing', async ({ page, api }) => {
  await unlock(page);
  await page.locator('.sidebar-nav').getByRole('link', { name: 'Pantry' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Pantry');
  await expect(page.locator('#grid')).toBeHidden();
});

test('every sidebar action opens the dialog it opened before', async ({ page, api }) => {
  await unlock(page);
  const nav = page.locator('.sidebar-nav');
  const cases = [
    ['What can I make?', '#pantry-overlay'], ['List', '#shopping-overlay'], ['Plan', '#plan-overlay'],
    ['Import URL', '#import-overlay'], ['Paste text', '#paste-overlay'], ['Add Photos', '#upload-overlay'],
    ['Meal plan', '#plan-overlay'], ['Shopping list', '#shopping-overlay'],
  ];
  for (const [label, overlay] of cases) {
    await nav.getByText(label, { exact: true }).click();
    await expect(page.locator(overlay), label).toHaveClass(/on/);
    await page.keyboard.press('Escape');
    await expect(page.locator(overlay), label + ' closes').not.toHaveClass(/on/);
  }
});

test('the footer has a round lock button and the name as plain text', async ({ page, api }) => {
  await page.addInitScript(() => { try { localStorage.setItem('rc_user', 'Sam'); } catch { /* blocked */ } });
  await unlock(page);
  const lock = page.getByRole('button', { name: 'Lock', exact: true });
  const box = await lock.boundingBox();
  expect([box.width, box.height]).toEqual([44, 44]);
  expect(await lock.evaluate((el) => getComputedStyle(el).borderRadius)).toBe('50%');
  await expect(lock.locator('svg')).toHaveCount(1);
  expect((await lock.textContent()).trim()).toBe('');

  const name = page.locator('#user-tag');
  await expect(name).toHaveText('Sam');
  const style = await name.evaluate((el) => { const c = getComputedStyle(el); return { border: c.borderTopWidth, bg: c.backgroundColor, radius: c.borderRadius }; });
  expect(style).toEqual({ border: '0px', bg: 'rgba(0, 0, 0, 0)', radius: '0px' });
  const nameBox = await name.boundingBox();
  expect(nameBox.x - (box.x + box.width), 'clear space between lock and name').toBeGreaterThanOrEqual(12);
});

test('with no name entered the footer says Anonymous, and clicking it still changes it', async ({ page, api }) => {
  await unlock(page);
  await expect(page.locator('#user-tag')).toHaveText('Anonymous');
  page.once('dialog', (d) => d.accept('Maya'));
  await page.locator('#user-tag').click();
  await expect(page.locator('#user-tag')).toHaveText('Maya');
});

test('the lock button locks the app', async ({ page, api }) => {
  await unlock(page);
  await page.getByRole('button', { name: 'Lock', exact: true }).click();
  await expect(page.locator('#lock-screen')).toBeVisible();
});

test('the more-options menu is a round button at the top of the page and still works', async ({ page, api }) => {
  await unlock(page);
  const menu = page.getByRole('button', { name: 'More options' });
  const box = await menu.boundingBox();
  expect([box.width, box.height]).toEqual([44, 44]);
  await menu.click();
  await expect(page.locator('#app-menu')).toHaveClass(/on/);
  await expect(page.locator('#app-menu')).toContainText('Export backup');
  await expect(page.locator('#app-menu')).toContainText('Storage');
});

test('there is no Add recipe button and no emoji in the sidebar or the home screen', async ({ page, api }) => {
  await unlock(page);
  await expect(page.getByRole('button', { name: /^Add recipe/i })).toHaveCount(0);
  for (const sel of ['.sidebar', '#view-tonight', '#search-field', '#grid']) {
    expect(await page.locator(sel).innerText(), sel).not.toMatch(/\p{Extended_Pictographic}/u);
  }
});

test('keyboard focus is always visible, and Tab never lands in a closed modal', async ({ page, api }) => {
  await unlock(page);
  await page.locator('.sidebar-logo').first().focus();
  const stops = [];
  for (let i = 0; i < 24; i += 1) {
    await page.keyboard.press('Tab');
    stops.push(await page.evaluate(() => {
      const e = document.activeElement;
      const c = getComputedStyle(e);
      return {
        label: (e.getAttribute('aria-label') || e.textContent || e.id || e.tagName).trim().slice(0, 24),
        body: e === document.body,
        inOverlay: !!e.closest('.overlay'),
        visible: c.outlineStyle !== 'none' && parseFloat(c.outlineWidth) >= 2,
      };
    }));
  }
  for (const s of stops) {
    if (s.body) continue; // Tab left the page for the browser's own controls
    expect(s.inOverlay, `Tab reached "${s.label}" inside a closed modal`).toBe(false);
    expect(s.visible, `"${s.label}" has no visible focus ring`).toBe(true);
  }
  const labels = stops.map((s) => s.label);
  expect(labels).toContain('Import URL');
  expect(labels).toContain('Lock');
});

test('the sidebar links are real links or buttons, reachable by Tab', async ({ page, api }) => {
  await unlock(page);
  const tags = await page.locator('.sidebar-nav .side-link').evaluateAll((els) => els.map((e) => e.tagName));
  expect(tags.every((t) => t === 'A' || t === 'BUTTON')).toBe(true);
  expect(await page.locator('.sidebar-nav a[href]').count()).toBeGreaterThanOrEqual(3);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 780 } });

  test('the sidebar is a drawer behind a menu button, with the lock and name inside it', async ({ page, api }) => {
    await unlock(page);
    await expect(page.locator('.topbar')).toBeVisible();
    await expect(page.locator('.sidebar')).toBeHidden();
    await page.locator('#drawer-btn').click();
    await expect(page.locator('.sidebar')).toBeVisible();
    await expect(page.locator('#drawer-btn')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.sidebar-footer').getByRole('button', { name: 'Lock', exact: true })).toBeVisible();
    await expect(page.locator('.sidebar-footer #user-tag')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.sidebar')).toBeHidden();
  });

  test('choosing a link closes the drawer and shows that page', async ({ page, api }) => {
    await unlock(page);
    await page.locator('#drawer-btn').click();
    await page.locator('.sidebar-nav').getByRole('link', { name: 'All recipes' }).click();
    await expect(page.locator('.sidebar')).toBeHidden();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('All recipes');
  });

  test('one column, a 36px heading, and no sideways scroll', async ({ page, api }) => {
    await unlock(page);
    expect(await page.locator('#grid').evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length)).toBe(1);
    expect(await page.locator('.view-title').first().evaluate((el) => getComputedStyle(el).fontSize)).toBe('36px');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
});

test.describe('on a wide screen', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('a 220px sidebar, three columns, and the headings in the display face', async ({ page, api }) => {
    api.recipes.push(...[3, 4, 5].map((n) => ({ id: 'w' + n, title: 'Wide ' + n, tags: [], mealType: 'dinner', ingredients: [], addedBy: 'Sam' })));
    await unlock(page);
    expect((await page.locator('.sidebar').boundingBox()).width).toBe(220);
    expect(await page.locator('#grid').evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length)).toBe(3);
    const h1 = await page.locator('.view-title').first().evaluate((el) => { const c = getComputedStyle(el); return { size: c.fontSize, family: c.fontFamily }; });
    expect(h1.size).toBe('56px');
    expect(h1.family).toContain('DM Serif Display');
    expect(await page.evaluate(() => document.fonts.check('16px "DM Sans"') && document.fonts.check('16px "DM Serif Display"'))).toBe(true);
  });
});
