import test from 'node:test';
import assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

test('the cookpot icon exists as SVG and as a PNG fallback', () => {
  assert.ok(existsSync(join(root, 'favicon.svg')), 'favicon.svg is missing');

  const svg = read('favicon.svg');
  assert.match(svg, /<svg[^>]+viewBox="0 0 64 64"/);
  assert.match(svg, /#5A3A22/i, 'pot body uses the app brown');
  assert.equal(/<script|onload=|javascript:/i.test(svg), false, 'an icon is never executable');

  const png = readFileSync(join(root, 'icons/favicon-32.png'));
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'not a PNG');
});

test('every page points at it', () => {
  for (const page of ['index.html', 'share.html', 'offline.html']) {
    const html = read(page);
    assert.match(html, /<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml">/, `${page} has no SVG icon`);
    assert.match(html, /<link rel="icon" href="\/icons\/favicon-32\.png"/, `${page} has no PNG fallback`);
  }
});

test('the icon is served from our own origin, which the CSP allows', () => {
  const vercel = JSON.parse(read('vercel.json'));
  const csp = vercel.headers
    .flatMap((h) => h.headers)
    .find((h) => h.key === 'Content-Security-Policy').value;
  const imgSrc = csp.split(';').map((part) => part.trim()).find((part) => part.startsWith('img-src'));
  assert.match(imgSrc, /'self'/, 'img-src must allow same-origin icons');
});
