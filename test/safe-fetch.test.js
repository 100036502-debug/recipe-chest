import { test } from 'node:test';
import assert from 'node:assert';
import { isPrivateIp } from '../lib/safe-fetch.js';

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
