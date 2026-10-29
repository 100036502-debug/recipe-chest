import { test, expect, ACCESS_CODE } from './helpers.js';

test.describe('unlock screen', () => {
  test('a wrong code shows an error and keeps the app hidden', async ({ page, api }) => {
    await page.goto('/');
    await expect(page.locator('#lock-screen')).toBeVisible();

    await page.fill('#lock-input', 'not-the-code');
    await page.getByRole('button', { name: 'Enter', exact: true }).click();

    await expect(page.locator('#lock-err')).toHaveText(/incorrect access code/i);
    await expect(page.locator('#app-content')).toBeHidden();
    expect(api.unlocked, 'a wrong code must not unlock the session').toBe(false);
  });

  test('the right code reveals the recipe grid', async ({ page, api }) => {
    await page.goto('/');
    await page.fill('#lock-input', ACCESS_CODE);
    await page.getByRole('button', { name: 'Enter', exact: true }).click();

    await expect(page.locator('#app-content')).toBeVisible();
    await expect(page.locator('#lock-screen')).toBeHidden();
    await expect(page.locator('#grid .card')).toHaveCount(2);
    await expect(page.locator('#grid')).toContainText('Lemon Pasta');
    await expect(page.locator('#grid')).toContainText('Bean Stew');
    expect(api.unlocked).toBe(true);
  });

  test('an already-unlocked session skips the lock screen on reload', async ({ page, api }) => {
    await page.goto('/');
    await page.fill('#lock-input', ACCESS_CODE);
    await page.getByRole('button', { name: 'Enter', exact: true }).click();
    await expect(page.locator('#grid .card')).toHaveCount(2);

    await page.reload();
    await expect(page.locator('#app-content')).toBeVisible();
    await expect(page.locator('#lock-screen')).toBeHidden();
  });
});
