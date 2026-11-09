/* eslint-disable no-undef -- the callbacks below run in the browser, not in Node. */
import { test, expect, unlock } from './helpers.js';

// Every sidebar item is the same plain-text link: one style, no pill, no
// border, no icon. This replaces the old check that Paste text matched Import
// URL, which is the same idea applied to the whole list.

const PROPS = [
  'backgroundColor', 'color', 'borderTopWidth', 'borderTopStyle', 'borderRadius',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'fontSize', 'fontWeight', 'fontFamily', 'textDecorationLine', 'boxShadow',
];

async function styleOf(locator) {
  return locator.evaluate((el, props) => {
    const cs = el.ownerDocument.defaultView.getComputedStyle(el);
    const out = {};
    for (const p of props) out[p] = cs[p];
    return out;
  }, PROPS);
}

const LABELS = [
  'All recipes', 'Tonight', 'Calendar', 'Shopping list', 'Pantry', 'What can I make?',
  'Import URL', 'Paste text', 'Add Photos',
];

test('the sidebar has the nine links, in order, with no emoji and none of the retired ones', async ({ page, api }) => {
  await unlock(page);
  const texts = await page.locator('.sidebar-nav .side-link').allTextContents();
  expect(texts.map((t) => t.trim())).toEqual(LABELS);
  for (const t of texts) expect(t).not.toMatch(/\p{Extended_Pictographic}/u);
  for (const gone of ['Plan', 'Meal plan', 'List']) expect(texts.map((t) => t.trim())).not.toContain(gone);
});

test('every sidebar item looks identical: one shape, one colour', async ({ page, api }) => {
  await unlock(page);
  await page.addStyleTag({ content: '*{transition:none !important}' });
  const links = page.locator('.sidebar-nav .side-link');
  const first = await styleOf(links.nth(1)); // not the current page (All recipes is)
  expect(first.backgroundColor).toBe('rgba(0, 0, 0, 0)');
  expect(first.borderTopWidth).toBe('0px');
  expect(first.borderRadius).toBe('10px');
  expect(first.fontSize).toBe('16px');
  // The five view links share one shape; the action buttons below them are a
  // different group and are compared by their own test below.
  for (let i = 2; i <= 4; i += 1) {
    expect(await styleOf(links.nth(i)), LABELS[i]).toEqual(first);
  }
});

test('hover brightens a link, and the current page is bright', async ({ page, api }) => {
  await unlock(page);
  await page.addStyleTag({ content: '*{transition:none !important}' });
  await expect(page.locator('.sidebar-nav .side-link').first()).toHaveAttribute('aria-current', 'page');
  const other = page.locator('.sidebar-nav .side-link', { hasText: 'Import URL' });
  await other.hover();
  expect(await other.evaluate((el) => getComputedStyle(el).color)).toBe('rgb(23, 32, 51)'); // ink
});
