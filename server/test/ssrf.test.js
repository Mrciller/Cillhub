import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { isPublicAddress, safeFetch, FetchRefused } from '../src/ssrf.js';

let local, port, hits = [];
before(async () => {
  local = createServer((req, res) => {
    hits.push({ url: req.url, host: req.headers.host, ua: req.headers['user-agent'] });
    if (req.url === '/redirect-private') return res.writeHead(302, { Location: 'http://10.1.2.3/secret' }).end();
    if (req.url === '/redirect-loop') return res.writeHead(302, { Location: '/redirect-loop' }).end();
    if (req.url === '/big') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('x'.repeat(2 * 1024 * 1024));
    }
    res.writeHead(200, { 'Content-Type': 'text/html' }).end('<title>ok</title>');
  });
  await new Promise(r => local.listen(0, '127.0.0.1', r));
  port = local.address().port;
});
after(() => local.close());

// the local test server counts as public only through this explicit allow list
const allow = () => new Set([`127.0.0.1:${port}`]);
const refused = p => assert.rejects(p, FetchRefused);

test('address classification: every non-public IPv4 and IPv6 range is refused', () => {
  for (const ip of [
    '0.0.0.0', '0.1.2.3', '10.0.0.1', '100.64.0.1', '100.127.255.254', '127.0.0.1', '127.255.255.255', '169.254.169.254', '172.16.0.1',
    '172.31.255.255', '192.0.0.8', '192.0.2.1', '192.168.1.1', '198.18.0.1', '198.51.100.7', '203.0.113.9', '224.0.0.1', '239.255.255.250',
    '240.0.0.1', '255.255.255.255',
    '::', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:8.8.8.8', '64:ff9b::7f00:1', 'fc00::1', 'fd12:3456::1', 'fe80::1',
    'ff02::1', '2001:db8::1', '2002:7f00:1::', '2001::1', 'not-an-ip',
  ]) assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '2a00:1450:4001:80b::200e']) assert.equal(isPublicAddress(ip), true, ip);
});

test('literal private addresses, other schemes, ports and credentials are refused before any connection', async () => {
  for (const url of [
    'http://127.0.0.1/', 'http://10.0.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/',
    'http://[fe80::1]/', 'http://[fd00::1]/', 'http://0.0.0.0/', 'http://100.64.1.1/', 'http://255.255.255.255/', 'http://224.0.0.1/',
    'https://8.8.8.8:8443/', 'http://8.8.8.8:22/', 'ftp://8.8.8.8/', 'file:///etc/passwd', 'http://user:pw@8.8.8.8/',
  ]) await refused(safeFetch(url, { resolve: async () => assert.fail('no DNS for literals') }));
  // the test server itself is private: only the allow list lets it through
  await refused(safeFetch(`http://127.0.0.1:${port}/`));
});

test('hostnames resolving to a private address (any of several) are refused; DNS is resolved once and pinned', async () => {
  await refused(safeFetch('http://internal.example/', { resolve: async () => [{ address: '10.0.0.5', family: 4 }] }));
  await refused(safeFetch('http://mixed.example/', { resolve: async () => [{ address: '8.8.8.8', family: 4 }, { address: '192.168.0.1', family: 4 }] }));
  await refused(safeFetch('http://v6.example/', { resolve: async () => [{ address: 'fd00::1', family: 6 }] }));
  await refused(safeFetch('http://nxdomain.example/', { resolve: async () => [] }));

  // rebinding: the first answer is vetted, a second lookup would say 10.0.0.1, but the socket goes to the vetted address
  let lookups = 0;
  const resolve = async () => (lookups++ ? [{ address: '10.0.0.1', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]);
  hits = [];
  const r = await safeFetch(`http://rebind.example:${port}/page`, { resolve, allow: allow() });
  assert.equal(r.status, 200);
  assert.equal(lookups, 1);
  assert.deepEqual(hits.map(h => [h.url, h.host, h.ua]), [['/page', `rebind.example:${port}`, 'CillhubBot/1.0']]);
});

test('every redirect hop is vetted again, at most 3 redirects', async () => {
  hits = [];
  await refused(safeFetch(`http://127.0.0.1:${port}/redirect-private`, { allow: allow() }));
  assert.equal(hits.length, 1, 'the private redirect target is never contacted');
  await refused(safeFetch(`http://127.0.0.1:${port}/redirect-loop`, { allow: allow() }));
  assert.equal(hits.filter(h => h.url === '/redirect-loop').length, 4); // the first request and 3 followed redirects; the 4th is refused
});

test('bodies are capped: truncated HTML at 1 MiB, larger media refused', async () => {
  const r = await safeFetch(`http://127.0.0.1:${port}/big`, { allow: allow() });
  assert.equal(r.body.length, 1024 * 1024);
  await refused(safeFetch(`http://127.0.0.1:${port}/big`, { allow: allow(), truncate: false }));
});
