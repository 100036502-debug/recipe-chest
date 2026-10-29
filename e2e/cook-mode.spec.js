import { test, expect, unlock } from './helpers.js';

// A recipe with one step that carries a duration, so the timer chips appear.
const COOK_RECIPE = {
  id: 'cook1',
  title: 'Timer Test Soup',
  description: 'A soup with a timer in it.',
  tags: ['soup'],
  mealType: 'dinner',
  ingredients: ['2 cups stock', '1 onion'],
  instructions: ['Chop the onion.', 'Simmer for 2 minutes.', 'Serve.'],
  addedBy: 'Sam',
  favorite: false,
};

async function openCookMode(page, api) {
  api.recipes = [COOK_RECIPE];
  await unlock(page);
  await page.locator('#grid .card').first().click();
  await page.getByRole('button', { name: /Cook mode/ }).click();
  await expect(page.locator('.cook-mode')).toBeVisible();
}

test.describe('cook mode', () => {
  test('a step timer counts down and announces itself', async ({ page, api }) => {
    await page.clock.install();
    await openCookMode(page, api);

    // One chip, for the step that says "2 minutes".
    await expect(page.locator('.cook-timer-chip')).toHaveCount(1);
    await page.locator('.cook-timer-chip').click();

    const timer = page.locator('.cook-timer');
    await expect(timer).toHaveCount(1);
    await expect(timer.locator('.cook-timer-time')).toHaveText('2:00');
    await expect(timer.locator('.cook-timer-label')).toHaveText('2 min');

    // 121s: the timer has just fired, and the toast has not expired yet.
    await page.clock.runFor(121_000);

    await expect(timer).toHaveClass(/done/);
    await expect(page.locator('#toast')).toContainText('Timer done: 2 min');
  });

  test('pause freezes the countdown and +1 min extends it', async ({ page, api }) => {
    await page.clock.install();
    await openCookMode(page, api);
    await page.locator('.cook-timer-chip').click();

    const timer = page.locator('.cook-timer');
    await page.clock.runFor(30_000);
    await expect(timer.locator('.cook-timer-time')).toHaveText('1:30');

    await timer.getByRole('button', { name: 'Pause' }).click();
    await page.clock.runFor(60_000);
    // Time passing while paused must not move the countdown.
    await expect(timer.locator('.cook-timer-time')).toHaveText('1:30');

    await timer.getByRole('button', { name: '+1 min' }).click();
    await expect(timer.locator('.cook-timer-time')).toHaveText('2:30');

    await timer.getByRole('button', { name: 'Resume' }).click();
    await page.clock.runFor(10_000);
    await expect(timer.locator('.cook-timer-time')).toHaveText('2:20');
  });

  test('a ticked ingredient and a finished step survive a reload', async ({ page, api }) => {
    await openCookMode(page, api);

    await page.locator('.cook-ing-check').first().check();
    await expect(page.locator('.cook-ing-row').first()).toHaveClass(/checked/);

    await page.locator('.cook-step').first().click();
    await expect(page.locator('#cook-progress')).toHaveText('1 of 3 steps done');

    await page.reload();
    await expect(page.locator('#app-content')).toBeVisible();
    await page.locator('#grid .card').first().click();
    await page.getByRole('button', { name: /Cook mode/ }).click();

    await expect(page.locator('.cook-ing-check').first()).toBeChecked();
    await expect(page.locator('.cook-step').first()).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#cook-progress')).toHaveText('1 of 3 steps done');

    // Reset clears both, and the change is persisted.
    await page.locator('.cook-reset').click();
    await expect(page.locator('#cook-progress')).toHaveText('0 of 3 steps done');
    await expect(page.locator('.cook-ing-check').first()).not.toBeChecked();
  });

  test('the text size buttons scale cook mode and remember the choice', async ({ page, api }) => {
    await openCookMode(page, api);

    // Custom properties are read straight off the computed style: toHaveCSS is
    // unreliable for them.
    const scaleOf = () => page.locator('.cook-mode').evaluate(
      (el) => getComputedStyle(el).getPropertyValue('--cook-scale').trim(),
    );

    expect(await scaleOf()).toBe('1');

    await page.getByRole('button', { name: 'Larger text' }).click();
    expect(await scaleOf()).toBe('1.15');

    const bigger = page.getByRole('button', { name: 'Larger text' });
    await bigger.click();
    await bigger.click();
    await bigger.click();
    // Tops out at 1.75 rather than running away.
    await bigger.click();
    expect(await scaleOf()).toBe('1.75');
  });
});
