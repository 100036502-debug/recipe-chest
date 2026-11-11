// Guards for the phone chrome: the hamburger drawer must be able to slide in,
// and the bottom-nav "+" must ask how to add instead of assuming photos.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(here, '..', p), 'utf8');
const html = read('index.html');
const app = read('js/app.js');
const uiCss = read('css/ui.css');
const tonightCss = read('css/tonight.css');

test('the drawer is not display:none on phones (it slides in via transform)', () => {
  // tonight.css shows the drawer with body.drawer-open .sidebar { transform: none }
  assert.ok(/body\.drawer-open \.sidebar/.test(tonightCss), 'drawer-open rule missing');
  // display:none on .sidebar beats transform/visibility and kills the drawer.
  // The print stylesheet's !important rule is fine; a phone-width one is not.
  const hidesSidebar = [...uiCss.matchAll(/\.sidebar\s*\{([^}]*)\}/g)]
    .some((m) => /display:\s*none/.test(m[1]) && !/!important/.test(m[1]));
  assert.ok(!hidesSidebar, 'a .sidebar rule sets display:none; the hamburger cannot open the drawer');
});

test('the bottom-nav "+" opens a chooser instead of the photo uploader', () => {
  assert.match(html, /class="bnav-add"[^>]*data-action="openAddSheet"/);
  assert.match(app, /function openAddSheet\(/);
  assert.match(app, /function chooseAdd\(/);
  assert.match(app, /function closeAddSheet\(/);
  for (const kind of ['photos', 'url', 'paste']) {
    assert.ok(
      new RegExp(`data-action="chooseAdd" data-arg="${kind}"`).test(html),
      `missing "${kind}" option in the add sheet`
    );
  }
  assert.match(html, /id="add-overlay"/);
});
