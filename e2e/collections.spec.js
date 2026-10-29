import { test, expect, unlock } from './helpers.js';

test('a recipe can be put in a collection and filtered by it', async ({ page, api }) => {
  await unlock(page);
  await page.locator('#grid .card').first().click();
  await expect(page.locator('#detail-overlay')).toHaveClass(/on/);

  await page.locator('.coll-detail-row').getByRole('button', { name: /Add to collection/ }).click();
  await page.fill('#coll-input', 'Weeknight');
  await page.locator('#coll-input').press('Enter');
  await expect(page.locator('.coll-detail-row')).toContainText('Weeknight');

  await page.locator('#detail-overlay .modal-close').click();
  await expect(page.locator('.coll-row')).toContainText('Weeknight');

  await page.locator('.coll-row [data-coll="Weeknight"]').click();
  await expect(page.locator('#grid .card')).toHaveCount(1);
  await expect(page.locator('#grid')).toContainText('Lemon Pasta');
});

test('renaming a collection changes the filter chip', async ({ page, api }) => {
  api.recipes[0].collections = ['Dinner'];
  await unlock(page);
  await expect(page.locator('.coll-row')).toContainText('Dinner');

  await page.locator('.coll-manage').click();
  await expect(page.locator('#coll-overlay')).toHaveClass(/on/);
  page.once('dialog', (dialog) => dialog.accept('Supper'));
  await page.locator('#coll-manager-body').getByRole('button', { name: 'Rename' }).click();
  await expect(page.locator('#coll-manager-body')).toContainText('Supper');

  await page.locator('#coll-overlay .modal-close').click();
  await expect(page.locator('.coll-row')).toContainText('Supper');
});
