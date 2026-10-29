import { test, expect, unlock } from './helpers.js';

async function openPantry(page) {
  await page.getByRole('button', { name: /What can I make/ }).click();
  await expect(page.locator('#pantry-overlay')).toHaveClass(/on/);
}

async function addPantry(page, text) {
  await page.fill('#pantry-input', text);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.locator('#pantry-chips')).toContainText(text);
}

test.describe('what can I make', () => {
  test('pantry items rank the recipe you can actually cook first', async ({ page }) => {
    await unlock(page);
    await openPantry(page);

    // Lemon Pasta needs spaghetti, lemon and parmesan.
    await addPantry(page, 'spaghetti');
    await addPantry(page, 'lemon');

    const first = page.locator('.pantry-card').first();
    await expect(first.locator('.pantry-card-title')).toHaveText('Lemon Pasta');
    await expect(first.locator('.pantry-card-score')).toHaveText('Have 2 of 3');
    await expect(first.locator('.pantry-card-missing')).toContainText('Missing: parmesan');

    // Bean Stew has none of it, so it must not be listed at all.
    await expect(page.locator('#pantry-results')).not.toContainText('Bean Stew');
  });

  test('a pantry chip can be removed and the results follow', async ({ page }) => {
    await unlock(page);
    await openPantry(page);
    await addPantry(page, 'spaghetti');
    await addPantry(page, 'lemon');
    await page.locator('.pantry-chip-x').first().click();
    await expect(page.locator('#pantry-chips')).not.toContainText('spaghetti');
    // One of three left is below the default bar, so nothing qualifies now.
    await expect(page.locator('.pantry-empty')).toBeVisible();
  });

  test('the pantry survives a reload', async ({ page }) => {
    await unlock(page);
    await openPantry(page);
    await addPantry(page, 'beans');
    await page.reload();
    await expect(page.locator('#app-content')).toBeVisible();
    await openPantry(page);
    await expect(page.locator('#pantry-chips')).toContainText('beans');
  });
});
