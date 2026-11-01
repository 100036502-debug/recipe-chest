// Runs one PDF parse off the main thread. pdf.js 1.10 is synchronous and CPU
// bound, so on the request thread a hostile file blocks every other request for
// the whole read; here it can be terminated on timeout and its memory is
// released when the worker dies.
import { parentPort, workerData } from 'node:worker_threads';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

const buffer = Buffer.from(workerData.buffer);

try {
  const result = await pdfParse(buffer, { max: workerData.maxPages });
  parentPort.postMessage({
    ok: true,
    text: String((result && result.text) || ''),
    pages: Number(result && result.numpages) || 0,
  });
} catch (error) {
  parentPort.postMessage({ ok: false, message: (error && error.message) || 'Unreadable PDF' });
}
