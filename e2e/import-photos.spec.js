import { test, expect, unlock, callsTo, TINY_JPEG, TINY_PDF } from './helpers.js';

// Guards the regression this suite exists for: a doubled /api/api/ prefix
// made every photo import 404 while the UI looked like it was working.
test.describe('Add Photos import', () => {
  test('an image posts to exactly /api/process and shows as saved', async ({ page, api }) => {
    await unlock(page);

    await page.getByRole('button', { name: /Add Photos/ }).click();
    await expect(page.locator('#upload-overlay')).toBeVisible();

    await page.setInputFiles('#file-input', {
      name: 'recipe.jpg',
      mimeType: 'image/jpeg',
      buffer: TINY_JPEG,
    });

    await expect(page.locator('#queue-list .queue-item, #queue-list li, #queue-list > div')).not.toHaveCount(0);
    await page.locator('#process-btn').click();

    await expect.poll(() => callsTo(api, '/api/process').length, {
      message: 'the image should be posted to /api/process',
    }).toBe(1);

    // The bug this catches: the app must never post to a doubled prefix.
    expect(callsTo(api, '/api/api/process'), 'no doubled /api/api/process call').toHaveLength(0);

    await expect(page.locator('#queue-list')).toContainText('Imported Photo Recipe');
  });

  test('a PDF posts to /api/process-pdf', async ({ page, api }) => {
    await unlock(page);

    await page.getByRole('button', { name: /Add Photos/ }).click();
    await page.setInputFiles('#file-input', {
      name: 'recipe.pdf',
      mimeType: 'application/pdf',
      buffer: TINY_PDF,
    });

    await page.locator('#process-btn').click();

    await expect.poll(() => callsTo(api, '/api/process-pdf').length, {
      message: 'the PDF should be posted to /api/process-pdf',
    }).toBe(1);
    expect(callsTo(api, '/api/api/process-pdf')).toHaveLength(0);
    expect(callsTo(api, '/api/process'), 'a PDF must not go through /api/process').toHaveLength(0);

    await expect(page.locator('#queue-list')).toContainText('Imported PDF Recipe');
  });
});
