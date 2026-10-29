import { test, expect, unlock } from './helpers.js';

test.describe('share target', () => {
  test('a shared link opens the import dialog prefilled, not submitted', async ({ page, api }) => {
    await unlock(page);

    await page.goto('/?url=' + encodeURIComponent('https://example.com/recipe/42'));
    await expect(page.locator('#app-content')).toBeVisible();

    await expect(page.locator('#import-overlay')).toHaveClass(/on/);
    const input = page.locator('#import-overlay input').first();
    await expect(input).toHaveValue('https://example.com/recipe/42');

    // A shared link is a starting point, never an automatic import.
    await expect
      .poll(() => api.requests.filter((r) => r.path === '/api/import-url').length, {
        message: 'nothing should be imported without the user asking',
      })
      .toBe(0);
  });

  test('shared text with no link opens the paste dialog prefilled', async ({ page, api }) => {
    await unlock(page);

    const text = 'Grandma soup. Simmer two cups of stock with one onion for twenty minutes, then season.';
    await page.goto('/?text=' + encodeURIComponent(text));
    await expect(page.locator('#app-content')).toBeVisible();

    await expect(page.locator('#paste-overlay')).toHaveClass(/on/);
    await expect(page.locator('#paste-text')).toHaveValue(text);
  });
});
