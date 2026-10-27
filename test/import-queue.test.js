// Tests for the import-queue decision helpers in js/app.js.
//
// js/app.js is a classic script (no exports, touches `document` at load), so the
// pure helpers are extracted by name and evaluated in a vm context — the same
// harness the repo audit used. If a helper is renamed, this test fails loudly
// rather than silently testing nothing.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appSource = fs.readFileSync(path.join(here, '..', 'js', 'app.js'), 'utf8');

function loadHelpers(names) {
  const parts = names.map((name) => {
    const start = appSource.indexOf(`\nfunction ${name}(`);
    assert.ok(start >= 0, `js/app.js no longer defines ${name}()`);
    const end = appSource.indexOf('\n}\n', start);
    assert.ok(end > start, `could not find the end of ${name}()`);
    return appSource.slice(start + 1, end + 2);
  });
  const ctx = vm.createContext({});
  vm.runInContext(parts.join('\n'), ctx);
  return ctx;
}

const app = loadHelpers(['buildImportRequest', 'importOutcome', 'queueCountLabel']);

// ---------- buildImportRequest: which endpoint, which body ----------

test('buildImportRequest sends a PDF to /api/process-pdf as pdfBase64', () => {
  const item = { isPdf: true };
  const plan = app.buildImportRequest(item, 'Sam', 'JVBERi0xLjQ=', 'application/pdf');
  assert.equal(plan.path, '/api/process-pdf');
  assert.equal(plan.body.pdfBase64, 'JVBERi0xLjQ=');
  assert.equal(plan.body.addedBy, 'Sam');
  assert.equal(plan.body.imageBase64, undefined);
  assert.equal(plan.body.mimeType, undefined);
});

test('buildImportRequest sends an image to /api/process as imageBase64 + mimeType', () => {
  const item = { isPdf: false };
  const plan = app.buildImportRequest(item, 'Sam', '/9j/4AAQ', 'image/jpeg');
  assert.equal(plan.path, '/api/process');
  assert.equal(plan.body.imageBase64, '/9j/4AAQ');
  assert.equal(plan.body.mimeType, 'image/jpeg');
  assert.equal(plan.body.addedBy, 'Sam');
  assert.equal(plan.body.pdfBase64, undefined);
});

test('buildImportRequest passes skipDuplicateCheck only when the item opted in', () => {
  assert.equal(app.buildImportRequest({ isPdf: true }, 'Sam', 'x', 'application/pdf').body.skipDuplicateCheck, false);
  const flagged = app.buildImportRequest({ isPdf: true, skipDuplicateCheck: true }, 'Sam', 'x', 'application/pdf');
  assert.equal(flagged.body.skipDuplicateCheck, true);
  const flaggedImage = app.buildImportRequest({ isPdf: false, skipDuplicateCheck: true }, 'Sam', 'x', 'image/jpeg');
  assert.equal(flaggedImage.body.skipDuplicateCheck, true);
});

// ---------- importOutcome: response -> queue state ----------

test('importOutcome treats a 2xx as saved with the new recipe id and title', () => {
  const out = app.importOutcome(200, { id: 'r_1', title: 'Chicken Curry' });
  assert.deepEqual(out, { state: 'done', recipeId: 'r_1', title: 'Chicken Curry', message: '' });
});

test('importOutcome treats a 409 with a duplicate payload as "already in your chest", not a failure', () => {
  const out = app.importOutcome(409, {
    error: '"Chicken Curry" is already in your chest.',
    duplicate: { id: 'r_old', title: 'Chicken Curry' },
  });
  assert.equal(out.state, 'duplicate');
  assert.equal(out.recipeId, 'r_old');
  assert.equal(out.title, 'Chicken Curry');
  assert.equal(out.message, '"Chicken Curry" is already in your chest.');
});

test('importOutcome keeps the server message for a bad PDF (400) instead of a generic one', () => {
  const out = app.importOutcome(400, {
    error: 'That PDF has almost no readable text (it may be a scan). Copy the recipe text instead.',
  });
  assert.equal(out.state, 'failed');
  assert.match(out.message, /almost no readable text/);
  assert.match(app.importOutcome(413, { error: 'That PDF is too large (max 3 MB)' }).message, /too large/);
});

test('importOutcome fails safe on a 409 without a duplicate payload, and on a non-JSON body', () => {
  const noPayload = app.importOutcome(409, { error: 'Possible duplicate' });
  assert.equal(noPayload.state, 'failed');
  assert.equal(noPayload.message, 'Possible duplicate');

  const noBody = app.importOutcome(502, null);
  assert.equal(noBody.state, 'failed');
  assert.equal(noBody.message, 'Failed (HTTP 502)');

  const notObject = app.importOutcome(500, 'Internal Server Error');
  assert.equal(notObject.state, 'failed');
  assert.equal(notObject.message, 'Failed (HTTP 500)');
});

test('importOutcome never reports a duplicate as done, and never a failure as done', () => {
  assert.notEqual(app.importOutcome(409, { duplicate: { id: 'r_1' } }).state, 'done');
  assert.notEqual(app.importOutcome(400, {}).state, 'done');
  assert.equal(app.importOutcome(201, { id: 'r_1', title: 'X' }).state, 'done');
});

// ---------- queueCountLabel: it is not always "images" ----------

test('queueCountLabel names PDFs and images correctly', () => {
  const img = { isPdf: false };
  const pdf = { isPdf: true };
  assert.equal(app.queueCountLabel([img]), '1 image in queue');
  assert.equal(app.queueCountLabel([img, img]), '2 images in queue');
  assert.equal(app.queueCountLabel([pdf]), '1 PDF in queue');
  assert.equal(app.queueCountLabel([pdf, pdf, pdf]), '3 PDFs in queue');
  assert.equal(app.queueCountLabel([img, pdf]), '1 image + 1 PDF in queue');
  assert.equal(app.queueCountLabel([img, img, pdf, pdf]), '2 images + 2 PDFs in queue');
});
