// Temporary: proves CI fails when a test fails. Deleted immediately after.
import { test } from 'node:test';
import assert from 'node:assert';

test('deliberate failure to prove CI goes red', () => {
  assert.equal(1, 2);
});
