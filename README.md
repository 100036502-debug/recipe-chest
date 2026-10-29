# Recipe Chest

A private recipe box: photograph recipes (or send them by email, import from a URL,
or upload PDFs) and an AI files them into your chest with ingredients, steps, tags,
a meal type and a stock photo. Recipes live in Upstash Redis; the app deploys to
Vercel as serverless functions plus a single static page (a PWA that works offline
with your last saved recipes).

## Features

- Photo import: drop images, the vision model extracts the recipe (duplicates are detected).
- PDF import: upload recipe PDFs (max 3 MB) or email them in.
- URL import: reads schema.org JSON-LD first, falls back to the AI.
- Gmail import: send an email with the import label; the recipe lands in the chest and
  you get a confirmation reply (see "Apps Script setup").
- User photos of the finished dish with optional credit, cook mode, shopping list,
  meal plan, favorites, sorting and filters, offline caching and JSON backups.

## Setup

1. **Deploy to Vercel** (import the repo at [vercel.com](https://vercel.com), or run `vercel`).
2. **Configure the environment variables** below (Project → Settings → Environment Variables).
3. Open the site, unlock with the access code, and you are in.

### Environment variables (Vercel)

| Variable | Required | Notes |
| --- | --- | --- |
| `ACCESS_CODE` | yes | The unlock code for the app. |
| `SESSION_SECRET` | yes | Random string; signs the session cookie. |
| `GROQ_API_KEY` | yes | Key from [console.groq.com](https://console.groq.com). |
| `GROQ_MODEL` | no | Text model. Defaults to `qwen/qwen3.8-27b` (vision-capable reasoning model; reasoning is disabled per request). |
| `GROQ_VISION_MODEL` | no | Model for image imports. Defaults to `GROQ_MODEL`. |
| `UNSPLASH_ACCESS_KEY` | yes | Key from [unsplash.com/developers](https://unsplash.com/developers). |
| `EMAIL_IMPORT_SECRET` | no | Bearer secret the Gmail import uses; required for email import. |
| `UPSTASH_REDIS_REST_URL` | yes | Also accepts `KV_REST_API_URL`. |
| `UPSTASH_REDIS_REST_TOKEN` | yes | Also accepts `KV_REST_API_TOKEN`. |

All variables are listed with empty values in [`.env.example`](.env.example).

> **Unsplash demo mode:** without production approval you are limited to ~50 requests/hour.
> Serious use needs Unsplash production access. Photos are always hotlinked from
> `images.unsplash.com` with photographer credit, per the API guidelines.

### Limits to keep in mind

- Vercel caps request bodies at ~4.5 MB regardless of any route `sizeLimit`, and
  functions run at most 60 s. That is why PDF uploads and Gmail attachments are
  capped at 3 MB.
- The login code is throttled to 10 attempts per 15 minutes per IP; the import
  endpoints are rate-limited per IP per hour.

## Backup and restore

Use the `⋯` menu next to your name in the header.

- **Export backup** downloads one JSON file with every recipe (no photos).
- **Export with photos** downloads the recipes file first, then one
  `recipe-chest-photos-<date>-part<N>.json` file per photo slice, so no single
  response hits Vercel's ~4.5 MB limit. Keep the parts.
- **Restore backup** opens a file picker (multiple files allowed, each under
  3.5 MB). Select your backup files — recipes first, photo parts after (each file may be up to 3.75 MB);
  order in the picker does not matter. Recipes whose ids already exist are
  skipped, never overwritten; restoring the same files twice reports
  everything as skipped.

## Apps Script (Gmail import) setup

1. Create a Google Apps Script project (script.google.com) and paste
   `apps-script/Code.gs`.
2. Set the script properties (Project Settings → Script Properties):
   - `RECIPE_IMPORT_API_URL` — your deployed `/api/import-email` URL.
   - `RECIPE_IMPORT_SECRET` — must equal the `EMAIL_IMPORT_SECRET` above.
3. Run `installRecipeImportTrigger()` once from the editor (approve the
   permissions). This checks for new mail every 5 minutes.
4. Gmail: label an email with the label **`recipe-import`** (create it once) —
   the script picks up unread emails there, sends text, PDFs and images to the
   API, and replies with what was saved. Failed imports get the label
   **`recipe-import-failed`** instead of retrying forever.

## Redis data format

Do not rename these keys casually; the app relies on them:

- `recipe:<id>` — one recipe object
- `recipe_ids` — list of all recipe ids
- `photo:<id>`, `photothumb:<id>` — a user's dish photo (base64 JPEG)
- `email_import:<messageId>` — idempotency markers (30-day TTL)
- `rl:<name>:<ip>` — rate-limit counters (1-hour TTL)
- `shopping_list:<deviceId>`, `meal_plan:<deviceId>` — per-device lists
- `trash:<id>` — a copy of a recipe (`{recipe, photo?, photothumb?, deletedAt}`)
  written just before it is deleted, so the Undo in the toast can put it back
  with the same id. 10-minute TTL, after which it expires on its own; there is
  no trash screen and no other endpoint reads it

## Requirements

Node **24.x** (set in `package.json` engines). URL imports use the npm
`undici` package for its connection-level DNS guard, which requires Node 22.19
or newer; the repo targets 24.x. On Vercel, confirm
Project Settings > General > Node.js Version is set to 24.x.

## Development

The app is a single page: `index.html` (markup) plus `css/app.css` (all styles) and `js/app.js` (the whole app script, a classic non-module script so the inline `onclick` handlers keep working).

```bash
npm install
npm test        # unit tests (node --test, no extra dependencies)
npm run lint    # ESLint: run before every deploy (catches undefined variables)
```

Tests cover the tag/meal-type/title normalizers, the private-IP guard used by
URL imports, the tolerant AI-output parser and the JSON-LD recipe mapper.

## Continuous integration

Every push to `main` and every pull request runs the **CI** workflow in
`.github/workflows/ci.yml`:

1. `npm ci` — installs from the lockfile, so CI matches production.
2. `npm run lint` — ESLint over `api/`, `lib/`, `test/`, `js/` and `sw.js`.
3. `npm test` — the `node --test` suite.

A red check means do not merge. The workflow needs no secrets: it only runs the
offline unit tests, so it works on forks and pull requests too.

The workflow also holds a commented-out `e2e` job for the Playwright browser
smoke tests, which is enabled once those specs exist.

### Browser smoke tests

The **Browser smoke tests** job runs Playwright against the real front end to
catch wiring bugs that unit tests cannot see, such as the doubled
`/api/api/process` prefix that silently broke every photo import.

```bash
npx playwright install chromium   # once
npm run test:e2e                  # headless, about 15 seconds
```

How it works, in `e2e/`:

- `static-server.mjs` serves the repo root on port 4173 the way Vercel does.
  It reads the `/(.*)` headers straight out of `vercel.json`, so the real
  Content-Security-Policy is applied and a CSP violation fails the test.
- `helpers.js` mocks every `/api/**` call (`page.route`), so the specs need no
  database, no API keys and no network. It also records each request so specs
  can assert on the exact path, and fails any test whose console shows a CSP
  violation or an uncaught page error.
- Specs: `unlock`, `import-photos` (image and PDF), `import-url`, `my-photo`
  and `session-expired`.

`npm test` stays `node --test` and ignores `e2e/`: the specs are named
`*.spec.js` and live outside `test/`, so the two suites never collide.

**Branch protection (owner step).** In GitHub, open Settings > Branches and add
a rule for `main` that requires the `CI / Lint and unit tests` check to pass
before merging. That is what makes the check a real gate rather than a
decoration; without it, a red run can still be merged.
