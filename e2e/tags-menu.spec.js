/* eslint-disable no-undef -- the callbacks below run in the browser, not in Node. */
import { test, expect, unlock } from './helpers.js';

// Chips and the recipe action menu: the strip must scroll itself rather than
// widen the page, a chip must clear on a second click, and the three-dot menu
// must be reachable without scrolling sideways.

const MANY_TAGS = [
  'pasta', 'quick', 'stew', 'vegetarian', 'vegan', 'gluten-free',
  'dessert', 'breakfast', 'lunch', 'dinner', 'snack', 'spicy',
];

test('on a desktop the tag strip scrolls inside itself and never widens the page', async ({ page, api }) => {
  api.recipes.forEach((r) => { r.tags = MANY_TAGS.slice(); });
  await page.setViewportSize({ width: 1280, height: 900 });
  await unlock(page);

  const box = await page.locator('.stats-chips').evaluate((el) => ({ client: el.clientWidth, scroll: el.scrollWidth }));
  expect(box.scroll).toBeGreaterThan(box.client); // the chips overflow the strip...
  const page_ = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(page_.scroll).toBe(page_.client); // ...and the page does not.
});

test('clicking the active tag clears it, and the only tag falls back to all', async ({ page, api }) => {
  await unlock(page);
  const chip = page.locator('.stats-chips .filter-chip[data-tag="pasta"]');
  await chip.click();
  await expect(chip).toHaveClass(/on/);
  const filtered = await page.locator('#grid .card').count();

  await chip.click();
  await expect(chip).not.toHaveClass(/on/);
  await expect(page.locator('.stats-chips .filter-chip[data-action="setFilter"][data-arg="all"]')).toHaveClass(/on/);
  expect(await page.locator('#grid .card').count()).toBeGreaterThan(filtered);
});

test('the three-dot menu opens fully on screen, with no sideways scroll', async ({ page, api }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await unlock(page);
  await page.locator('#grid .card').first().locator('.card-title-line').click();
  await page.locator('#more-actions-btn').click();

  const seen = await page.evaluate(() => {
    const menu = document.getElementById('more-actions-menu');
    const box = menu.getBoundingClientRect();
    return {
      hidden: menu.hidden,
      left: Math.round(box.left),
      right: Math.round(box.right),
      viewport: window.innerWidth,
      pageScroll: document.documentElement.scrollWidth,
      pageClient: document.documentElement.clientWidth,
    };
  });
  expect(seen.hidden).toBe(false);
  expect(seen.left).toBeGreaterThanOrEqual(0);
  expect(seen.right).toBeLessThanOrEqual(seen.viewport);
  expect(seen.pageScroll).toBe(seen.pageClient);
  await expect(page.getByRole('menuitem', { name: 'Share link' })).toBeVisible();
});
