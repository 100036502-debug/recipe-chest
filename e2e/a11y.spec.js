/* eslint-disable no-undef -- the callbacks below run in the browser, not in Node. */
import { test, expect, unlock } from './helpers.js';
import AxeBuilder from '@axe-core/playwright';

// Serious and critical only: those are the ones that actually stop somebody
// using the app. Minor and moderate findings are reported in the run output.
const BLOCKING = ['serious', 'critical'];

const TOKEN = 'b'.repeat(32);
const SHARED = {
  title: 'Lemon Pasta',
  description: 'Bright and quick',
  prepTime: '10 min',
  cookTime: '',
  servings: '2',
  mealType: 'dinner',
  tags: ['pasta'],
  ingredients: ['2 cups flour', '1 tsp salt'],
  instructions: ['Mix it', 'Bake it'],
  notes: '',
  hasUserPhoto: false,
  image: {
    url: 'https://images.unsplash.com/x.jpg',
    alt: 'a bowl of lemon pasta',
    photographer: 'Ana',
    photographerUrl: 'https://u.example/ana',
    photoUrl: 'https://p.example/1',
    source: 'unsplash',
  },
};

async function scan(page, label) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  const blocking = results.violations.filter((v) => BLOCKING.includes(v.impact));
  // Print the failing nodes, so a red run says exactly what to change.
  const detail = blocking.map((v) => [
    `${v.id} [${v.impact}] x${v.nodes.length}`,
    ...v.nodes.slice(0, 3).map((node, i) => `  ${i + 1}. ${node.target.join(' ')} :: ${node.html.slice(0, 160)} :: ${(node.failureSummary || '').replace(/\s+/g, ' ').slice(0, 240)}`),
  ].join('\n'));
  expect(detail, `${label}: ${blocking.length} serious or critical violation(s)`).toEqual([]);
}

async function setTheme(page, theme) {
  await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
}

for (const theme of ['light', 'dark']) {
  test(`the recipe grid passes axe (${theme})`, async ({ page, api }) => {
    await unlock(page);
    await setTheme(page, theme);
    await scan(page, `grid ${theme}`);
  });

  test(`a recipe detail passes axe (${theme})`, async ({ page, api }) => {
    await unlock(page);
    await page.locator('#grid .card').first().click();
    await expect(page.locator('#detail-modal .recipe-title')).toBeVisible();
    await setTheme(page, theme);
    await scan(page, `detail ${theme}`);
  });

  test(`cook mode passes axe (${theme})`, async ({ page, api }) => {
    await unlock(page);
    await page.locator('#grid .card').first().click();
    await page.getByRole('button', { name: /Cook mode/ }).click();
    await expect(page.locator('#cook-content')).toBeVisible();
    await setTheme(page, theme);
    await scan(page, `cook mode ${theme}`);
  });

  test(`the shopping list passes axe (${theme})`, async ({ page, api }) => {
    await unlock(page);
    await page.locator('button.list-btn').click();
    await setTheme(page, theme);
    await scan(page, `shopping list ${theme}`);
  });
}

test('the public share page passes axe in both themes', async ({ page }) => {
  await page.route('**/api/share-view**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
    body: JSON.stringify(SHARED),
  }));

  await page.goto(`/s/${TOKEN}`);
  await expect(page.locator('.share-title')).toBeVisible();
  await scan(page, 'share page light');

  await setTheme(page, 'dark');
  await scan(page, 'share page dark');
});
