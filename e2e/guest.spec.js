import { test, expect } from './helpers.js';

const GUEST_SESSION = {
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify({ unlocked: true, role: 'guest' }),
};

test.describe('guest access', () => {
  test('a guest sees the recipe chest but none of the write buttons', async ({ page, api }) => {
    await page.route('**/api/verify-code**', (route) => route.fulfill(GUEST_SESSION));

    await page.goto('/');
    await expect(page.locator('#app-content')).toBeVisible();

    await expect(page.locator('body')).toHaveClass(/guest/);
    await expect(page.locator('#role-pill')).toHaveText('View only');

    // the chest itself is readable
    await expect(page.getByRole('button', { name: /Cook mode/ }).first()).toBeVisible();

    // everything that changes data is gone
    await expect(page.getByRole('button', { name: /Import URL/ })).toBeHidden();
    await expect(page.getByRole('button', { name: /Paste text/ })).toBeHidden();
    await expect(page.getByRole('button', { name: /Add Photos/ })).toBeHidden();
  });

  test('a member still gets the full set of buttons', async ({ page, api }) => {
    await page.goto('/');
    await expect(page.locator('#app-content')).toBeVisible();

    await expect(page.locator('body')).not.toHaveClass(/guest/);
    await expect(page.locator('#role-pill')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Import URL/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Paste text/ })).toBeVisible();
  });
});
