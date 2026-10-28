import { test } from 'node:test';
import assert from 'node:assert';
import { isPrivateIp, guardedLookup } from '../lib/safe-fetch.js';

test('isPrivateIp blocks loopback and private ranges', () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254']) {
    assert.equal(isPrivateIp(ip), true, `${ip} should be private`);
  }
});

test('isPrivateIp blocks IPv6 private ranges', () => {
  for (const ip of ['::1', 'fd00::1', '::ffff:127.0.0.1', 'fe80::1', 'ff00::1']) {
    assert.equal(isPrivateIp(ip), true, `${ip} should be private`);
  }
});

test('isPrivateIp allows public addresses', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34']) {
    assert.equal(isPrivateIp(ip), false, `${ip} should be public`);
  }
});

// guardedLookup is what the socket actually connects to, so it must reject a
// private address and must answer in the shape Node asked for.
function lookup(hostname, options) {
  return new Promise((resolve) => {
    guardedLookup(hostname, options, (err, address, family) => {
      resolve({ err, address, family });
    });
  });
}

test('guardedLookup rejects localhost when all addresses are requested', async () => {
  const { err } = await lookup('localhost', { all: true });
  assert.ok(err, 'expected an error for localhost');
  assert.match(err.message, /not allowed/);
});

test('guardedLookup rejects localhost for a single-address request', async () => {
  // options.all falsy: Node expects callback(err, address, family), not an array.
  const { err } = await lookup('localhost', {});
  assert.ok(err, 'expected an error for localhost');
  assert.match(err.message, /not allowed/);
});

test('guardedLookup rejects the loopback IP with all: false', async () => {
  const { err } = await lookup('127.0.0.1', { all: false });
  assert.ok(err, 'expected an error for 127.0.0.1');
  assert.match(err.message, /not allowed/);
});
