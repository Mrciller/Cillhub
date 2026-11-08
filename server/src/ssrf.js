import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

export const USER_AGENT = 'CillhubBot/1.0';

const v4Denied = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4], // multicast; reserved incl. broadcast
]) v4Denied.addSubnet(net, bits, 'ipv4');
// IPv6: only global unicast 2000::/3 is public. That already excludes ::, ::1, IPv4-mapped ::ffff:0:0/96, NAT64,
// ULA fc00::/7, link-local fe80::/10 and multicast ff00::/8; inside 2000::/3 these still reach IPv4 or are not routable:
const v6Global = new BlockList();
v6Global.addSubnet('2000::', 3, 'ipv6');
const v6Denied = new BlockList();
for (const [net, bits] of [['2001::', 32], ['2001:db8::', 32], ['2002::', 16], ['2001:10::', 28], ['2001:20::', 28]]) {
  v6Denied.addSubnet(net, bits, 'ipv6');
}

export function isPublicAddress(ip) {
  const v = isIP(ip);
  if (v === 4) return !v4Denied.check(ip, 'ipv4');
  if (v === 6) return v6Global.check(ip, 'ipv6') && !v6Denied.check(ip, 'ipv6');
  return false;
}

// test-only escape hatch: exact "ip:port" pairs treated as public; never set in production
export const ENV_ALLOW = new Set((process.env.CILLCORD_UNFURL_ALLOW ?? '').split(',').filter(Boolean));

export class FetchRefused extends Error {}

const defaultResolve = host => lookup(host, { all: true, verbatim: true });

// one vetted target per hop: every resolved address must be public, then the socket goes to the first one
// (also used by the v8 module Git sources, which pin git to the returned address)
export async function vet(url, { resolve = defaultResolve, allow = ENV_ALLOW } = {}) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new FetchRefused('scheme not allowed');
  if (url.username || url.password) throw new FetchRefused('credentials in URL');
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  const host = url.hostname.replace(/^\[|\]$/g, '');
  // a temporary DNS failure (EAI_AGAIN) is not a refusal, so the caller may try again; anything else resolves to nothing
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolve(host).catch(e => {
    if (e?.code === 'EAI_AGAIN') throw e;
    return [];
  });
  if (!addresses.length) throw new FetchRefused('host does not resolve');
  for (const { address } of addresses) {
    const ok = allow.has(`${address}:${port}`) || (isPublicAddress(address) && (port === 80 || port === 443));
    if (!ok) throw new FetchRefused(`address ${address}:${port} not allowed`);
  }
  return { ...addresses[0], port };
}

function request(url, target, { headers, signal, method = 'GET', body }) {
  const mod = url.protocol === 'https:' ? https : http;
  // connect to the vetted address; the URL's host still drives Host, SNI and certificate checks
  const pinned = (_host, opts, cb) => (opts?.all ? cb(null, [{ address: target.address, family: target.family }]) : cb(null, target.address, target.family));
  return new Promise((resolve, reject) => {
    const req = mod.request(url, { method, headers: { 'User-Agent': USER_AGENT, ...headers }, lookup: pinned, signal, agent: false }, resolve);
    req.on('error', reject);
    req.end(body);
  });
}

// reads at most maxBytes; with truncate the rest is dropped, otherwise a larger body is refused
async function readBody(res, maxBytes, truncate) {
  const chunks = [];
  let size = 0;
  for await (const chunk of res) {
    const room = maxBytes - size;
    if (chunk.length > room) {
      res.destroy();
      if (!truncate) throw new FetchRefused('body too large');
      chunks.push(chunk.subarray(0, room));
      size = maxBytes;
      break;
    }
    chunks.push(chunk);
    size += chunk.length;
  }
  return Buffer.concat(chunks);
}

// GET (or POST, never redirected) with SSRF protection: http/https on 80/443 only, DNS resolved here and pinned,
// every redirect hop re-vetted; onHop(url) may refuse a hop (throw FetchRefused) before it is vetted
export async function safeFetch(href, {
  maxBytes = 1024 * 1024, truncate = true, maxRedirects = 3, timeout = 5000, headers = {},
  resolve = defaultResolve, allow = ENV_ALLOW, method = 'GET', body: payload, onHop,
} = {}) {
  const signal = AbortSignal.timeout(timeout);
  let url = new URL(href);
  for (let hop = 0; ; hop++) {
    onHop?.(url);
    const target = await vet(url, { resolve, allow });
    const res = await request(url, target, { headers, signal, method, body: payload });
    if (method === 'GET' && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      if (hop >= maxRedirects) throw new FetchRefused('too many redirects');
      url = new URL(res.headers.location, url);
      continue;
    }
    const body = await readBody(res, maxBytes, truncate);
    return { status: res.statusCode, type: String(res.headers['content-type'] ?? '').toLowerCase(), body, url: url.href, headers: res.headers };
  }
}
