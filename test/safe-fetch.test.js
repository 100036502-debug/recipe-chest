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

// ---- S12: the addresses that embed or alias a private IPv4 ----------------

test('NAT64 and 6to4 addresses are judged by the IPv4 they carry', async () => {
  const { isPrivateIp } = await import('../lib/safe-fetch.js');

  assert.equal(isPrivateIp('64:ff9b::7f00:1'), true, 'NAT64 of 127.0.0.1');
  assert.equal(isPrivateIp('64:ff9b::a9fe:a9fe'), true, 'NAT64 of 169.254.169.254 metadata');
  assert.equal(isPrivateIp('2002:7f00:0001::'), true, '6to4 of 127.0.0.1');
  assert.equal(isPrivateIp('2002:a9fe:a9fe::1'), true, '6to4 of the metadata address');
  assert.equal(isPrivateIp('::7f00:1'), true, 'IPv4-compatible 127.0.0.1');
  assert.equal(isPrivateIp('::127.0.0.1'), true, 'IPv4-compatible, dotted');

  // a public address in the same forms is still allowed
  assert.equal(isPrivateIp('64:ff9b::808:808'), false, 'NAT64 of 8.8.8.8');
  assert.equal(isPrivateIp('2002:0808:0808::1'), false, '6to4 of 8.8.8.8');
});

test('deprecated and documentation ranges are refused', async () => {
  const { isPrivateIp } = await import('../lib/safe-fetch.js');
  assert.equal(isPrivateIp('fec0::1'), true, 'site-local fec0::/10');
  assert.equal(isPrivateIp('192.0.2.10'), true, 'TEST-NET-1');
  assert.equal(isPrivateIp('198.51.100.10'), true, 'TEST-NET-2');
  assert.equal(isPrivateIp('203.0.113.10'), true, 'TEST-NET-3');
  assert.equal(isPrivateIp('2606:4700::1111'), false, 'a real public v6 address');
});

test('an IPv6 form that cannot be parsed is treated as unsafe', async () => {
  const { isPrivateIp } = await import('../lib/safe-fetch.js');
  assert.equal(isPrivateIp('::ffff:not-an-ip'), true);
  assert.equal(isPrivateIp('1:2:3:4:5:6:7:8:9'), true);
});
