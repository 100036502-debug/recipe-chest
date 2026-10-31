import { test, expect, unlock } from './helpers.js';

const CACHE_KEY = 'rc_recipes_cache';

function cacheValue(page) {
  return page.evaluate((key) => localStorage.getItem(key), CACHE_KEY);
}

test('locking throws away the offline copy of the recipes', async ({ page, api }) => {
  await unlock(page);
  await expect(page.locator('#grid .card').first()).toBeVisible();

  // The cache is what offline mode reads, so it exists while unlocked.
  await expect.poll(() => cacheValue(page)).not.toBeNull();

  await page.locator('button[onclick="lockApp()"]').click();
  await expect(page.locator('#lock-screen')).toBeVisible();

  expect(await cacheValue(page)).toBeNull();
});

test('a session that expires drops the copy too', async ({ page, api }) => {
  await unlock(page);
  await expect(page.locator('#grid .card').first()).toBeVisible();
  await expect.poll(() => cacheValue(page)).not.toBeNull();

  api.failRecipesWith401 = true;
  await page.reload();

  await expect(page.locator('#lock-screen')).toBeVisible();
  await expect(page.locator('#lock-err')).toContainText('Session expired');
  expect(await cacheValue(page)).toBeNull();
});

test('offline still works for a session that never locked', async ({ page, api }) => {
  await unlock(page);
  await expect(page.locator('#grid .card').first()).toBeVisible();
  await expect.poll(() => cacheValue(page)).not.toBeNull();

  // A network failure (not a 401) must still fall back to the saved recipes.
  await page.route('**/api/recipes', (route) => route.abort('failed'));
  await page.reload();

  await expect(page.locator('#app-content')).toBeVisible();
  await expect(page.locator('#grid .card').first()).toBeVisible();
  await expect(page.locator('#offline-banner')).toBeVisible();
});
