import { test, expect, unlock } from './helpers.js';

async function openList(page) {
  await page.getByRole('button', { name: /List/ }).click();
  await expect(page.locator('#shopping-overlay')).toHaveClass(/on/);
}

async function addItem(page, text) {
  await page.fill('#sl-input', text);
  await page.locator('#shopping-overlay').getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.locator('#sl-list')).toContainText(text);
}

test.describe('shopping list', () => {
  test('items are grouped under aisle headings', async ({ page, api }) => {
    await unlock(page);
    await openList(page);

    await addItem(page, '2 cups flour');
    await addItem(page, '1 onion');
    await addItem(page, '1 cup milk');

    await expect(page.locator('.sl-aisle-h').filter({ hasText: 'Pantry' })).toBeVisible();
    await expect(page.locator('.sl-aisle-h').filter({ hasText: 'Produce' })).toBeVisible();
    await expect(page.locator('.sl-aisle-h').filter({ hasText: 'Dairy & eggs' })).toBeVisible();

    // Turning grouping off returns to one flat list.
    await page.locator('#sl-group').uncheck();
    await expect(page.locator('.sl-aisle-h')).toHaveCount(0);
    await expect(page.locator('#sl-list .sl-item')).toHaveCount(3);
  });

  test('merge duplicates adds up compatible units and leaves others alone', async ({ page, api }) => {
    await unlock(page);
    await openList(page);

    await addItem(page, '2 cups flour');
    await addItem(page, '1 cup flour');
    await addItem(page, '200 g flour');

    await expect(page.locator('#sl-list .sl-item')).toHaveCount(3);

    await page.getByRole('button', { name: 'Merge duplicates' }).click();

    // The two cup lines become three cups; the gram line cannot mix with cups.
    await expect(page.locator('#sl-list')).toContainText('3 cup flour');
    await expect(page.locator('#sl-list')).toContainText('200 g flour');
    await expect(page.locator('#sl-list .sl-item')).toHaveCount(2);
  });

  test('shared mode writes to the shared list, not this device', async ({ page, api }) => {
    await unlock(page);
    await openList(page);

    await page.locator('#sl-shared').check();
    await expect(page.locator('#sl-note')).toContainText('Shared with everyone');

    await addItem(page, '2 cups flour');

    // The shared id travels in the POST body; GETs put it in the query string.
    const sharedPosts = api.requests.filter(
      (r) => r.path === '/api/shopping-list' && r.method === 'POST'
        && (r.url.includes('deviceId=shared') || String(r.body || '').includes('"deviceId":"shared"')),
    );
    expect(sharedPosts.length, 'a POST went to the shared list').toBeGreaterThan(0);
  });

  test('adding a recipe reports how many were added and merged', async ({ page, api }) => {
    await unlock(page);
    await openList(page);
    await addItem(page, '1 cup flour');
    await page.locator('#shopping-overlay .modal-close').click();

    // Call the action directly: the detail modal is covered by other specs, and
    // this one is about the merge bookkeeping.
    const id = api.recipes[0].id;
    await page.evaluate((rid) => globalThis.addRecipeToShoppingList(rid), id);

    await expect(page.locator('#toast')).toContainText('added');
    await expect(page.locator('#toast')).toContainText('merged');

    await openList(page);
    await expect(page.locator('#sl-list')).toContainText('spaghetti');
  });
});
