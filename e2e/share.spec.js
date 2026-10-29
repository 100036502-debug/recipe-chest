import { test, expect } from './helpers.js';

const TOKEN = 'a'.repeat(32);

const SHARED = {
  title: '<img src=x onerror=alert(1)>',
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
    alt: 'x',
    photographer: 'Ana',
    photographerUrl: 'https://u.example/ana',
    photoUrl: 'https://p.example/1',
    source: 'unsplash',
  },
};

test.describe('read-only share page', () => {
  test('renders the recipe and shows a hostile title as text', async ({ page, api }) => {
    const errors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', (err) => errors.push(err.message));

    await page.route('**/api/share-view**', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
      body: JSON.stringify(SHARED),
    }));

    await page.goto('/s/' + TOKEN);

    // The title is text, not markup: exactly one img on the page (the hero).
    await expect(page.locator('.share-title')).toHaveText('<img src=x onerror=alert(1)>');
    await expect(page.locator('#share-root img')).toHaveCount(1);
    await expect(page.locator('.share-ing')).toContainText('2 cups flour');
    await expect(page.locator('.share-steps')).toContainText('Bake it');
    await expect(page.locator('.share-credit')).toContainText('Ana');
    await expect(page.locator('.share-footer')).toContainText('Shared from Recipe Chest');

    expect(errors, 'no console or page errors').toHaveLength(0);
  });

  test('a revoked link shows the same friendly message and never the recipe', async ({ page, api }) => {
    await page.route('**/api/share-view**', (route) => route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'This link is no longer available.' }),
    }));

    await page.goto('/s/' + TOKEN);
    await expect(page.locator('.share-error')).toHaveText('This link is no longer available.');
    await expect(page.locator('.share-title')).toHaveCount(0);
  });

  test('a malformed token never reaches the network', async ({ page, api }) => {
    let calls = 0;
    await page.route('**/api/share-view**', (route) => {
      calls += 1;
      return route.fulfill({ status: 500, body: '{}', contentType: 'application/json' });
    });

    await page.goto('/s/not-a-token');
    await expect(page.locator('.share-error')).toHaveText('This link is no longer available.');
    expect(calls, 'no request for an invalid token').toBe(0);
  });
});
