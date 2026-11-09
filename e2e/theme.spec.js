/* eslint-disable no-undef -- the callbacks below run in the browser, not in Node. */
import { test, expect, unlock } from './helpers.js';

// Light is the default now, with a dark variant behind the theme control. These
// pin the behaviour a person actually gets: a pinned choice wins, and auto
// follows the operating system.

test('light is the default', async ({ page, api }) => {
  await unlock(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toBe('rgb(246, 247, 244)'); // #F6F7F4
});

test('a saved dark choice wins', async ({ page, api }) => {
  await page.addInitScript(() => { try { localStorage.setItem('rc_theme', 'dark'); } catch { /* blocked */ } });
  await unlock(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toBe('rgb(21, 23, 31)'); // #15171F
});

test('the theme control is there, and it switches the palette', async ({ page, api }) => {
  await unlock(page);
  await page.locator('#menu-btn').click();
  await expect(page.locator('#app-menu')).toHaveClass(/on/);
  const item = page.locator('#theme-item');
  await expect(item).toBeVisible();
  await expect(item).toHaveText(/Theme:/);

  // Auto, then light, then dark: the label follows the palette it picked.
  await item.click();
  await item.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(item).toHaveText(/Theme: Dark/);
});

test('the shell uses the kitchen palette', async ({ page, api }) => {
  await unlock(page);
  const color = (sel, prop) => page.locator(sel).first().evaluate((el, p) => getComputedStyle(el)[p], prop);
  expect(await color('.sidebar', 'backgroundColor')).toBe('rgb(252, 234, 223)'); // peach #FCEADF
  expect(await color('#grid .card', 'backgroundColor')).toBe('rgb(246, 247, 244)'); // chalk
  expect(await color('.sidebar-logo', 'color')).toBe('rgb(185, 58, 8)'); // orange-text #B93A08
  // Edges are a low-opacity wash of ink, never a solid frame.
  expect(await color('#search-input', 'borderTopColor')).toBe('rgba(23, 32, 51, 0.12)');
});
