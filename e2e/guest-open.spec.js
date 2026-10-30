import { test, expect, unlock } from './helpers.js';

// The e2e API is mocked in e2e/helpers.js, so GUEST_OPEN is the `api.guestOpen`
// flag there, exactly as GUEST_CODE is the ACCESS_CODE constant.
const MEMBER_MENU_ITEMS = [/Export backup/, /Export with photos/, /Restore backup/, /Storage/];

function menuItem(page, name) {
  return page.locator('#app-menu button.menu-item').filter({ hasText: name });
}

async function lockScreen(page) {
  await page.goto('/');
  await expect(page.locator('#lock-screen')).toBeVisible();
}

test.describe('browse as guest, flag on', () => {
  test.beforeEach(async ({ api }) => { api.guestOpen = true; });

  test('the lock screen offers the button and it opens the app read-only', async ({ page, api }) => {
    await lockScreen(page);

    const guestBtn = page.locator('#guest-btn');
    await expect(guestBtn).toBeVisible();
    await guestBtn.click();

    await expect(page.locator('#app-content')).toBeVisible();
    await expect(page.locator('#lock-screen')).toBeHidden();
    await expect(page.locator('#role-pill')).toHaveText('View only');
    await expect(page.locator('body')).toHaveClass(/guest/);

    // Read-only: the same controls the typed guest code hides.
    await expect(page.getByRole('button', { name: /Add Photos/ })).toBeHidden();
    await expect(page.getByRole('button', { name: /Import URL/ })).toBeHidden();
    await expect(page.getByRole('button', { name: /Paste text/ })).toBeHidden();

    await page.locator('#grid .card').first().click();
    await expect(page.getByRole('button', { name: /Cook mode/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /I cooked this/ })).toBeHidden();
    await page.locator('#detail-overlay .modal-close').click();

    await page.locator('#menu-btn').click();
    for (const item of MEMBER_MENU_ITEMS) {
      await expect(menuItem(page, item)).toBeHidden();
    }
  });

  test('the shopping list and meal plan still work for a guest', async ({ page, api }) => {
    await lockScreen(page);
    await page.locator('#guest-btn').click();
    await expect(page.locator('#app-content')).toBeVisible();

    await page.locator('button.list-btn').click();
    await expect(page.locator('#shopping-overlay')).toBeVisible();
    await expect(page.locator('#shopping-overlay .btn-primary')).toBeVisible();
    await page.locator('#shopping-overlay .modal-close').click();
    await expect(page.locator('#shopping-overlay')).toBeHidden();

    await page.locator('button.plan-btn').click();
    await expect(page.locator('#plan-overlay')).toBeVisible();
  });

  test('locking the app offers the guest door again', async ({ page, api }) => {
    await lockScreen(page);
    await page.locator('#guest-btn').click();
    await expect(page.locator('#app-content')).toBeVisible();

    await page.locator('button[onclick="lockApp()"]').click();
    await expect(page.locator('#lock-screen')).toBeVisible();
    await expect(page.locator('#guest-btn')).toBeVisible();
  });

  test('the member code still works and still shows the write controls', async ({ page, api }) => {
    await unlock(page);

    await expect(page.locator('body')).not.toHaveClass(/guest/);
    await expect(page.locator('#role-pill')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Import URL/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Add Photos/ })).toBeVisible();
  });
});

test.describe('browse as guest, flag off', () => {
  test('the button is not on the lock screen', async ({ page, api }) => {
    api.guestOpen = false;
    await lockScreen(page);

    await expect(page.getByRole('button', { name: 'Enter', exact: true })).toBeVisible();
    await expect(page.locator('#guest-btn')).toBeHidden();
  });

  test('the member flow still works', async ({ page, api }) => {
    api.guestOpen = false;
    await unlock(page);
    await expect(page.locator('#app-content')).toBeVisible();
    await expect(page.getByRole('button', { name: /Import URL/ })).toBeVisible();
  });
});
