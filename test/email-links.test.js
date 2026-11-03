import test from 'node:test';
import assert from 'node:assert';

import { extractRecipeLinks, isMostlyLinks, MAX_LINKS_PER_EMAIL } from '../lib/email-links.js';

test('a bare link on its own line is found', () => {
  assert.deepEqual(
    extractRecipeLinks('Check this out\nhttps://www.example.com/lemon-pasta\nthanks!'),
    ['https://www.example.com/lemon-pasta'],
  );
});

test('trailing punctuation from prose is not part of the link', () => {
  assert.deepEqual(extractRecipeLinks('Try (https://example.com/a-recipe).'), ['https://example.com/a-recipe']);
  assert.deepEqual(extractRecipeLinks('See https://example.com/b, it is great!'), ['https://example.com/b']);
  assert.deepEqual(extractRecipeLinks('"https://example.com/c"'), ['https://example.com/c']);
});

test('an HTML anchor is read by its href, not its visible text', () => {
  const html = '<p>Look: <a href="https://example.com/soup?utm=1&amp;x=2">click here</a></p>';
  assert.deepEqual(extractRecipeLinks(html), ['https://example.com/soup?utm=1&x=2']);
});

test('a link that appears as both an anchor and text is listed once', () => {
  const html = '<a href="https://example.com/dup">https://example.com/dup</a> https://example.com/dup';
  assert.deepEqual(extractRecipeLinks(html), ['https://example.com/dup']);
});

test('links keep the order they appear in, and the fragment is dropped', () => {
  const out = extractRecipeLinks('https://a.example.com/one#top https://b.example.com/two');
  assert.deepEqual(out, ['https://a.example.com/one', 'https://b.example.com/two']);
});

test('at most three links are followed, however many the mail holds', () => {
  const many = Array.from({ length: 12 }, (_, i) => `https://site${i}.example.com/r`).join(' ');
  assert.equal(extractRecipeLinks(many).length, MAX_LINKS_PER_EMAIL);
  assert.equal(extractRecipeLinks(many, 1).length, 1);
  assert.equal(extractRecipeLinks(many, 0).length, 0);
});

test('unsubscribe, tracking, image and social links are not recipes', () => {
  const skipped = [
    'https://example.com/unsubscribe?id=1',
    'https://example.com/email/preferences',
    'https://example.com/privacy',
    'https://example.com/logo.png',
    'https://example.com/file.pdf',
    'https://www.facebook.com/page',
    'https://twitter.com/someone',
    'https://x.com/someone',
    'https://www.instagram.com/p/abc',
    'https://youtu.be/abc',
    'https://maps.google.com/?q=x',
    'https://us1.list-manage.com/track/click',
  ];
  assert.deepEqual(extractRecipeLinks(skipped.join('\n')), []);
});

test('a real recipe link survives next to a footer full of noise', () => {
  const mail = `Made this last night!
https://www.seriouseats.com/lemon-pasta

--
Sent from my phone
https://example.com/unsubscribe
https://www.facebook.com/me`;
  assert.deepEqual(extractRecipeLinks(mail), ['https://www.seriouseats.com/lemon-pasta']);
});

test('only http and https are ever followed', () => {
  const mail = 'ftp://example.com/x file:///etc/passwd javascript:alert(1) data:text/html,hi mailto:a@b.com';
  assert.deepEqual(extractRecipeLinks(mail), []);
  assert.deepEqual(extractRecipeLinks('<a href="javascript:alert(1)">x</a><a href="file:///etc/passwd">y</a>'), []);
});

test('a link with credentials in it is dropped', () => {
  assert.deepEqual(extractRecipeLinks('https://user:pass@example.com/secret'), []);
});

test('an address with no dot in its host is dropped', () => {
  assert.deepEqual(extractRecipeLinks('http://localhost/admin http://intranet/x'), []);
});

test('nothing is filtered by being private here: the fetcher is the gate for that', () => {
  // The SSRF guard lives in safe-fetch, which is also what a pasted URL goes
  // through. This helper only picks; it must not pretend to be the guard.
  assert.deepEqual(extractRecipeLinks('http://192.168.1.1/x'), ['http://192.168.1.1/x']);
});

test('odd input never throws', () => {
  for (const value of [undefined, null, 0, 42, {}, [], '', '   ', 'http://', 'https://', '<a href="">x</a>']) {
    assert.deepEqual(extractRecipeLinks(value), []);
  }
});

test('a huge body is bounded rather than scanned without limit', () => {
  const big = 'x '.repeat(500000) + 'https://example.com/late-recipe';
  const started = Date.now();
  const out = extractRecipeLinks(big);
  assert.ok(Date.now() - started < 1500, 'finishes quickly');
  assert.deepEqual(out, [], 'a link beyond the cap is not read');
});

test('a very long link is ignored instead of being passed on', () => {
  assert.deepEqual(extractRecipeLinks('https://example.com/' + 'a'.repeat(5000)), []);
});

// ---------- isMostlyLinks ----------

test('a mail that is a link and a greeting is mostly links', () => {
  assert.equal(isMostlyLinks('Check this out!\nhttps://example.com/pasta\n\nSent from my iPhone'), true);
  assert.equal(isMostlyLinks('https://example.com/pasta'), true);
  assert.equal(isMostlyLinks('<p>Look</p><a href="https://example.com/x">here</a>'), true);
});

test('a written recipe is not mostly links, even with a link in it', () => {
  const written = 'Lemon pasta. ' + 'Boil the spaghetti until tender, then drain and toss with lemon juice and parmesan. '.repeat(4)
    + '\nOriginally from https://example.com/pasta';
  assert.equal(isMostlyLinks(written), false);
});

test('HTML markup does not make a short mail look long', () => {
  const html = '<html><head><style>' + 'p{color:red}'.repeat(100) + '</style></head><body>'
    + '<div><span><b>Hi</b></span></div>'.repeat(40) + '<a href="https://example.com/x">link</a></body></html>';
  assert.equal(isMostlyLinks(html), true);
});

test('empty and odd input count as nothing to read', () => {
  for (const value of [undefined, null, '', '   ']) assert.equal(isMostlyLinks(value), true);
});

// ---------- bareOfProse ----------
import { bareOfProse } from '../lib/email-links.js';

test('small talk around a link has no recipe in it', () => {
  for (const text of ['Check this out!', 'Hey! Try this one xx', 'Sent from my iPhone', 'Lemon Pasta - Serious Eats', '', '<p>Look</p>']) {
    assert.equal(bareOfProse(text + ' https://example.com/x'), true, text);
  }
});

test('a short written recipe is not bare, even beside a link', () => {
  for (const text of [
    'Toast: 2 slices bread, 1 tbsp butter, pinch of salt. Toast the bread, spread the butter.',
    'Eggs: 2 eggs, butter, salt. Fry in butter 2 min, salt.',
    'Whisk the eggs and add the milk',
    'bake at 180 for 20 minutes',
  ]) assert.equal(bareOfProse(text + ' https://example.com/x'), false, text);
});
