import { test } from 'node:test';
import assert from 'node:assert';
import { preclean, cleanItem, blockToList, tryParseJson, parseAiOutput } from '../lib/parse.js';

test('preclean strips think blocks and code fences', () => {
  assert.equal(preclean('<think>secret</think>```json\n{"a":1}\n```'), '{"a":1}');
});

test('cleanItem strips bullets, numbering and markdown emphasis', () => {
  assert.equal(cleanItem('- 2 cups flour'), '2 cups flour');
  assert.equal(cleanItem('1. Preheat oven'), 'Preheat oven');
  assert.equal(cleanItem('**Bold**'), 'Bold');
  assert.equal(cleanItem('*italics*'), 'italics');
});

test('blockToList splits lines and inline numbered items', () => {
  assert.deepEqual(blockToList('- one\n- two'), ['one', 'two']);
  assert.deepEqual(blockToList('1. mix 2. bake'), ['mix', 'bake']);
  assert.deepEqual(blockToList('salt - pepper'), ['salt', 'pepper']);
});

test('tryParseJson tolerates fences, prose and trailing commas', () => {
  assert.deepEqual(tryParseJson('```json\n{"a": 1}\n```'), { a: 1 });
  assert.deepEqual(tryParseJson('Here you go: {"a": [1,2,]} thanks'), { a: [1, 2] });
  assert.equal(tryParseJson('no json at all'), null);
  assert.equal(tryParseJson(''), null);
});

test('parseAiOutput reads every supported format', () => {
  const delimited = parseAiOutput(
    '===TITLE===\nCake\n===INGREDIENTS===\n- flour\n- sugar\n===INSTRUCTIONS===\nbake it'
  );
  assert.equal(delimited.title, 'Cake');
  assert.deepEqual(delimited.ingredients, ['flour', 'sugar']);

  const colon = parseAiOutput('TITLE: Pie\nINGREDIENTS:\ncrust\nfilling\nINSTRUCTIONS:\ncook');
  assert.equal(colon.title, 'Pie');

  const json = parseAiOutput('{"title":"Soup","ingredients":["water"],"instructions":["heat"]}');
  assert.equal(json.title, 'Soup');

  const heuristic = parseAiOutput('My Soup\nIngredients:\nbroth\nInstructions:\nsimmer gently');
  assert.equal(heuristic.title, 'My Soup');

  assert.equal(parseAiOutput('utter nonsense'), null);
});
