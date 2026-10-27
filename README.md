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

## Development

The app is a single page: `index.html` (markup) plus `css/app.css` (all styles) and `js/app.js` (the whole app script, a classic non-module script so the inline `onclick` handlers keep working).

```bash
npm install
npm test        # unit tests (node --test, no extra dependencies)
npm run lint    # ESLint: run before every deploy (catches undefined variables)
```

Tests cover the tag/meal-type/title normalizers, the private-IP guard used by
URL imports, the tolerant AI-output parser and the JSON-LD recipe mapper.
