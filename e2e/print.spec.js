/* eslint-disable no-undef -- the callbacks below run in the browser, not in Node. */
import { test, expect, unlock } from './helpers.js';

async function openRecipe(page) {
  await page.locator('#grid .card').first().click();
  await expect(page.locator('#detail-modal .recipe-title')).toBeVisible();
}

test('the print card hides the app chrome and keeps the recipe', async ({ page, api }) => {
  await unlock(page);
  await openRecipe(page);

  await page.evaluate(() => document.body.classList.add('print-card'));
  await page.emulateMedia({ media: 'print' });

  // What a card must not waste ink on.
  await expect(page.locator('#detail-modal .actions')).toBeHidden();
  await expect(page.locator('#detail-modal .recipe-hero')).toBeHidden();
  await expect(page.locator('#detail-modal .delete-btn')).toBeHidden();

  // ...and what it must have.
  await expect(page.locator('#detail-modal .recipe-title')).toBeVisible();
  await expect(page.locator('#detail-modal .ing-list li').first()).toBeVisible();
  await expect(page.locator('#detail-modal .ing-list')).toContainText('spaghetti');

  // Two columns, and the card is still light even if the app is dark.
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  const background = await page.locator('#detail-modal').evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(background).toBe('rgb(255, 255, 255)');
  const columns = await page.locator('#detail-content').evaluate((el) => getComputedStyle(el).gridTemplateColumns);
  expect(columns.split(' ').length).toBe(2);
});

test('the card class is removed again after printing', async ({ page, api }) => {
  await unlock(page);
  await openRecipe(page);

  await page.evaluate(() => document.body.classList.add('print-card'));
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  await expect(page.locator('body')).not.toHaveClass(/print-card/);
});
