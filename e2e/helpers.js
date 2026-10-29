// Shared fixtures for the browser smoke tests.
//
// Two jobs:
//  1. Mock every /api call so the specs are deterministic and offline.
//  2. Fail any test whose browser console shows a Content-Security-Policy
//     violation or an uncaught page error. That is how a broken CSP or a
//     front-end exception gets caught here instead of in production.
import { test as base, expect } from '@playwright/test';

export const ACCESS_CODE = 'letmein';

// A real 1x1 JPEG, so the app's FileReader + canvas compression path runs.
export const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
  'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64'
);

// Smallest thing the client will accept as a PDF: it only checks the type and
// extension, then base64s the bytes.
export const TINY_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
  'utf8'
);

const PIXEL =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

// Two recipes: one with an image, one without, which is the pair the plan asks for.
export const SAMPLE_RECIPES = [
  {
    id: 'r1',
    title: 'Lemon Pasta',
    description: 'Bright and quick',
    tags: ['pasta', 'quick'],
    mealType: 'dinner',
    ingredients: ['spaghetti', 'lemon', 'parmesan'],
    addedBy: 'Sam',
    favorite: false,
    prepTime: '20 min',
    image: { url: PIXEL, thumb: PIXEL, photographer: 'Test' },
  },
  {
    id: 'r2',
    title: 'Bean Stew',
    description: 'Slow and cosy, no photo',
    tags: ['stew'],
    mealType: 'dinner',
    ingredients: ['beans', 'tomato'],
    addedBy: 'Sam',
    favorite: false,
  },
];

function json(route, status, body) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
    headers: { 'Cache-Control': 'no-store' },
  });
}

export const test = base.extend({
  // Lets a spec opt into throwing on purpose (the client-error reporter test)
  // without disabling the console guard for anything else.
  // eslint-disable-next-line no-empty-pattern -- Playwright's fixture signature
  allowErrors: async ({}, use) => {
    const allowed = { patterns: [] };
    await use(allowed);
  },

  // Auto-applied: collects CSP violations and uncaught exceptions, and fails
  // the test if any turned up. A CSP violation always fails; a page error fails
  // unless the spec explicitly allowed that message via allowErrors.
  consoleGuard: [
    async ({ page, allowErrors }, use) => {
      const problems = [];
      page.on('console', (msg) => {
        if (msg.type() !== 'error') return;
        const text = msg.text();
        if (/content security policy|refused to (load|execute|apply|connect)/i.test(text)) {
          problems.push({ fatal: true, text: 'CSP: ' + text });
        }
      });
      page.on('pageerror', (err) => problems.push({ fatal: false, text: 'Uncaught: ' + err.message }));
      await use(problems);
      const unexpected = problems.filter(
        (p) => p.fatal || !allowErrors.patterns.some((re) => re.test(p.text))
      );
      expect(unexpected.map((p) => p.text), 'the browser console must be clean').toEqual([]);
    },
    { auto: true },
  ],

  // The mock API. `state.requests` records every /api call the page made so
  // specs can assert on exact paths (the /api/api/process regression).
  api: async ({ page }, use) => {
    const state = {
      unlocked: false,
      failRecipesWith401: false,
      requests: [],
      recipes: JSON.parse(JSON.stringify(SAMPLE_RECIPES)),
    };

    let seq = 0;
    const addRecipe = (title) => {
      seq += 1;
      const recipe = {
        id: 'new-' + seq,
        title,
        description: 'Added during a test',
        tags: [],
        mealType: 'dinner',
        ingredients: [],
        addedBy: 'Test',
        favorite: false,
      };
      state.recipes.unshift(recipe);
      return recipe;
    };

    await page.route('**/api/**', async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const method = request.method();
      state.requests.push({ method, path, url: request.url(), body: request.postData() });

      // Session check
      if (path === '/api/verify-code') {
        if (method === 'GET') return json(route, 200, { unlocked: state.unlocked });
        if (method === 'DELETE') {
          state.unlocked = false;
          return json(route, 200, { unlocked: false });
        }
        let code = '';
        try { code = JSON.parse(request.postData() || '{}').code || ''; } catch { /* ignore */ }
        if (code === ACCESS_CODE) {
          state.unlocked = true;
          return json(route, 200, { unlocked: true });
        }
        return json(route, 401, { unlocked: false, error: 'Incorrect access code.' });
      }

      if (path === '/api/recipes') {
        if (state.failRecipesWith401 || !state.unlocked) return json(route, 401, { error: 'Unauthorized' });

        // PATCH merges the body and returns the single updated recipe.
        if (method === 'PATCH') {
          let patch = {};
          try { patch = JSON.parse(request.postData() || '{}') || {}; } catch { patch = {}; }
          const idx = state.recipes.findIndex((r) => r.id === patch.id);
          if (idx === -1) return json(route, 404, { error: 'Not found' });
          state.recipes[idx] = { ...state.recipes[idx], ...patch };
          return json(route, 200, state.recipes[idx]);
        }

        return json(route, 200, state.recipes);
      }

      if (!state.unlocked) return json(route, 401, { error: 'Unauthorized' });

      // Collections rename/delete across the mock recipes.
      if (path === '/api/collections' && method === 'POST') {
        let body = {};
        try { body = JSON.parse(request.postData() || '{}') || {}; } catch { body = {}; }
        let changed = 0;
        state.recipes.forEach((r) => {
          const before = Array.isArray(r.collections) ? r.collections : [];
          const next = body.rename
            ? before.map((c) => (c.toLowerCase() === String(body.rename.from).toLowerCase() ? body.rename.to : c))
            : before.filter((c) => c.toLowerCase() !== String(body.delete || '').toLowerCase());
          if (JSON.stringify(next) !== JSON.stringify(before)) { r.collections = next; changed += 1; }
        });
        return json(route, 200, { changed });
      }

      if (path === '/api/process-pdf' && method === 'POST') {
        const recipe = addRecipe('Imported PDF Recipe');
        return json(route, 200, { id: recipe.id, title: recipe.title });
      }
      if (path === '/api/process' && method === 'POST') {
        const recipe = addRecipe('Imported Photo Recipe');
        return json(route, 200, { id: recipe.id, title: recipe.title });
      }
      if (path === '/api/import-url' && method === 'POST') {
        const recipe = addRecipe('Imported Web Recipe');
        return json(route, 200, { id: recipe.id, title: recipe.title });
      }
      if (path === '/api/photo' && method === 'POST') {
        return json(route, 200, { ok: true, userPhoto: { updatedAt: Date.now(), credit: '' } });
      }

      // Shopping list and meal plan, per device id (or the shared one)
      if (path === '/api/shopping-list' || path === '/api/meal-plan') {
        state.lists = state.lists || {};
        let body;
        try { body = JSON.parse(request.postData() || '{}') || {}; } catch { body = {}; }
        if (!state.unlocked) return json(route, 401, { error: 'Unauthorized' });
        const url = new URL(request.url());
        const deviceId = url.searchParams.get('deviceId') || body.deviceId || '';
        const key = path + ':' + deviceId;

        if (method === 'DELETE') {
          delete state.lists[key];
          return json(route, 200, { success: true });
        }
        if (method === 'POST') {
          const stored = state.lists[key];
          if (body.baseUpdatedAt != null && stored && stored.updatedAt > body.baseUpdatedAt) {
            return json(route, 409, { error: 'conflict', current: stored });
          }
          const payload = path === '/api/meal-plan'
            ? { ...body, updatedAt: Date.now() }
            : { items: Array.isArray(body.items) ? body.items : [], updatedAt: Date.now() };
          state.lists[key] = payload;
          return json(route, 200, payload);
        }
        return json(route, 200, state.lists[key] || (path === '/api/meal-plan' ? {} : { items: [], updatedAt: null }));
      }

      return json(route, 404, { error: 'No mock for ' + method + ' ' + path });
    });

    await use(state);
  },
});

export { expect };

// Unlock helper shared by the specs that start inside the app.
export async function unlock(page) {
  await page.goto('/');
  await expect(page.locator('#lock-screen')).toBeVisible();
  await page.fill('#lock-input', ACCESS_CODE);
  await page.getByRole('button', { name: 'Enter', exact: true }).click();
  await expect(page.locator('#app-content')).toBeVisible();
}

// Every recorded call to one path.
export function callsTo(state, path) {
  return state.requests.filter((r) => r.path === path);
}

// Calls to one path with a specific method. Needed because /api/photo is also
// fetched by GET for thumbnails, so counting the path alone over-counts.
export function postsTo(state, path) {
  return state.requests.filter((r) => r.path === path && r.method === 'POST');
}
