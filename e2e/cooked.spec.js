import { test, expect, unlock } from './helpers.js';

test('a cook logged from the detail view shows in the list and on the card', async ({ page, api }) => {
  await unlock(page);
  await page.locator('#grid .card').first().click();
  await expect(page.locator('#detail-overlay')).toHaveClass(/on/);

  await page.getByRole('button', { name: /I cooked this/ }).click();
  await expect(page.locator('#cooked-overlay')).toHaveClass(/on/);

  await page.locator('label[for="cr4"]').click();
  await page.fill('#cooked-note', 'Turned out well');
  await page.locator('#cooked-overlay').getByRole('button', { name: 'Save', exact: true }).click();

  await expect(page.locator('#cooked-overlay')).not.toHaveClass(/on/);
  await expect(page.locator('.cooked-section')).toContainText('Cooked 1 time');
  await expect(page.locator('.cooked-list')).toContainText('Turned out well');

  await page.locator('#detail-overlay .modal-close').click();
  await expect(page.locator('#grid .card').first()).toContainText('Cooked 1×');
});

test('the never-cooked filter hides a recipe once it has been cooked', async ({ page, api }) => {
  api.recipes[0].cookLog = [{ id: 'e1', date: '2025-10-12', rating: 5, note: '', by: '' }];
  await unlock(page);
  await page.locator('.filter-chip', { hasText: 'Never cooked' }).click();
  await expect(page.locator('#grid .card')).toHaveCount(1);
  await expect(page.locator('#grid')).toContainText('Bean Stew');
});
