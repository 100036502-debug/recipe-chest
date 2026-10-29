/* eslint-disable no-undef -- the callbacks below run in the browser, not in Node. */
import { test, expect, unlock } from './helpers.js';

// Fires the event Chrome would fire when the app becomes installable. The plain
// Event is cancelable, so the app's preventDefault is honoured.
async function offerInstallPrompt(page) {
  await page.evaluate(() => {
    const event = new Event('beforeinstallprompt', { cancelable: true });
    event.prompt = () => { window.__prompted = true; };
    event.userChoice = Promise.resolve({ outcome: 'dismissed' });
    window.dispatchEvent(event);
  });
}

test('the install item appears only once the browser offers a prompt', async ({ page, api }) => {
  await unlock(page);

  await page.locator('#menu-btn').click();
  await expect(page.locator('#install-item')).toBeHidden();

  await offerInstallPrompt(page);
  await expect(page.locator('#install-item')).toBeVisible();

  await page.locator('#install-item').click();
  expect(await page.evaluate(() => window.__prompted)).toBe(true);
  await expect(page.locator('#install-item')).toBeHidden();
});

test('the install item never appears when already installed', async ({ page, api }) => {
  await page.addInitScript(() => {
    const real = window.matchMedia.bind(window);
    window.matchMedia = (query) => (query === '(display-mode: standalone)'
      ? { matches: true, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }
      : real(query));
  });

  await unlock(page);
  await offerInstallPrompt(page);

  await page.locator('#menu-btn').click();
  await expect(page.locator('#theme-item')).toBeVisible();
  await expect(page.locator('#install-item')).toBeHidden();
});

test('iOS gets a dismissible hint that stays dismissed', async ({ page, api }) => {
  await page.addInitScript(() => {
    // userAgent lives on Navigator.prototype in Chromium, so the instance is the
    // wrong place to look: patch the getter where it actually is.
    const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1';
    try {
      Object.defineProperty(Object.getPrototypeOf(navigator), 'userAgent', { get: () => ua, configurable: true });
    } catch (e) {
      try { Object.defineProperty(navigator, 'userAgent', { get: () => ua, configurable: true }); } catch (e2) { /* give up quietly */ }
    }
  });

  await unlock(page);
  await expect(page.locator('#ios-hint')).toBeVisible();
  await expect(page.locator('#ios-hint')).toContainText('Add to Home Screen');

  await page.locator('#ios-hint .ios-hint-close').click();
  await expect(page.locator('#ios-hint')).toBeHidden();

  await page.reload();
  await expect(page.locator('#grid .card').first()).toBeVisible();
  await expect(page.locator('#ios-hint')).toBeHidden();
});
