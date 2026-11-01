import test from 'node:test';
import assert from 'node:assert';

import { parsePdfText, PdfUnreadable, MAX_PDF_BYTES } from '../lib/pdf-text.js';

// S10: a real parse runs in a worker thread, so a hostile file cannot block the
// request thread and the timeout can actually end it.

test('a PDF over the size cap is refused before anything is parsed', async () => {
  let parsed = false;
  const huge = Buffer.alloc(MAX_PDF_BYTES + 1);
  await assert.rejects(
    () => parsePdfText(huge, { parse: async () => { parsed = true; return { text: 'x' }; } }),
    (err) => err instanceof PdfUnreadable && /too large/.test(err.message),
  );
  assert.equal(parsed, false, 'the parser never saw it');
});

test('a real read happens in a worker and reports a bad file as unreadable', async () => {
  // No injected parser: this is the production path, in a worker thread.
  await assert.rejects(
    () => parsePdfText(Buffer.from('%PDF-1.4 garbage')), 
    (err) => err instanceof PdfUnreadable,
  );
});

test('the worker does not keep the process alive after a read', async () => {
  const started = Date.now();
  await assert.rejects(() => parsePdfText(Buffer.from('%PDF-1.4')), () => true);
  // If a worker were left running, the test process would hang here instead.
  assert.ok(Date.now() - started < 15_000);
});
