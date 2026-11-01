// Every PDF in the app goes through here: a page cap and a hard timeout, so a
// hostile or simply enormous file cannot hold a function open for 60 seconds.
// pdf-parse 1.1.1 bundles pdf.js 1.10.100 (2018), which is why the input needs
// bounding rather than trusting it.
import { Worker } from 'node:worker_threads';

export const MAX_PDF_PAGES = 10;
export const PDF_PARSE_TIMEOUT_MS = 20_000;
// A PDF whose bytes alone can stall the parser is refused before the read
// starts. 20 MB of PDF is a scanned book, not a recipe card.
export const MAX_PDF_BYTES = 20 * 1024 * 1024;

export class PdfUnreadable extends Error {
  constructor(message) {
    super(message);
    this.name = 'PdfUnreadable';
  }
}

const WORKER_URL = new URL('./pdf-worker.mjs', import.meta.url);

/**
 * Parses in a worker thread so a synchronous, hostile or simply enormous file
 * cannot block the request thread, and so the timeout can actually end it: a
 * Promise.race cannot interrupt CPU-bound work on the same thread, and used to
 * leave the timer unfired while the parse ran to completion anyway.
 */
function parseInWorker(buffer, { timeoutMs, maxPages }) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(WORKER_URL, {
        workerData: { buffer: new Uint8Array(buffer), maxPages },
        resourceLimits: { maxOldGenerationSizeMb: 256 },
      });
    } catch (error) {
      reject(error);
      return;
    }

    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      fn(value);
    };

    const timer = setTimeout(
      () => finish(reject, new PdfUnreadable('That PDF took too long to read. Try a smaller file.')),
      timeoutMs,
    );
    if (timer.unref) timer.unref();

    worker.once('message', (msg) => {
      // Always through finish(), so the worker is terminated and cannot keep
      // the process (or the function) alive after a successful read.
      if (msg && msg.ok) finish(resolve, String(msg.text || ''));
      else finish(reject, new PdfUnreadable(msg && msg.message ? msg.message : 'Unreadable PDF'));
    });
    worker.once('error', (error) => finish(reject, error));
    worker.once('exit', (code) => {
      if (code !== 0) finish(reject, new PdfUnreadable('The PDF reader stopped unexpectedly.'));
      else finish(resolve, '');
    });
  });
}

/**
 * Text of the first `maxPages` pages. Throws PdfUnreadable for a file that is
 * unreadable, empty, or slower than the timeout; anything else it throws is the
 * parser's own error and belongs to the caller's existing handling.
 */
export async function parsePdfText(buffer, opts = {}) {
  const timeoutMs = opts.timeoutMs || PDF_PARSE_TIMEOUT_MS;
  const maxPages = opts.maxPages || MAX_PDF_PAGES;

  if (buffer && buffer.length > MAX_PDF_BYTES) {
    throw new PdfUnreadable('That PDF is too large. Try one under 20 MB.');
  }

  let text;
  if (opts.parse) {
    // An injected parser is a test double and runs in process. It cannot be
    // interrupted, but it still has to be cut off so a stub that never resolves
    // cannot hang the caller.
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new PdfUnreadable('That PDF took too long to read. Try a smaller file.')),
        timeoutMs,
      );
      if (timer.unref) timer.unref();
    });
    try {
      const result = await Promise.race([opts.parse(buffer, { max: maxPages }), timeout]);
      text = String((result && result.text) || '').trim();
    } finally {
      clearTimeout(timer);
    }
  } else {
    text = String((await parseInWorker(buffer, { timeoutMs, maxPages })) || '').trim();
  }

  if (!text) throw new PdfUnreadable('No readable text in that PDF.');
  return text;
}
