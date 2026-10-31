import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// S3: the click dispatcher must only reach functions we listed, so these tests
// read the source the browser runs and compare the maps with the markup.

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const app = readFileSync(join(root, 'js/app.js'), 'utf8');
const html = readFileSync(join(root, 'index.html'), 'utf8');

function block(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `${start} not found`);
  const to = source.indexOf(end, from);
  return source.slice(from, to);
}

const actionsBlock = block(app, 'const ACTIONS = {', '};');
const specialBlock = block(app, 'const SPECIAL_CLICK = {', '};');
const changeBlock = block(app, 'const CHANGE_ACTIONS = {', '};');

const keysOf = (text) => [...text.matchAll(/^\s{2}([A-Za-z_$][\w$]*)\s*[:,]/gm)].map((m) => m[1]);

function namesIn(markup, attribute) {
  return [...markup.matchAll(new RegExp(`data-${attribute}="([a-zA-Z_$][\\w$]*)"`, 'g'))].map((m) => m[1]);
}

test('every click action in the markup is in ACTIONS or SPECIAL_CLICK', () => {
  const allowed = new Set([...keysOf(actionsBlock), ...keysOf(specialBlock)]);
  const used = new Set([...namesIn(html, 'action'), ...namesIn(app, 'action')]);

  assert.ok(used.size > 50, 'the scan found the markup');
  const missing = [...used].filter((name) => !allowed.has(name));
  assert.deepEqual(missing, [], 'these actions would do nothing when clicked');
});

test('every change, input and key action is in its own map', () => {
  const change = new Set(keysOf(changeBlock));
  for (const name of new Set(namesIn(app, 'change'))) {
    assert.ok(change.has(name), `data-change="${name}" has no entry`);
  }
  const inputBlock = block(app, 'const INPUT_ACTIONS = {', '};');
  for (const name of new Set(namesIn(html, 'input'))) {
    assert.ok(keysOf(inputBlock).includes(name), `data-input="${name}" has no entry`);
  }
  const enterBlock = block(app, 'const ENTER_ACTIONS = {', '};');
  for (const name of new Set(namesIn(html, 'enter'))) {
    assert.ok(keysOf(enterBlock).includes(name), `data-enter="${name}" has no entry`);
  }
});

test('the dispatcher no longer resolves arbitrary globals', () => {
  assert.equal(/window\[name\]/.test(app), false, 'window[name] is gone');
  assert.match(app, /hasOwnProperty\.call\(ACTIONS, name\)/);
});

test('every listed action is still a function in the file', () => {
  const defined = new Set([
    ...[...app.matchAll(/^(?:async )?function ([A-Za-z_$][\w$]*)\(/gm)].map((m) => m[1]),
  ]);
  const missing = keysOf(actionsBlock).filter((name) => !defined.has(name));
  assert.deepEqual(missing, [], 'an action points at a function that is not there');
});
