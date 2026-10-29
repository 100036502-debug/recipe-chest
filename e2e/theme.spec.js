import { test, expect, unlock } from './helpers.js';

async function pickDark(page) {
  // The control cycles Auto -> Light -> Dark, so it takes two clicks from the
  // default. Re-open the menu each time in case it closes after a choice.
  for (let i = 0; i < 2; i += 1) {
    await page.locator('#menu-btn').click();
    await page.locator('#theme-item').click();
  }
  await expect(page.locator('#theme-item')).toContainText('Dark');
}

test('dark mode can be chosen, repaints, and survives a reload', async ({ page, api }) => {
  const problems = [];
  page.on('console', (message) => { if (message.type() === 'error') problems.push(message.text()); });
  page.on('pageerror', (error) => problems.push(error.message));

  await unlock(page);
  const before = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

  await pickDark(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  const after = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(after, 'the page actually repaints, not just the attribute').not.toBe(before);

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const reloaded = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(reloaded, 'no flash of light on the way back in').toBe(after);

  expect(problems).toEqual([]);
});

test('the choice can be put back to auto', async ({ page, api }) => {
  await unlock(page);
  await pickDark(page);
  await page.locator('#menu-btn').click();
  await page.locator('#theme-item').click(); // dark -> auto
  await expect(page.locator('#theme-item')).toContainText('Auto');
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'dark');
});
