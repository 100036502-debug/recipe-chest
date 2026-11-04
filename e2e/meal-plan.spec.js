import { test, expect, unlock, openCalendar } from './helpers.js';

// A recipe can be put on the plan from its own page, and the picker opened from
// a day on the plan has a search box.

test('a recipe can be added to a day from its own page', async ({ page, api }) => {
  await unlock(page);
  await page.locator('#grid .card').filter({ hasText: 'Lemon Pasta' }).click();
  await expect(page.locator('#detail-overlay')).toHaveClass(/on/);

  await page.getByRole('button', { name: 'Add to calendar' }).click();
  await expect(page.locator('#picker-overlay')).toHaveClass(/on/);
  await expect(page.locator('#picker-title')).toContainText('Lemon Pasta');
  await expect(page.locator('#picker-search')).toBeHidden();
  await expect(page.locator('#picker-list .mp-pick')).toHaveCount(14);
  await expect(page.locator('#picker-list .mp-pick').first()).toContainText('Today');
  await expect(page.locator('#picker-list .mp-pick').nth(1)).toContainText('Tomorrow');

  await page.locator('#picker-list .mp-pick').nth(1).click();
  await expect(page.locator('#picker-overlay')).not.toHaveClass(/on/);
  await expect(page.locator('.toast, #toast').first()).toContainText('Added to calendar');

  // It is on the plan now, and the chooser says so next time.
  const saved = Object.values(api.lists).find((l) => l.days);
  const dates = Object.keys(saved.days);
  assert(dates.length === 1 && saved.days[dates[0]].join() === 'r1', 'one day holds r1');

  await page.getByRole('button', { name: 'Add to calendar' }).click();
  await expect(page.locator('#picker-list .mp-pick.planned')).toHaveCount(1);
  await expect(page.locator('#picker-list .mp-pick.planned')).toContainText('Already planned');
});

function assert(ok, message) { if (!ok) throw new Error(message); }

test('the recipe picker on a calendar day searches as you type', async ({ page, api }) => {
  assert(Array.isArray(api.recipes), 'the mock API is installed');
  await unlock(page);
  await openCalendar(page);

  await page.locator('.cal-add').click();
  await expect(page.locator('#picker-overlay')).toHaveClass(/on/);
  await expect(page.locator('#picker-search')).toBeVisible();
  await expect(page.locator('#picker-list .mp-pick')).toHaveCount(2);

  await page.fill('#picker-search', 'stew');
  await expect(page.locator('#picker-list .mp-pick')).toHaveCount(1);
  await expect(page.locator('#picker-list')).toContainText('Bean Stew');

  // by ingredient, not only title
  await page.fill('#picker-search', 'parmesan');
  await expect(page.locator('#picker-list')).toContainText('Lemon Pasta');
  await expect(page.locator('#picker-list .mp-pick')).toHaveCount(1);

  await page.fill('#picker-search', 'zzzz <b>x</b>');
  await expect(page.locator('#picker-list .mp-empty')).toContainText('No recipes match');
  await expect(page.locator('#picker-list b')).toHaveCount(0);

  await page.fill('#picker-search', 'bean');
  await page.locator('#picker-list .mp-pick').first().click();
  await expect(page.locator('#picker-overlay')).not.toHaveClass(/on/);
  await expect(page.locator('.cal-meals')).toContainText('Bean Stew');
  await expect(page.locator('.cal-day.sel .cal-chip')).toContainText('Bean Stew');
});

test('the search box starts empty each time the picker opens', async ({ page, api }) => {
  assert(Array.isArray(api.recipes), 'the mock API is installed');
  await unlock(page);
  await openCalendar(page);
  const add = page.locator('.cal-add');
  await add.click();
  await page.fill('#picker-search', 'stew');
  await page.locator('#picker-overlay .modal-close').click();
  await add.click();
  await expect(page.locator('#picker-search')).toHaveValue('');
  await expect(page.locator('#picker-list .mp-pick')).toHaveCount(2);
});
