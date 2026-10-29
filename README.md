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
- Cook mode: sticky timers read out of each step, tappable ingredients and steps,
  and a font size that sticks.
- Collections, a cooking log with 1-5 star ratings, and a pantry matcher that
  ranks the recipes you can actually cook right now.
- Shopping list with aisle grouping, quantity merging and a shared household list.
- AI tools: nine one-tap transformations with per-IP and daily limits, and a
  60-second undo.
- Read-only share links that can be revoked, and a separate guest code for
  view-only access.
- Dark mode, skeleton loading cards, printable 4x6 cards, and install to the
  home screen on Android and iOS.

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
| `BACKUP_SECRET` | no | Bearer secret for the weekly Drive backup. |
| `GUEST_CODE` | no | Second code that unlocks read-only guest access. |
| `PUBLIC_BASE_URL` | no | Public origin used in emails and share links. |
| `AI_DAILY_LIMIT` | no | Daily cap on AI tool calls across all users (default 100). |
| `STORAGE_CAP_MB` | no | Your Upstash plan size, so the storage panel can show a percentage. |

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

## Architecture

- `index.html`, `css/app.css`, `js/app.js`: one static page. `js/utils.js` and
  `js/share.js` are small shared scripts that load first.
- `api/`: 12 Vercel functions, the Hobby plan maximum. `api/extras.js` is a
  dispatcher: `?action=<name>` lazy-loads `lib/actions/<name>.js`.
- `lib/`: the logic the functions and the unit tests share (auth, recipes, kv,
  ai, mail).
- `vercel.json`: rewrites every `/api/<name>` to the dispatcher, plus headers,
  the Content-Security-Policy and the no-store rule.

## Testing

```bash
npm test          # unit tests: node --test, no dependencies, no network
npm run lint      # ESLint over api, lib, test, js and sw.js
npm run test:e2e  # Playwright browser specs (see below)
```

All three must be green before a pull request. `npm test` has to pass on a clean
checkout with no `.env`: nothing in the suite reads a real key.

## Guest access

Set `GUEST_CODE` to enable a read-only view. It issues the same signed cookie
with `role: guest`, and every write route answers 403 for that role, except the
shopping list and meal plan, which stay writable so a guest can still add to the
list. The client hides the write buttons as a convenience; the server enforces
the rule.

## Share links

**Share link** in a recipe's action row mints a token and gives you `/s/<token>`.
That page is a separate static document: it shows only whitelisted fields
(title, times, ingredients, steps, notes, source), sends `noindex`, and never
loads the app script. Tokens live in Redis under `share:<token>`; **Revoke link**
deletes the key and the URL starts returning 404 immediately.

## AI tools and limits

Nine transformations (scale, simplify, convert units, summarise, substitute, and
more) go through `/api/ai-tool`. Limits: 20 requests per hour per IP and
`AI_DAILY_LIMIT` (default 100) per day overall, counted in Redis. Output is
sanitised and applied as a replacement that can be undone for 60 seconds. No
prompt or result is stored server-side; the undo snapshot lives in the browser.

## Share target on Android, and iOS

An installed Android app shares into the import dialog through the manifest's
Web Share Target. iOS has no share target: copy the link into **Import from URL**.
The iOS install hint in the app walks through Share, then Add to Home Screen.

## Troubleshooting

- **"No more than 12 Serverless Functions"** on deploy: a new file appeared in
  `api/`. Move the logic to `lib/actions/` and register it in `api/extras.js`.
- **401 everywhere after unlocking**: `SESSION_SECRET` changed or is missing, so
  the old cookie no longer verifies. Unlock again.
- **403 on a write**: you are a guest session. Unlock with the owner code to edit.
- **No photos, or Unsplash 403**: the demo key is limited to about 50 requests an
  hour. Wait, or apply for production access.
- **Storage panel warns about the cap**: Redis is near `STORAGE_CAP_MB`. The
  photos are the bulk of it; delete the ones you do not need.
- **A share link returns 404**: it was revoked.

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

## Adding an endpoint

Vercel's Hobby plan allows **12 functions** and `api/` already has 12, so new
endpoints must not add files there. They are added as actions instead:

1. Create `lib/actions/<name>.js` exporting both forms:

   ```js
   export function createHandler({ kv }) {
     return async function handler(req, res) { /* auth, method check, work */ };
   }
   export default function handler(req, res) {
     return createHandler({ kv: getKv() })(req, res);
   }
   ```

   The action does its own `requireAuth` and method checks. Taking `kv` as an
   argument is what makes it testable against `test/helpers/fake-kv.js`.

2. Register it in the `ACTIONS` map in `api/extras.js`, with a **literal**
   `import()` path so Vercel bundles the file:

   ```js
   'health': () => import('../lib/actions/health.js'),
   ```

3. Keep the public URL clean with a rewrite in `vercel.json`:

   ```json
   { "source": "/api/health", "destination": "/api/extras?action=health" }
   ```

   Query strings from the browser pass through rewrites unchanged.

4. Give it a no-store header: the rule in `vercel.json` is
   `/api/((?!photo|share-photo).*)`, so anything cacheable has to be added to
   that exclusion list.

Run `ls api/*.js | wc -l` before committing; it must stay at 12. `api/extras.js`
is the single shared slot every new endpoint uses.

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

## Automatic weekly backups

Your recipes should not live in one database. `apps-script/Backup.gs` runs a
weekly job that copies everything to Google Drive.

It runs in the same Apps Script project as `Code.gs` (which it does not touch).
You run one setup function and approve Drive and Mail access once:

1. In the Apps Script editor, add these script properties:
   `BACKUP_API_URL` (the full `https://<your-app>/api/export`),
   `BACKUP_SECRET` (the same long random string as the app's `BACKUP_SECRET`),
   and optionally `BACKUP_FOLDER_NAME`, `BACKUP_KEEP_WEEKS` (default 8) and
   `BACKUP_NOTIFY_EMAIL` (default: your own address).
2. Run `installWeeklyBackupTrigger()` once. It schedules `weeklyBackup` for every
   Sunday at 03:00 in the script's time zone, replacing any earlier trigger.
3. Run `weeklyBackup()` by hand once to confirm the folder and files appear.

Each run writes a dated folder containing `recipe-chest-backup-<date>.json` and
`recipe-chest-photos-<n>.json`. Those are deliberately the same file names the
app's Export button produces, so Restore can read them directly. Folders older
than `BACKUP_KEEP_WEEKS` are moved to the Drive trash. You get one email per run,
success or failure, and a failure is raised again in the editor rather than
swallowed.

The backup authenticates with `Authorization: Bearer <BACKUP_SECRET>`, so the
export route has to accept it: set the same string in the app's environment.
Leaving `BACKUP_SECRET` empty disables that path entirely, and the route falls
back to a normal member session.

### Restoring a backup

Use the app's Restore button and load the recipes file **first**, then the photo
files. Restoring never overwrites a recipe that already exists: anything already
in the chest is left alone, so a restore is safe to run twice, and it can be used
to bring back a single recipe by restoring a whole backup and deleting the rest.

## Storage panel

The app menu has a **Storage** entry showing how much of your Redis quota the
chest is using: total size, photo count and recipe count, plus a progress bar
when a cap is known. Set `STORAGE_CAP_MB` to your Upstash plan's storage limit to
get the percentage; leave it unset and you get the raw numbers only.

Measuring photo bytes means one command per photo and per thumbnail, so the
result is cached for ten minutes. **Measure again** bypasses the cache. At 80% a
banner appears above the grid suggesting you export a backup and delete photos
you no longer need; dismissing it keeps it away for seven days.

## Printing and PDF

**Print** prints the recipe as it looks on screen. **Print card** prints a compact
4 x 6 inch index card: title and times at the top, ingredients and steps in two
columns, no photos and no buttons.

To keep a recipe, choose *Save as PDF* as the destination in the browser's print
dialog. That works for both buttons, on desktop and on iOS and Android.
