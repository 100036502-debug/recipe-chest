# Final regression report

Run date: 29 October 2026. Baseline commit `1fd7c23` (after the task 25 merge).

## Automated

| Check | Result |
| --- | --- |
| `npm ci && npm run lint` | pass, 0 errors (11 warnings, all `no-unused-vars` on purpose) |
| `npm test` | 246 unit tests pass, 0 fail |
| `npm run test:e2e` | 56 specs in 21 files pass in CI (Chromium, mocked API, real CSP) |
| CI on `main` | green |
| `ls api/*.js \| wc -l` | 12, at the Hobby limit |
| axe (`e2e/a11y.spec.js`) | 0 serious or critical violations on grid, detail, cook mode, shopping list and share page, light and dark |

### What the accessibility pass found, and the fixes

The smoke test first ran red on every surface, which was the point of adding it.

- **`nested-interactive`** on each card: the card was a `role="button"` with the
  favourite button inside it. The card is now a plain container and the title is
  a real `<button class="card-title-btn">`, so keyboard users still reach it and
  nothing is nested.
- **`label-content-name-mismatch`** on the same cards, then on the cook mode
  text-size buttons: the accessible name did not contain the visible text.
  Cards now name themselves from their title; the buttons are labelled
  "A− smaller text" and "A+ larger text".
- **`color-contrast`** on the share page credit link: an unstyled link fell back
  to browser blue, unreadable in dark mode. Links with no rule of their own now
  use `--primary-d` (5.75:1 on the light background, high contrast in dark).
- The rest of the contrast reports were false: the palette transitions over
  0.25 s and axe measures rendered colours, so it was reading the fade
  halfway through. The spec now disables transitions before scanning, and its
  failure message names the element, its colours and the ratio.

## Manual checks (owner, on a Vercel preview and a real phone)

These need a deployed preview, a phone and the Apps Script project, so they
cannot be run from the agent sandbox. Each one is scripted below so it takes
minutes rather than an afternoon.

1. **Auth**: member login, Lock button, expired session message (the app returns
   to the lock screen with "Your session expired"). Guest code: read-only, and
   `fetch('/api/recipes', {method:'PATCH'})` from the console answers 403.
2. **Imports**: one photo; 2-3 photos as one recipe; PDF; a JSON-LD site and a
   plain blog; paste text; a duplicate import with "Save a copy"; Gmail import
   with text, PDF and photo, an empty email, and a 5 MB PDF (should be refused
   with a clear message, not a 500).
3. **Detail**: own photo add, replace, remove; collections; cooked log with a
   rating; share link create, open in a private window, revoke; each AI tool;
   nothing is saved until Save or Replace; Undo after Replace; Print and Print
   card.
4. **Cook mode**: two timers at once; lock the phone 30 s and confirm both
   survive; the finish alert (sound, and vibration on Android); checklist
   persistence across a reload; the three text sizes.
5. **Shopping list**: aisle grouping, duplicate merge, the shared list on two
   devices, the polling update, and the 409 conflict message.
6. **What can I make**: pantry chips, the basics checkbox, ranking sanity, and
   "add missing" landing in the list.
7. **Backup**: Export with photos, then Restore; run `weeklyBackup()` and check
   the Drive folder; compare the storage panel with Upstash.
8. **Broad sweep**: dark mode, skeleton cards, install on Android Chrome, the
   iOS hint, offline, the back button closing modals, no console or CSP errors,
   no unexpected 500s in the Vercel logs, `/api/health` returns ok.
9. **Unsplash**: importing the same dish twice should search once and still show
   the credit.

## Plan status

All 25 tasks are merged on `main`, one branch and one pull request each:
PRs #6 to #32, with the CI gate green on every merge. Tasks 23 to 25 closed out
this run: the printable 4x6 card, the documentation and config pass, and the
regression above.
