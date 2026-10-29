import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Reads the palettes straight out of the stylesheet, so a colour can never be
// changed in one place and left failing contrast in another.
const here = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(resolve(here, '../css/app.css'), 'utf8');

function block(startPattern) {
  const match = startPattern.exec(CSS);
  assert.ok(match, `could not find ${startPattern} in app.css`);
  const from = CSS.indexOf('{', match.index);
  const to = CSS.indexOf('}', from);
  return CSS.slice(from + 1, to);
}

function vars(text) {
  const out = {};
  for (const [, name, value] of text.matchAll(/--([a-z-]+)\s*:\s*([^;}]+)/g)) {
    out[name] = value.trim();
  }
  return out;
}

const LIGHT = vars(block(/:root\{/));
const DARK = vars(block(/:root\[data-theme="dark"\]\{/));

function toRgb(value) {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const digits = hex[1].length === 3 ? hex[1].split('').map((d) => d + d).join('') : hex[1];
    return [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16));
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(value);
  if (rgb) {
    const parts = rgb[1].split(',').map((n) => parseFloat(n));
    return parts.slice(0, 3);
  }
  throw new Error(`unsupported colour: ${value}`);
}

function luminance([r, g, b]) {
  const channel = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a, b) {
  const la = luminance(toRgb(a));
  const lb = luminance(toRgb(b));
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

test('both palettes define the same variables', () => {
  const light = Object.keys(LIGHT).sort();
  const dark = Object.keys(DARK).sort();
  const missing = light.filter((name) => !dark.includes(name));
  assert.deepEqual(missing, [], `the dark palette is missing: ${missing.join(', ')}`);
});

for (const [name, palette] of [['light', LIGHT], ['dark', DARK]]) {
  test(`${name}: body text is readable`, () => {
    assert.ok(contrast(palette.text, palette.bg) >= 4.5, `text on bg is ${contrast(palette.text, palette.bg).toFixed(2)}`);
    assert.ok(contrast(palette.text, palette.card) >= 4.5, `text on card is ${contrast(palette.text, palette.card).toFixed(2)}`);
  });

  test(`${name}: dimmed text is still readable`, () => {
    assert.ok(contrast(palette.dim, palette.bg) >= 4.5, `dim on bg is ${contrast(palette.dim, palette.bg).toFixed(2)}`);
    assert.ok(contrast(palette.dim, palette.card) >= 4.5, `dim on card is ${contrast(palette.dim, palette.card).toFixed(2)}`);
  });

  test(`${name}: button text on the accent colour`, () => {
    const ratio = contrast(palette['on-primary'], palette.primary);
    assert.ok(ratio >= 4.5, `on-primary on primary is ${ratio.toFixed(2)}`);
  });

  test(`${name}: links and accents on a card`, () => {
    const ratio = contrast(palette.primary, palette.card);
    assert.ok(ratio >= 4.5, `primary on card is ${ratio.toFixed(2)}`);
  });

  test(`${name}: accent and borders are visible as surfaces`, () => {
    assert.ok(contrast(palette.primary, palette.bg) >= 3, `primary on bg is ${contrast(palette.primary, palette.bg).toFixed(2)}`);
    assert.ok(contrast(palette.border, palette.card) >= 3, `border on card is ${contrast(palette.border, palette.card).toFixed(2)}`);
  });
}
