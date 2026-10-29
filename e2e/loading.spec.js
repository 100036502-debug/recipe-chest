import { test, expect, unlock } from './helpers.js';

test('the grid shows skeleton cards while the first load is in flight', async ({ page, api }) => {
  // Unlock once, then reload with /api/recipes held back, so the loading state
  // is what a real first paint looks like.
  await unlock(page);

  await page.route('**/api/recipes**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 900));
    await route.fallback();
  });

  await page.reload();

  const grid = page.locator('#grid');
  await expect(grid).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('.skeleton-card')).toHaveCount(8);
  await expect(page.locator('.skeleton-card').first()).toBeVisible();

  // ...and they give way to real cards, with aria-busy cleared.
  await expect(page.locator('.card:not(.skeleton-card)').first()).toBeVisible();
  await expect(page.locator('.skeleton-card')).toHaveCount(0);
  await expect(grid).not.toHaveAttribute('aria-busy', 'true');
});

test('skeletons are grey blocks with no text a screen reader would read', async ({ page, api }) => {
  await unlock(page);

  await page.route('**/api/recipes**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 700));
    await route.fallback();
  });

  await page.reload();
  await expect(page.locator('.skeleton-card').first()).toBeVisible();

  await expect(page.locator('.skeleton-card').first()).toHaveAttribute('aria-hidden', 'true');
  const text = await page.locator('.skeleton-card').first().innerText().catch(() => '');
  expect(text.trim()).toBe('');

  await expect(page.locator('.card:not(.skeleton-card)').first()).toBeVisible();
});
