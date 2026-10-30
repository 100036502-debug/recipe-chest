import { test, expect, unlock } from './helpers.js';

const PROPS = [
  'backgroundColor', 'color', 'borderTopWidth', 'borderTopStyle', 'borderRadius',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'fontSize', 'fontWeight', 'fontFamily', 'display', 'columnGap', 'whiteSpace',
  'cursor', 'height', 'boxShadow', 'transform',
];

async function styleOf(locator) {
  return locator.evaluate((el, props) => {
    const cs = el.ownerDocument.defaultView.getComputedStyle(el);
    const out = {};
    for (const p of props) out[p] = cs[p];
    return out;
  }, PROPS);
}

for (const theme of ['light', 'dark']) {
  test(`Paste text button looks like Import URL (${theme})`, async ({ page, api }) => {
    await page.addInitScript((t) => {
      try { localStorage.setItem('rc_theme', t); } catch { /* storage blocked */ }
    }, theme);
    await unlock(page);
    // Colours transition over 0.25s; compare the settled values.
    await page.addStyleTag({ content: '*{transition:none !important}' });

    const importBtn = page.locator('.header-btns .import-btn');
    const pasteBtn = page.locator('.header-btns .paste-btn');
    await expect(pasteBtn).toBeVisible();

    expect(await styleOf(pasteBtn)).toEqual(await styleOf(importBtn));

    await importBtn.hover();
    const importHover = await styleOf(importBtn);
    await pasteBtn.hover();
    expect(await styleOf(pasteBtn)).toEqual(importHover);
  });
}
