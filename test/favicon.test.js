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

// ---- the app icon (manifest + home screen) --------------------------------

function pngSize(path) {
  const buf = readFileSync(join(root, path));
  // IHDR is the first chunk: 8 byte signature, 4 length, 4 type, then w/h.
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

test('every manifest icon exists at the size it claims', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.ok(manifest.icons.length >= 4);

  for (const icon of manifest.icons) {
    const path = icon.src.replace(/^\//, '');
    assert.ok(existsSync(join(root, path)), `${icon.src} is missing`);
    const [w, h] = icon.sizes.split('x').map(Number);
    assert.deepEqual(pngSize(path), { width: w, height: h }, `${path} is not ${icon.sizes}`);
    assert.equal(icon.type, 'image/png');
  }

  const purposes = manifest.icons.map((i) => i.purpose);
  assert.ok(purposes.includes('any') && purposes.includes('maskable'), 'both purposes are needed');
});

test('the maskable icon is its own full-bleed artwork, not the tab tile reused', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const any = manifest.icons.filter((i) => i.purpose === 'any').map((i) => i.src);
  const maskable = manifest.icons.filter((i) => i.purpose === 'maskable').map((i) => i.src);
  assert.equal(maskable.some((src) => any.includes(src)), false, 'a masked launch would clip the tile');

  const svg = read('icons/icon-maskable.svg');
  assert.match(svg, /<rect width="64" height="64" fill="#FAF6F0"\/>/, 'the background must be full bleed');
  assert.equal(/rx="14"/.test(svg), false, 'a maskable icon must not carry its own rounded corners');
  assert.match(svg, /scale\(0\.74\)/, 'the pot sits inside the central safe zone');
});

test('the apple touch icon is the pot, at 180x180', () => {
  const html = read('index.html');
  assert.match(html, /rel="apple-touch-icon" href="\/icons\/apple-touch-icon\.png"/);
  assert.deepEqual(pngSize('icons/apple-touch-icon.png'), { width: 180, height: 180 });
});
