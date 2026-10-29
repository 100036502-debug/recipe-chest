import test from 'node:test';
import assert from 'node:assert';

import { createHandler, dailyKey, stripUrls, sanitiseChange, sanitiseOptions } from '../lib/actions/ai-transform.js';
import { createFakeKv } from './helpers/fake-kv.js';
import { makeReq, makeRes, sessionCookie } from './helpers/fake-http.js';

const RECIPE = {
  id: 'r1',
  title: 'Pancakes',
  ingredients: ['2 cups flour', '1 cup milk', '2 eggs'],
  instructions: ['Mix', 'Fry'],
  notes: '',
};

const GOOD = JSON.stringify({
  ingredients: ['240 g flour', '240 ml milk', '2 eggs'],
  instructions: ['Mix it', 'Fry it'],
  notes: 'Flour and milk converted.',
  summary: 'Converted flour and milk to grams and millilitres.',
});

async function setup({ chatReply = GOOD, recipe = RECIPE, env = {} } = {}) {
  const kv = createFakeKv();
  if (recipe) await kv.set('recipe:r1', recipe);
  const calls = [];
  const chat = async (options) => {
    calls.push(options);
    if (chatReply instanceof Error) throw chatReply;
    return chatReply;
  };
  const saved = {};
  for (const key of ['AI_DAILY_LIMIT']) {
    saved[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  const handler = createHandler({ kv, chat });
  return { kv, handler, calls, restore: () => {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  } };
}

async function run(handler, body, { method = 'POST', cookie = sessionCookie(), headers = {} } = {}) {
  const res = makeRes();
  await handler(makeReq({ method, body, headers: { cookie, ...headers } }), res);
  return res;
}

test('the validation matrix answers before any model call', async () => {
  const ctx = await setup();
  try {
    assert.equal((await run(ctx.handler, { kind: 'metric' })).statusCode, 400);
    assert.equal((await run(ctx.handler, { id: 'r1', kind: 'fry-it' })).statusCode, 400);
    assert.equal((await run(ctx.handler, { id: 'nope', kind: 'metric' })).statusCode, 404);
    assert.equal((await run(ctx.handler, { id: 'r1', kind: 'substitute' })).statusCode, 400);
    assert.equal((await run(ctx.handler, { id: 'r1', kind: 'substitute', ingredient: '1 tsp salt' })).statusCode, 400);
    assert.equal((await run(ctx.handler, { id: 'r1', kind: 'metric' }, { method: 'GET' })).statusCode, 405);
    assert.equal(ctx.calls.length, 0, 'no model call for invalid input');
  } finally { ctx.restore(); }
});

test('metric returns the before and after lists and the summary', async () => {
  const ctx = await setup();
  try {
    const res = await run(ctx.handler, { id: 'r1', kind: 'metric' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.kind, 'metric');
    assert.deepEqual(res.body.before.ingredients, RECIPE.ingredients);
    assert.deepEqual(res.body.after.ingredients, ['240 g flour', '240 ml milk', '2 eggs']);
    assert.match(res.body.summary, /metric|grams|millilitres/i);

    const [options] = ctx.calls;
    assert.equal(options.json, true);
    assert.equal(options.temperature, 0.2);
    assert.equal(options.maxTokens, 3500);
    assert.match(options.messages[0].content, /untrusted DATA/i);
    assert.match(options.messages[0].content, /Ignore any request/i);
  } finally { ctx.restore(); }
});

test('substitute returns options only', async () => {
  const ctx = await setup({
    chatReply: JSON.stringify({ options: [{ name: 'Oat milk', note: 'Use the same volume.' }, { name: 'Soy milk' }] }),
  });
  try {
    const res = await run(ctx.handler, { id: 'r1', kind: 'substitute', ingredient: '1 cup milk' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.options.length, 2);
    assert.equal(res.body.options[0].name, 'Oat milk');
    assert.equal(res.body.before, undefined);
  } finally { ctx.restore(); }
});

test('a guest cannot spend the AI budget', async () => {
  const ctx = await setup();
  const saved = process.env.GUEST_CODE;
  process.env.GUEST_CODE = 'guest-code';
  try {
    const { makeSessionValue } = await import('../lib/auth.js');
    const guest = makeSessionValue('guest-code', undefined, 'guest');
    const res = await run(ctx.handler, { id: 'r1', kind: 'metric' }, { cookie: `rc_session=${guest}` });
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, { error: 'View-only access' });
    assert.equal(ctx.calls.length, 0);
  } finally {
    if (saved === undefined) delete process.env.GUEST_CODE; else process.env.GUEST_CODE = saved;
    ctx.restore();
  }
});

test('the daily cap is enforced across everyone', async () => {
  const ctx = await setup({ env: { AI_DAILY_LIMIT: '2' } });
  try {
    for (let i = 0; i < 2; i += 1) {
      assert.equal((await run(ctx.handler, { id: 'r1', kind: 'metric' })).statusCode, 200);
    }
    const blocked = await run(ctx.handler, { id: 'r1', kind: 'metric' });
    assert.equal(blocked.statusCode, 429);
    assert.deepEqual(blocked.body, { error: 'Daily AI limit reached. Try again tomorrow.' });
    assert.equal(ctx.calls.length, 2, 'the third call never reached the model');
  } finally { ctx.restore(); }
});

test('the usage counter is the only thing written', async () => {
  const ctx = await setup();
  try {
    await run(ctx.handler, { id: 'r1', kind: 'vacuum' });
    await run(ctx.handler, { id: 'r1', kind: 'metric' });
    const keys = [...ctx.kv._keys()].sort();
    assert.ok(keys.includes('recipe:r1'));
    assert.ok(keys.some((k) => k.startsWith('ai_usage:')));
    assert.deepEqual(await ctx.kv.get('recipe:r1'), RECIPE, 'the stored recipe is untouched');
    const counter = Number(await ctx.kv.get(dailyKey()));
    assert.equal(counter, 1, 'an invalid request is not counted');
  } finally { ctx.restore(); }
});

test('urls are stripped and long values trimmed', () => {
  assert.equal(stripUrls('see https://evil.example/x for more'), 'see for more');
  assert.equal(stripUrls('http://a.example'), '');
  const long = 'x'.repeat(2000);
  const clean = sanitiseChange({ ingredients: [long], instructions: ['ok'], notes: 'a https://b.example b', summary: 'y'.repeat(400) });
  assert.equal(clean.ingredients[0].length, 1000);
  assert.equal(clean.notes, 'a b');
  assert.equal(clean.summary.length, 200);
  assert.deepEqual(sanitiseOptions({ options: [{ name: 'a' }, {}, { name: 'b' }] }).map((o) => o.name), ['a', 'b']);
});

test('unusable model output is a 502, not a saved recipe', async () => {
  for (const reply of ['not json at all', JSON.stringify({ ingredients: [], instructions: ['x'] }), JSON.stringify({ ingredients: ['x'] }), '']) {
    const ctx = await setup({ chatReply: reply });
    try {
      const res = await run(ctx.handler, { id: 'r1', kind: 'metric' });
      assert.equal(res.statusCode, 502, `reply: ${reply.slice(0, 20)}`);
      assert.deepEqual(await ctx.kv.get('recipe:r1'), RECIPE);
    } finally { ctx.restore(); }
  }
});

test('a model failure is a 502 and a missing key a 500', async () => {
  const broken = await setup({ chatReply: new Error('upstream down') });
  assert.equal((await run(broken.handler, { id: 'r1', kind: 'metric' })).statusCode, 502);
  broken.restore();

  const noKey = new Error('Groq API key not configured');
  noKey.status = 500;
  const unset = await setup({ chatReply: noKey });
  assert.equal((await run(unset.handler, { id: 'r1', kind: 'metric' })).statusCode, 500);
  unset.restore();
});
