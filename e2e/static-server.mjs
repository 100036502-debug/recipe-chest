// A tiny static file server for the browser tests.
//
// It serves the repo root the way Vercel does and, importantly, applies the
// SAME security headers that vercel.json sets for source "/(.*)". They are read
// from vercel.json at startup so the two can never drift: if the real CSP gets
// stricter, a test that violates it fails here too.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 4173);

// Pull the "/(.*)" headers out of vercel.json.
function securityHeaders() {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
    const catchAll = (config.headers || []).find((h) => h.source === '/(.*)');
    const out = {};
    for (const { key, value } of (catchAll && catchAll.headers) || []) out[key] = value;
    return out;
  } catch {
    return {};
  }
}

const BASE_HEADERS = securityHeaders();

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function send(res, status, body, type, extra = {}) {
  res.writeHead(status, { ...BASE_HEADERS, ...(type ? { 'Content-Type': type } : {}), ...extra });
  res.end(body);
}

// Resolve a URL path to a file inside ROOT, refusing anything that escapes it.
function resolve(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  const rel = clean === '/' ? 'index.html' : clean.replace(/^\/+/, '');
  const full = path.resolve(ROOT, rel);
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) return null;
  return full;
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'Method not allowed', 'text/plain; charset=utf-8');
  }

  const urlPath = req.url || '/';

  // TODO(task 14): serve share.html for /s/<anything> once read-only share
  // links exist. Until then these paths are not part of the app.
  if (urlPath.startsWith('/s/')) {
    return send(res, 404, 'Share pages do not exist yet', 'text/plain; charset=utf-8');
  }

  const file = resolve(urlPath);
  if (!file) return send(res, 403, 'Forbidden', 'text/plain; charset=utf-8');

  fs.readFile(file, (err, data) => {
    if (err) {
      // Unknown paths fall back to nothing: this server has no SPA rewrite.
      return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    }
    const ext = path.extname(file).toLowerCase();
    let type = TYPES[ext] || 'application/octet-stream';
    const extra = {};
    // Match the header overrides vercel.json declares for these two files.
    if (path.basename(file) === 'manifest.json') {
      type = 'application/manifest+json';
      extra['Cache-Control'] = 'public, max-age=3600';
    }
    if (path.basename(file) === 'sw.js') {
      extra['Cache-Control'] = 'public, max-age=0, must-revalidate';
      extra['Service-Worker-Allowed'] = '/';
    }
    send(res, 200, req.method === 'HEAD' ? '' : data, type, extra);
  });
});

server.listen(PORT, () => {
  console.log(`static test server on http://localhost:${PORT} (root: ${ROOT})`);
  if (!BASE_HEADERS['Content-Security-Policy']) {
    console.log('WARNING: no Content-Security-Policy found in vercel.json');
  }
});
