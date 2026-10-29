import { test, expect, unlock, callsTo } from './helpers.js';

test.describe('Import from URL', () => {
  test('posts to /api/import-url and opens the new recipe', async ({ page, api }) => {
    await unlock(page);

    await page.getByRole('button', { name: /Import URL/ }).click();
    await expect(page.locator('#import-overlay')).toBeVisible();

    await page.fill('#import-url', 'https://example.com/best-lasagne');
    await page.locator('#import-btn').click();

    await expect.poll(() => callsTo(api, '/api/import-url').length, {
      message: 'the URL should be posted to /api/import-url',
    }).toBe(1);
    expect(callsTo(api, '/api/api/import-url')).toHaveLength(0);

    // The dialog closes and the imported recipe opens in the detail modal.
    await expect(page.locator('#import-overlay')).not.toHaveClass(/on/);
    await expect(page.locator('#detail-overlay')).toHaveClass(/on/);
    await expect(page.locator('#detail-content')).toContainText('Imported Web Recipe');
  });

  test('rejects a URL that is not http(s) without calling the API', async ({ page, api }) => {
    await unlock(page);

    await page.getByRole('button', { name: /Import URL/ }).click();
    await page.fill('#import-url', 'not-a-url');
    await page.locator('#import-btn').click();

    await expect(page.locator('#import-status')).toContainText(/must start with http/i);
    expect(callsTo(api, '/api/import-url')).toHaveLength(0);
  });
});
