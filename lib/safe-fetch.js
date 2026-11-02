import dns from 'dns';
import net from 'net';
import { Agent, fetch as undiciFetch } from 'undici';

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
    (a === 192 && b === 0 && c === 2) ||          // TEST-NET-1
    (a === 198 && b === 51 && c === 100) ||        // TEST-NET-2
    (a === 203 && b === 0 && c === 113) ||         // TEST-NET-3
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

// Expands an IPv6 address into its eight 16-bit groups. Written out rather
// than regex-matched per form so compressed ("::"), trailing and embedded-IPv4
// spellings all land on the same array.
function groupsV6(ip) {
  let v = ip.toLowerCase().split('%')[0];

  // A trailing dotted quad is two groups: rewrite it into hex first.
  const dotted = v.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const [a, b, c, d] = dotted[2].split('.').map(Number);
    const hi = ((a << 8) | b).toString(16);
    const lo = ((c << 8) | d).toString(16);
    v = `${dotted[1]}${hi}:${lo}`;
  }

  const halves = v.split('::');
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length > 1 ? 8 - head.length - tail.length : 0;
  const parts = [...head, ...Array(Math.max(0, fill)).fill('0'), ...tail];
  if (parts.length !== 8) return null;
  const nums = parts.map((p) => parseInt(p || '0', 16));
  return nums.some((n) => !Number.isFinite(n) || n < 0 || n > 0xffff) ? null : nums;
}

const v4FromGroups = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

function isPrivateV6(ip) {
  const v = ip.toLowerCase();
  if (v === '::' || v === '::1') return true;

  const g = groupsV6(v);
  if (!g) return true; // unparseable: treat as unsafe

  // Anything that embeds an IPv4 address is only as safe as that address:
  // IPv4-mapped ::ffff:a.b.c.d, IPv4-compatible ::a.b.c.d, NAT64 64:ff9b::/96
  // and 6to4 2002::/16 (which carries one in groups 1 and 2).
  const embedsV4 = (hi, lo) => isPrivateV4(v4FromGroups(hi, lo));
  if (g.slice(0, 5).every((n) => n === 0) && (g[5] === 0xffff || g[5] === 0)) {
    if (embedsV4(g[6], g[7])) return true;
  }
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((n) => n === 0)) {
    if (embedsV4(g[6], g[7])) return true;
  }
  if (g[0] === 0x2002 && embedsV4(g[1], g[2])) return true;

  const first = g[0];
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  if ((first & 0xffc0) === 0xfec0) return true; // fec0::/10 site local (deprecated)
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
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
export function guardedLookup(hostname, options, callback) {
  // Node only expects an array when it asked for every address (options.all,
  // which is set when autoSelectFamily is on). A single-address request must
  // be answered as callback(err, addressString, family) or Node throws
  // ERR_INVALID_IP_ADDRESS.
  const wantAll = Boolean(options && options.all);
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return callback(err);
    const list = Array.isArray(addrs) ? addrs : [{ address: addrs.address, family: addrs.family }];
    if (!list.length) return callback(new Error('no addresses'));
    for (const a of list) {
      if (isPrivateIp(a.address)) return callback(new Error('That address is not allowed'));
    }
    if (wantAll) return callback(null, list);
    callback(null, list[0].address, list[0].family);
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

// Stops a download we are not going to use. Never throws: this runs on the way
// to reporting some other error, which must not be replaced by a cleanup one.
async function discardBody(response) {
  try {
    if (response && response.body) await response.body.cancel();
  } catch { /* already closed */ }
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
    // dns.lookup is the callback API and throws when called without one;
    // the promise API lives on dns.promises. Using the wrong one made every
    // hostname fail with "Could not resolve that website".
    addrs = await dns.promises.lookup(host, { all: true, verbatim: true });
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
      const response = await undiciFetch(current.toString(), {
        headers,
        signal: controller.signal,
        redirect: 'manual',
        dispatcher: safeDispatcher,
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        // Nobody will read this body, so release the socket now instead of
        // holding it open until the timer fires.
        await discardBody(response);
        if (!location) throw new Error('Redirect without a location');
        current = new URL(location, current);
        continue;
      }

      if (!response.ok) {
        await discardBody(response);
        throw new Error('Page returned ' + response.status);
      }
      return await readBodyCapped(response);
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error('Too many redirects');
}
