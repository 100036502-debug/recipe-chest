import { test, expect, unlock } from './helpers.js';

const METRIC = {
  kind: 'metric',
  summary: 'Converted the flour to grams.',
  before: { ingredients: ['2 cups flour', '1 cup milk'], instructions: ['Mix well'], notes: '' },
  after: { ingredients: ['240 g flour', '1 cup milk'], instructions: ['Mix well'], notes: 'Flour weighed.' },
};

async function openTools(page) {
  await unlock(page);
  await page.locator('#grid .card').first().click();
  await page.locator('#detail-overlay').getByRole('button', { name: /AI tools/ }).click();
  await expect(page.locator('#ai-overlay')).toBeVisible();
}

test.describe('AI tools', () => {
  test('shows the change, highlights it, and saves a copy with the right body', async ({ page, api }) => {
    await page.route('**/api/ai-transform**', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(METRIC),
    }));
    await openTools(page);

    await page.locator('#ai-btn-metric').click();

    await expect(page.locator('#ai-summary')).toHaveText('Converted the flour to grams.');
    // one removed line and one added line, the unchanged line is neither
    await expect(page.locator('#ai-result .ai-del')).toHaveCount(1);
    await expect(page.locator('#ai-result .ai-add')).toHaveCount(1);
    await expect(page.locator('#ai-result .ai-same')).toHaveCount(2);

    const posted = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().includes('/api/recipes')) {
        posted.push(request.postDataJSON());
      }
    });

    await page.locator('#ai-save-new').click();
    await expect.poll(() => posted.length).toBe(1);

    const body = posted[0];
    expect(body.title).toContain('(Metric)');
    expect(body.tags).toEqual(['adapted']);
    expect(body.skipDuplicateCheck).toBe(true);
    expect(body.sourceUrl).toBeUndefined();
    expect(body.ingredients).toEqual(METRIC.after.ingredients);
  });

  test('a daily cap is reported, not swallowed', async ({ page, api }) => {
    await page.route('**/api/ai-transform**', (route) => route.fulfill({
      status: 429,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Daily AI limit reached. Try again tomorrow.' }),
    }));
    await openTools(page);

    await page.locator('#ai-btn-metric').click();
    await expect(page.locator('#ai-result .ai-error')).toHaveText('Daily AI limit reached. Try again tomorrow.');
    await expect(page.locator('#ai-save-new')).toHaveCount(0);
  });

  test('nothing is written until Save or Replace is chosen', async ({ page, api }) => {
    await page.route('**/api/ai-transform**', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(METRIC),
    }));
    await openTools(page);

    const writes = [];
    page.on('request', (request) => {
      if (request.method() !== 'GET' && request.url().includes('/api/recipes')) writes.push(request.method());
    });

    await page.locator('#ai-btn-metric').click();
    await expect(page.locator('#ai-summary')).toBeVisible();
    expect(writes, 'a suggestion alone changes nothing').toHaveLength(0);
  });
});
