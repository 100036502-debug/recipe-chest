/* eslint-disable no-undef -- the callbacks below run in the browser, not in Node. */
import { test, expect, unlock } from './helpers.js';

// The app is dark only. There is no light theme and no switch, so these check
// that nothing can turn one on, including a choice saved by an older version.

test('the app is dark, and a saved light or auto choice cannot change that', async ({ page, api }) => {
  await page.addInitScript(() => { try { localStorage.setItem('rc_theme', 'light'); } catch { /* blocked */ } });
  await unlock(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toBe('rgb(27, 22, 18)'); // #1B1612
});

test('there is no theme control for a person to find', async ({ page, api }) => {
  await unlock(page);
  await page.locator('#menu-btn').click();
  await expect(page.locator('#app-menu')).toHaveClass(/on/);
  await expect(page.locator('#theme-item')).toBeHidden();
  await expect(page.getByText(/Theme:/)).toBeHidden();
});

test('the sidebar, cards and inputs use the design colours', async ({ page, api }) => {
  await unlock(page);
  const color = (sel, prop) => page.locator(sel).first().evaluate((el, p) => getComputedStyle(el)[p], prop);
  expect(await color('.sidebar', 'backgroundColor')).toBe('rgb(20, 16, 13)');   // #14100D
  expect(await color('#grid .card', 'backgroundColor')).toBe('rgb(38, 32, 26)'); // #26201A
  expect(await color('.sidebar-logo', 'color')).toBe('rgb(240, 138, 75)');       // #F08A4B
  // Input edges are a low-opacity wash of the cream text colour now, not the
  // solid mid-brown, which read as a heavy frame on a dark surface.
  expect(await color('#search-input', 'borderTopColor')).toBe('rgba(243, 235, 221, 0.16)');
});
