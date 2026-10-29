import { test, expect, unlock } from './helpers.js';

test.describe('session expiry', () => {
  test('a 401 from /api/recipes brings back the lock screen with a clear message', async ({ page, api }) => {
    await unlock(page);
    await expect(page.locator('#grid .card')).toHaveCount(2);

    // The cookie has expired: the next data call comes back 401.
    api.failRecipesWith401 = true;
    await page.evaluate('loadRecipes()');

    await expect(page.locator('#lock-screen')).toBeVisible();
    await expect(page.locator('#lock-err')).toHaveText(/session expired/i);
    await expect(page.locator('#app-content')).toBeHidden();
  });

  test('unlocking again after expiry restores the app', async ({ page, api }) => {
    await unlock(page);
    api.failRecipesWith401 = true;
    await page.evaluate('loadRecipes()');
    await expect(page.locator('#lock-screen')).toBeVisible();

    api.failRecipesWith401 = false;
    await page.fill('#lock-input', 'letmein');
    await page.getByRole('button', { name: 'Enter', exact: true }).click();

    await expect(page.locator('#app-content')).toBeVisible();
    await expect(page.locator('#grid .card')).toHaveCount(2);
    await expect(page.locator('#lock-err')).toHaveText('');
  });
});
