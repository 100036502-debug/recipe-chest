import { test, expect, unlock, callsTo } from './helpers.js';

// The reporter is the riskiest part of task 4: it runs inside the page, uses
// sendBeacon and must survive its own failures. This is the browser half of
// the plan's check (the server half is covered in test/observability.test.js).
test.describe('client error reporting', () => {
  test('an uncaught error is posted to /api/client-error', async ({ page, api, allowErrors }) => {
    allowErrors.patterns.push(/deliberate test error/);
    await unlock(page);

    await page.evaluate(() => setTimeout(() => { throw new Error('deliberate test error'); }, 0));

    await expect.poll(() => callsTo(api, '/api/client-error').length, {
      message: 'the browser should report the crash',
    }).toBe(1);

    const report = callsTo(api, '/api/client-error')[0];
    const body = JSON.parse(report.body || '{}');
    expect(body.message).toContain('deliberate test error');
    expect(body.url).toContain('localhost');
  });

  test('an unhandled rejection is reported too', async ({ page, api, allowErrors }) => {
    allowErrors.patterns.push(/deliberate rejection/);
    await unlock(page);

    await page.evaluate(() => { Promise.reject(new Error('deliberate rejection')); });

    await expect.poll(() => callsTo(api, '/api/client-error').length).toBe(1);
    const body = JSON.parse(callsTo(api, '/api/client-error')[0].body || '{}');
    expect(body.message).toContain('deliberate rejection');
  });

  test('nothing is reported while the lock screen is showing', async ({ page, api, allowErrors }) => {
    allowErrors.patterns.push(/deliberate locked error/);
    await page.goto('/');
    await expect(page.locator('#lock-screen')).toBeVisible();

    await page.evaluate(() => setTimeout(() => { throw new Error('deliberate locked error'); }, 0));
    await page.waitForTimeout(400);

    expect(callsTo(api, '/api/client-error'), 'a locked page must stay silent').toHaveLength(0);
  });

  test('at most 5 reports go out per page load', async ({ page, api, allowErrors }) => {
    allowErrors.patterns.push(/deliberate burst/);
    await unlock(page);

    await page.evaluate(() => {
      for (let i = 0; i < 12; i++) setTimeout(() => { throw new Error('deliberate burst ' + i); }, 0);
    });
    await page.waitForTimeout(1200);

    const reports = callsTo(api, '/api/client-error');
    expect(reports.length).toBeGreaterThan(0);
    expect(reports.length).toBeLessThanOrEqual(5);
  });
});
