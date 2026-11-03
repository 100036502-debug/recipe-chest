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

// C4: a folder only counts as a backup once every slice has landed.
test('the day folder is built under a name retention ignores', () => {
  assert.match(backup, /root\.createFolder\('incomplete-' \+ stamp\)/);
  assert.equal(/root\.createFolder\(stamp\)/.test(backup), false, 'the date folder is not created up front');
});

test('a finished run renames the folder to the date', () => {
  const finish = backup.indexOf('dayFolder.setName(stamp)');
  const created = backup.indexOf("createFolder('incomplete-' + stamp)");
  assert.ok(created > -1 && finish > created, 'the rename happens after the fetches');
});

test('a failed run trashes the folder it was building', () => {
  const catchBlock = backup.slice(backup.indexOf('} catch (error) {'), backup.indexOf('} finally {'));
  assert.match(catchBlock, /if \(dayFolder\) \{/, 'it only cleans up what it created');
  assert.match(catchBlock, /dayFolder\.setTrashed\(true\)/);
});

test('retention runs whether the run succeeded or not', () => {
  const final = backup.slice(backup.indexOf('} finally {'));
  assert.match(final, /trashOldFolders_\(root, config\.keepWeeks\)/, 'trimming is not success-only');
});

test('an abandoned incomplete folder is cleaned up later', () => {
  assert.match(backup, /name\.indexOf\('incomplete-'\) === 0/);
  assert.match(backup, /getDateCreated\(\)\.getTime\(\) < Date\.now\(\) - 24 \* 60 \* 60 \* 1000/, 'with a day of grace');
});

// Script Properties has a fixed quota; counters that are never removed fill it,
// and then every setProperty throws.
test('a message that is imported clears its retry counter', () => {
  const poll = code.slice(code.indexOf('function pollRecipeImports'), code.indexOf('function handleImportError'));
  const okPath = poll.slice(poll.indexOf('importMessage(message, apiUrl, secret);'), poll.indexOf('} catch (error)'));
  assert.match(okPath, /deleteProperty\('import_attempts:' \+ message\.getId\(\)\)/);
});

test('old daily reply counters are pruned when a new day starts', () => {
  assert.match(code, /function pruneOldReplyCounters_\(properties, todayKey\)/);
  assert.match(code, /indexOf\('replies_on:'\) === 0 && all\[i\] !== todayKey/, 'only reply counters, never today\'s');
  assert.match(code, /pruneOldReplyCounters_\(properties, key\);/, 'and it is actually called');
  assert.match(code, /Number\(properties\.getProperty\(todayKey\) \|\| 0\) !== 1\) return;/, 'only on the first reply of a day');
});

test('an attachment is claimed by the PDF pass or the image pass, never both', () => {
  const images = code.slice(code.indexOf('function extractImageAttachments'), code.indexOf('function sendConfirmation'));
  assert.match(images, /contentType === 'application\/pdf' \|\| name\.toLowerCase\(\)\.endsWith\('\.pdf'\)\) continue;/);
  // and the guard sits after the image test, before any bytes are read
  assert.ok(images.indexOf("endsWith('.pdf')) continue;") < images.indexOf('att.getBytes()'), 'checked before the bytes are read');
});

// A link shared from a phone is often an HTML-only mail. The API reads links out
// of either form, so the script hands it the HTML when the plain text has none.
test('the script falls back to the HTML body when the plain text holds no link', () => {
  const fn = code.slice(code.indexOf('function importMessage'), code.indexOf('const payload = {'));
  assert.match(fn, /let bodyText = message\.getPlainBody\(\) \|\| ''/);
  assert.match(fn, /if \(!\/https\?:\\\/\\\/\/i\.test\(bodyText\)\)/, 'only when the plain text has no link');
  assert.match(fn, /message\.getBody\(\)/);
  assert.match(fn, /substring\(0, 100000\)/, 'and the size is bounded');
});

test('a mail with a plain-text link is sent exactly as before', () => {
  const fn = code.slice(code.indexOf('function importMessage'), code.indexOf('const payload = {'));
  // the HTML is read inside the guard, never unconditionally
  const before = fn.slice(0, fn.indexOf('message.getBody()'));
  assert.match(before, /if \(!\/https\?:/);
});

test('the confirmation says which page a recipe came from', () => {
  const fn = code.slice(code.indexOf('function sendConfirmation'));
  assert.match(fn, /if \(entry\.sourceUrl\) lines\.push\(`From: \$\{entry\.sourceUrl\}`\)/);
  assert.equal((fn.match(/entry\.sourceUrl/g) || []).length >= 4, true, 'for both new and already-saved recipes');
});
