import dns from 'dns';
import net from 'net';
import { Agent } from 'undici';

function isPrivateV4(ip) {
  const [a, b, c] = ip.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateV6(ip) {
  const v = ip.toLowerCase();
  if (v === '::' || v === '::1') return true;

  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateV4(mapped[1]);

  const mappedHex = v.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return isPrivateV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }

  return /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || /^ff/.test(v);
}

export function isPrivateIp(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) return isPrivateV4(ip);
  if (kind === 6) return isPrivateV6(ip);
  return true; // not a valid IP: treat as unsafe
}

// Checks the address at CONNECT time, on the exact socket fetch uses.
// This closes the DNS-rebinding window between assertPublicUrl's lookup
// and fetch's own resolution.
function guardedLookup(hostname, options, callback) {
  const opts = { ...options, all: true };
  dns.lookup(hostname, opts, (err, addrs) => {
    if (err) return callback(err, null);
    const list = Array.isArray(addrs) ? addrs : [{ address: addrs.address, family: addrs.family }];
    if (!list.length) return callback(new Error('no addresses'), null);
    for (const a of list) {
      if (isPrivateIp(a.address)) return callback(new Error('That address is not allowed'), null);
    }
    callback(null, list);
  });
}

const safeDispatcher = new Agent({ connect: { lookup: guardedLookup } });

// Responses are capped so a huge page cannot fill the function's memory;
// import-url only keeps the first 20k chars anyway.
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

async function readBodyCapped(response) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_RESPONSE_BYTES) {
      await reader.cancel(); // keep what we have, stop the download
      break;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function assertPublicUrl(url) {
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only http and https URLs are allowed');
  }
  if (url.port && !['80', '443'].includes(url.port)) {
    throw new Error('Only the standard web ports (80 and 443) are allowed');
  }

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) throw new Error('Invalid URL');

  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    throw new Error('That address is not allowed');
  }

  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('That address is not allowed');
    return;
  }

  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error('Could not resolve that website');
  }
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) {
    throw new Error('That address is not allowed');
  }
}

/**
 * Fetches a page as text, refusing private/internal addresses.
 * Redirects are followed manually so every hop is checked too.
 */
export async function safeFetchText(rawUrl, { timeoutMs = 12000, maxRedirects = 4, headers = {} } = {}) {
  let current = new URL(rawUrl);

  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertPublicUrl(current);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(current.toString(), {
        headers,
        signal: controller.signal,
        redirect: 'manual',
        dispatcher: safeDispatcher,
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) throw new Error('Redirect without a location');
        current = new URL(location, current);
        continue;
      }

      if (!response.ok) throw new Error('Page returned ' + response.status);
      return await readBodyCapped(response);
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error('Too many redirects');
}
