import { test, expect, unlock } from './helpers.js';

test.describe('client utilities', () => {
  // The api fixture installs the /api/** mocks; without it the unlock call
  // would hit the static server and 404.
  test('js/utils.js loads before the app and exposes RCUtils', async ({ page, api }) => {
    await unlock(page);

    const info = await page.evaluate(() => {
      const utils = globalThis.RCUtils;
      return {
        available: typeof utils === 'object' && utils !== null,
        parsed: utils ? utils.parseIngredientLine('2 cups flour') : null,
        order: Array.from(globalThis.document.querySelectorAll('script[src]')).map((s) => s.getAttribute('src')),
      };
    });

    expect(info.available, 'RCUtils must be on the global object').toBe(true);
    expect(info.parsed.qty).toBe(2);
    expect(info.parsed.unit).toBe('cup');
    expect(info.parsed.name).toBe('flour');

    // app.js calls RCUtils at parse time, so utils.js must come first.
    expect(info.order.indexOf('/js/utils.js')).toBeGreaterThan(-1);
    expect(info.order.indexOf('/js/utils.js')).toBeLessThan(info.order.indexOf('/js/app.js'));
    expect(api.unlocked, 'the page really unlocked').toBe(true);
  });
});
