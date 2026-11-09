import { test, expect, unlock, ACCESS_CODE } from './helpers.js';

// The matcher and the Pantry page are two views of one stored list. Adding a
// name in either place has to show up in the other, and survive a reload.

const openMatcher = async (page) => {
  await page.locator('.sidebar-nav').getByRole('button', { name: /What can I make/ }).click();
  await expect(page.locator('#pantry-overlay')).toHaveClass(/on/);
};
const closeMatcher = async (page) => {
  await page.keyboard.press('Escape');
  await expect(page.locator('#pantry-overlay')).not.toHaveClass(/on/);
};
// A reload keeps the session, so only use the lock screen when it is there.
const enterApp = async (page) => {
  if (await page.locator('#lock-screen').isVisible()) {
    await page.fill('#lock-input', ACCESS_CODE);
    await page.getByRole('button', { name: 'Enter', exact: true }).click();
  }
  await expect(page.locator('#app-content')).toBeVisible();
};
const openPantryPage = async (page) => {
  await page.locator('.sidebar-nav').getByRole('link', { name: 'Pantry' }).click();
  await expect(page.locator('#view-pantry')).toBeVisible();
};

test('a name added in What can I make shows on the Pantry page', async ({ page, api }) => {
  await unlock(page);
  await openMatcher(page);
  await page.fill('#pantry-input', 'chickpeas');
  await page.locator('#pantry-overlay').getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.locator('#pantry-chips')).toContainText('chickpeas');
  await closeMatcher(page);

  await openPantryPage(page);
  await expect(page.locator('#pantry-view-list')).toContainText('chickpeas');
  await expect(page.locator('#pantry-view-count')).toHaveText('1 ingredient');
});

test('a name added on the Pantry page shows in What can I make, and both survive a reload', async ({ page, api }) => {
  await unlock(page);
  await openPantryPage(page);
  await page.fill('#pantry-view-input', 'sumac');
  await page.press('#pantry-view-input', 'Enter');
  await expect(page.locator('#pantry-view-list')).toContainText('sumac');

  await page.reload();
  await enterApp(page);
  await openPantryPage(page);
  await expect(page.locator('#pantry-view-list')).toContainText('sumac');

  await openMatcher(page);
  await expect(page.locator('#pantry-chips')).toContainText('sumac');
});

test('removing on one side removes it on the other', async ({ page, api }) => {
  await unlock(page);
  await openPantryPage(page);
  await page.fill('#pantry-view-input', 'tahini, lemon');
  await page.press('#pantry-view-input', 'Enter');
  await expect(page.locator('.pantry-view-item')).toHaveCount(2);

  await page.locator('#pantry-view-list .pantry-view-x').first().click();
  await expect(page.locator('.pantry-view-item')).toHaveCount(1);

  await openMatcher(page);
  await expect(page.locator('#pantry-chips')).not.toContainText('tahini');
  await expect(page.locator('#pantry-chips')).toContainText('lemon');
});
