// Every PDF in the app goes through here: a page cap and a hard timeout, so a
// hostile or simply enormous file cannot hold a function open for 60 seconds.
// pdf-parse 1.1.1 bundles pdf.js 1.10.100 (2018), which is why the input needs
// bounding rather than trusting it.
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

export const MAX_PDF_PAGES = 10;
export const PDF_PARSE_TIMEOUT_MS = 20_000;

export class PdfUnreadable extends Error {
  constructor(message) {
    super(message);
    this.name = 'PdfUnreadable';
  }
}

/**
 * Text of the first `maxPages` pages. Throws PdfUnreadable for a file that is
 * unreadable, empty, or slower than the timeout; anything else it throws is the
 * parser's own error and belongs to the caller's existing handling.
 */
export async function parsePdfText(buffer, opts = {}) {
  const parse = opts.parse || pdfParse;
  const timeoutMs = opts.timeoutMs || PDF_PARSE_TIMEOUT_MS;
  const maxPages = opts.maxPages || MAX_PDF_PAGES;

  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new PdfUnreadable('That PDF took too long to read. Try a smaller file.')),
      timeoutMs,
    );
    if (timer.unref) timer.unref();
  });

  try {
    const result = await Promise.race([parse(buffer, { max: maxPages }), timeout]);
    const text = String((result && result.text) || '').trim();
    if (!text) throw new PdfUnreadable('No readable text in that PDF.');
    return text;
  } finally {
    clearTimeout(timer);
  }
}
