import { test, expect, unlock, callsTo, postsTo, TINY_JPEG } from './helpers.js';

test.describe('my photo of the dish', () => {
  test('choosing a file posts it to /api/photo', async ({ page, api }) => {
    await unlock(page);

    await page.locator('#grid .card').first().click();
    await expect(page.locator('#detail-overlay')).toHaveClass(/on/);

    // The app builds the file input on the fly and clicks it, so the picker
    // arrives as a filechooser event rather than a file input in the DOM.
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByRole('button', { name: /Add my photo/ }).click(),
    ]);
    await chooser.setFiles({
      name: 'my-dish.jpg',
      mimeType: 'image/jpeg',
      buffer: TINY_JPEG,
    });

    // The optional photo-credit step sits between the picker and the upload.
    await expect(page.locator('#credit-overlay')).toHaveClass(/on/);
    await page.locator('#credit-upload-btn').click();

    // GET /api/photo is also used for thumbnails, so count POSTs only.
    await expect.poll(() => postsTo(api, '/api/photo').length, {
      message: 'the photo should be posted once to /api/photo',
    }).toBe(1);
    expect(callsTo(api, '/api/api/photo')).toHaveLength(0);
  });

  test('cancelling the credit step uploads nothing', async ({ page, api }) => {
    await unlock(page);

    await page.locator('#grid .card').first().click();
    await expect(page.locator('#detail-overlay')).toHaveClass(/on/);

    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByRole('button', { name: /Add my photo/ }).click(),
    ]);
    await chooser.setFiles({ name: 'my-dish.jpg', mimeType: 'image/jpeg', buffer: TINY_JPEG });

    await expect(page.locator('#credit-overlay')).toHaveClass(/on/);
    // "Cancel" also exists in other dialogs, so scope it to the credit step.
    await page.locator('#credit-overlay').getByRole('button', { name: 'Cancel', exact: true }).click();

    await expect(page.locator('#credit-overlay')).not.toHaveClass(/on/);
    expect(postsTo(api, '/api/photo'), 'cancel must not upload').toHaveLength(0);
  });
});
