import { test, expect, unlock } from './helpers.js';

const GUEST_SESSION = {
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify({ unlocked: true, role: 'guest' }),
};

const MEMBER_MENU_ITEMS = [/Export backup/, /Export with photos/, /Restore backup/, /Storage/];

test.describe('guest access', () => {
  test('a guest sees the recipe chest but none of the write buttons', async ({ page, api }) => {
    await unlock(page);
    // Same cookie, but the session check now answers "guest".
    await page.route('**/api/verify-code**', (route) => route.fulfill(GUEST_SESSION));
    await page.reload();
    await expect(page.locator('#app-content')).toBeVisible();

    await expect(page.locator('body')).toHaveClass(/guest/);
    await expect(page.locator('#role-pill')).toHaveText('View only');

    // the chest itself is readable
    await expect(page.getByRole('button', { name: /Import URL/ })).toBeHidden();
    await expect(page.getByRole('button', { name: /Paste text/ })).toBeHidden();

    // and so is a recipe, in full
    await page.locator('#grid .card').first().click();
    await expect(page.getByRole('button', { name: /Cook mode/ })).toBeVisible();

    // everything that changes data is gone
    await expect(page.getByRole('button', { name: /Share link/ })).toBeHidden();
    await expect(page.getByRole('button', { name: /Add Photos/ })).toBeHidden();
    await expect(page.getByRole('button', { name: /I cooked this/ })).toBeHidden();
    await expect(page.getByRole('button', { name: /Add my photo/ })).toBeHidden();
    await expect(page.getByRole('button', { name: /Add tag/ })).toBeHidden();
    await expect(page.getByRole('button', { name: /Add to collection/ })).toBeHidden();

    // the header menu hides the member-only actions too
    await page.locator('#detail-overlay .modal-close').click();
    await page.locator('#menu-btn').click();
    await expect(page.locator('#app-menu')).toBeVisible();
    for (const item of MEMBER_MENU_ITEMS) {
      await expect(page.locator('#app-menu').getByRole('button', { name: item })).toBeHidden();
    }
  });

  test('a member still gets the full set of buttons', async ({ page, api }) => {
    await unlock(page);

    await expect(page.locator('body')).not.toHaveClass(/guest/);
    await expect(page.locator('#role-pill')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Import URL/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Paste text/ })).toBeVisible();

    await page.locator('#menu-btn').click();
    await expect(page.locator('#app-menu')).toBeVisible();
    for (const item of MEMBER_MENU_ITEMS) {
      await expect(page.locator('#app-menu').getByRole('button', { name: item })).toBeVisible();
    }
  });
});
