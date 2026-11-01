import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// S9: the Apps Script cannot run here, so these tests pin the properties that
// made it unsafe: an open importer, a failure mail quoting the server, retries
// that outlive the function and a secret sent over http.

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const code = readFileSync(join(root, 'apps-script/Code.gs'), 'utf8');
const backup = readFileSync(join(root, 'apps-script/Backup.gs'), 'utf8');

test('an empty allowlist refuses every sender', () => {
  assert.match(code, /if \(!raw\) \{\s*\n\s*console\.error\('ALLOWED_SENDERS is not set/);
  assert.equal(/if \(!raw\) return true/.test(code), false, 'the open default is gone');
  assert.match(code, /if \(!wanted\.length\) return false;/, 'an empty list is a refusal');
});

test('the failure mail never quotes the server response', () => {
  const start = code.indexOf('function markFailed(');
  const body = code.slice(start, code.indexOf('\n}\n', start));
  // The only mention of the reason inside markFailed is the console.error line.
  const sent = body.slice(body.indexOf('GmailApp.sendEmail('));
  assert.equal(/reason/i.test(sent), false, 'the reason is logged, not mailed');
  assert.match(body, /console\.error\('Import failure reason/, 'and it is still logged');
  assert.equal(/Recipe API returned/.test(body), false);
});

test('replies are capped per day and a failed confirmation does not fail the import', () => {
  assert.match(code, /MAX_REPLIES_PER_DAY/);
  assert.match(code, /function canReplyToday\(\)/);
  const start = code.indexOf('sendConfirmation(sender, saved');
  const around = code.slice(start - 200, start + 200);
  assert.match(around, /try \{/, 'the confirmation is inside a try');
  assert.match(around, /canReplyToday\(\)/, 'and behind the daily cap');
});

test('the bearer secret only goes to an https URL, without following redirects', () => {
  assert.match(code, /RECIPE_IMPORT_API_URL must start with https/);
  assert.match(backup, /BACKUP_API_URL must start with https/);
  assert.match(code, /followRedirects: false/);
});
