import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startServer, guildWith, png, bits } from './helpers.js';

const IMG = png(2, 3);
let site, P, srv, api, g, alice, bob;
const hits = {};
const url = path => `http://127.0.0.1:${P}${path}`;

before(async () => {
  site = createServer((req, res) => {
    const html = body => res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(body);
    hits[req.url] = (hits[req.url] ?? 0) + 1;
    switch (req.url) {
      case '/flaky': return hits[req.url] === 1 ? req.socket.destroy() : html('<meta property="og:title" content="second try">');
      case '/down': return res.writeHead(503).end();
      case '/og': return html(`<html><head><title>fallback</title>
        <meta property="og:title" content="Cillhub &amp; friends"><meta property="og:description" content="A chat.">
        <meta property="og:image" content="/img.png"><meta property="og:site_name" content="Cill"><meta name="theme-color" content="#ff8800">
        </head></html>`);
      case '/img.png': return res.writeHead(200, { 'Content-Type': 'image/png' }).end(IMG);
      case '/fake.png': return res.writeHead(200, { 'Content-Type': 'image/png' }).end('<script>alert(1)</script>');
      case '/vector.svg': return res.writeHead(200, { 'Content-Type': 'image/svg+xml' }).end('<svg xmlns="http://www.w3.org/2000/svg"/>');
      case '/big': return html(`${' '.repeat(1100 * 1024)}<meta property="og:title" content="too late">`);
      case '/slow': return setTimeout(() => html('<meta property="og:title" content="slow">'), 3000);
      default: return res.writeHead(404).end();
    }
  });
  await new Promise(r => site.listen(0, '127.0.0.1', r));
  P = site.address().port;
  srv = await startServer({ env: { CILLCORD_UNFURL_ALLOW: `127.0.0.1:${P}` } });
  api = srv.api;
  g = await guildWith(srv, ['alice', 'bob']);
  ({ alice, bob } = g.users);
  bob.gw = await srv.gateway(bob.token);
});
after(async () => {
  await srv.stop();
  site.close();
});

const post = (body, ch = g.general.id, who = alice) => api('POST', `/channels/${ch}/messages`, who.token, body);
const updated = (id, pred = () => true) => bob.gw.event('MESSAGE_UPDATE', d => d.id === id && pred(d));

test('a link is unfurled after the message is stored: OpenGraph embed, image through the signed media proxy', async () => {
  const r = await post({ content: `look ${url('/og')}!` });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.embeds, []);
  const [e] = (await updated(r.body.id, d => d.embeds.length)).embeds;
  assert.deepEqual([e.type, e.url, e.title, e.description, e.color, e.provider], ['link', url('/og'), 'Cillhub & friends', 'A chat.', 0xff8800, { name: 'Cill' }]);
  assert.equal(e.thumbnail.url, url('/img.png'));
  assert.match(e.thumbnail.proxy_url, /^\/external\/[\w-]+\.[\w-]{43}$/);
  const img = await fetch(srv.origin + e.thumbnail.proxy_url);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal(img.headers.get('x-content-type-options'), 'nosniff');
  assert.match(img.headers.get('content-security-policy'), /sandbox/);
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), IMG);
  // stored: a later read has the embed too
  const [stored] = (await api('GET', `/channels/${g.general.id}/messages?limit=1`, bob.token)).body;
  assert.equal(stored.embeds[0].title, 'Cillhub & friends');

  // SUPPRESS_EMBEDS by the author removes them
  const s = await api('PATCH', `/channels/${g.general.id}/messages/${r.body.id}`, alice.token, { flags: 4 });
  assert.deepEqual([s.body.flags & 4, s.body.embeds], [4, []]);
  assert.deepEqual((await updated(r.body.id)).embeds, []);
  // others need MANAGE_MESSAGES for that
  assert.equal((await api('PATCH', `/channels/${g.general.id}/messages/${r.body.id}`, bob.token, { flags: 0 })).status, 403);
});

test('media proxy refuses unsigned, tampered and non-image URLs', async () => {
  const r = await post({ content: url('/og') });
  const proxied = (await updated(r.body.id, d => d.embeds.length)).embeds[0].thumbnail.proxy_url;
  const [payload, sig] = proxied.slice('/external/'.length).split('.');
  const flip = s => s.slice(0, -1) + (s.at(-1) === 'A' ? 'B' : 'A');
  const forged = Buffer.from(url('/fake.png')).toString('base64url');
  for (const path of [
    `/external/${payload}`, `/external/${payload}.${flip(sig)}`, `/external/${forged}.${sig}`, `/external/${flip(payload)}.${sig}`, '/external/',
  ]) assert.equal((await fetch(srv.origin + path)).status, 404, path);
  // signed by the server but not a raster image: still refused
  const hook = (await api('POST', `/channels/${g.general.id}/webhooks`, alice.token, { name: 'hook' })).body;
  const sent = await api('POST', `/webhooks/${hook.id}/${hook.token}?wait=true`, null, {
    embeds: [{ title: 't', image: { url: url('/fake.png') }, thumbnail: { url: url('/vector.svg') } }],
  });
  assert.equal(sent.status, 200);
  for (const x of [sent.body.embeds[0].image, sent.body.embeds[0].thumbnail]) {
    assert.match(x.proxy_url, /^\/external\//);
    assert.equal((await fetch(srv.origin + x.proxy_url)).status, 404);
  }
});

test('no unfurl for <wrapped> links, SUPPRESS_EMBEDS on send, or without EMBED_LINKS', async () => {
  const wrapped = await post({ content: `<${url('/og')}>` });
  const suppressed = await post({ content: url('/og'), flags: 4 });
  assert.ok(await bob.gw.none(f => f.t === 'MESSAGE_UPDATE' && [wrapped.body.id, suppressed.body.id].includes(f.d.id), 600));
  await api('PUT', `/channels/${g.general.id}/permissions/${g.guild.id}`, alice.token, { type: 0, allow: '0', deny: bits(14) });
  const plain = await post({ content: url('/og') }, g.general.id, bob);
  assert.equal(plain.status, 201);
  assert.ok(await bob.gw.none(f => f.t === 'MESSAGE_UPDATE' && f.d.id === plain.body.id, 600));
  await api('DELETE', `/channels/${g.general.id}/permissions/${g.guild.id}`, alice.token);
});

test('unfurling never delays or breaks sending; HTML is read up to 512 KiB only', async () => {
  const t = Date.now();
  const slow = await post({ content: `${url('/slow')} ${url('/big')} http://10.0.0.1/ http://localhost/og` });
  assert.equal(slow.status, 201);
  assert.ok(Date.now() - t < 1500, 'the response does not wait for the unfurl');
  // /big has its meta tag past 512 KiB, the private address and localhost:80 are refused: only /slow yields an embed
  const done = await bob.gw.wait(f => f.t === 'MESSAGE_UPDATE' && f.d.id === slow.body.id, 6000);
  assert.deepEqual(done.d.embeds.map(e => e.title), ['slow']);
});

test('a failed unfurl is retried once after a short delay: a dropped connection recovers, a 503 is tried twice only', async () => {
  const r = await post({ content: `${url('/flaky')} ${url('/down')} http://10.0.0.1/never` });
  const done = await bob.gw.wait(f => f.t === 'MESSAGE_UPDATE' && f.d.id === r.body.id, 8000);
  assert.deepEqual(done.d.embeds.map(e => e.title), ['second try']);
  assert.deepEqual([hits['/flaky'], hits['/down']], [2, 2]);
});

test('the media proxy answers Range requests', async () => {
  const r = await post({ content: url('/og') });
  const proxied = (await updated(r.body.id, d => d.embeds.length)).embeds[0].thumbnail.proxy_url;
  const part = await fetch(srv.origin + proxied, { headers: { Range: 'bytes=1-3' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 1-3/${IMG.length}`);
  assert.equal(part.headers.get('accept-ranges'), 'bytes');
  assert.equal(part.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), IMG.subarray(1, 4));
  const none = await fetch(srv.origin + proxied, { headers: { Range: `bytes=${IMG.length}-` } });
  assert.equal(none.status, 416);
  assert.equal(none.headers.get('content-range'), `bytes */${IMG.length}`);
});

test('media proxy cache: old images go, then the oldest until it fits (audit M9)', async () => {
  const { tempDir } = await import('./helpers.js');
  const { mkdir, writeFile, utimes } = await import('node:fs/promises');
  const dir = await tempDir();
  const env = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  const { pruneProxyCache } = await import("../src/proxy.js");
  process.env.DATA_DIR = env;
  await mkdir(`${dir}/external`, { recursive: true });
  const now = Date.now();
  for (const [name, ageDays] of [['a', 8], ['b', 3], ['c', 2], ['d', 1]]) {
    await writeFile(`${dir}/external/${name}`, Buffer.alloc(100));
    await utimes(`${dir}/external/${name}`, (now - ageDays * 86400_000) / 1000, (now - ageDays * 86400_000) / 1000);
  }
  assert.equal(pruneProxyCache(now, 250), 200); // a is too old, b is the oldest left
  const { readdirSync } = await import('node:fs');
  assert.deepEqual(readdirSync(`${dir}/external`).sort(), ['c', 'd']);
});

test('the meta parser stays linear on a hostile page (one long attribute name)', async () => {
  const { metaTags } = await import('../src/embeds.js'); // dynamic: proxy.js reads DATA_DIR on import
  const t = Date.now();
  assert.deepEqual(metaTags(`<meta ${'a'.repeat(512 * 1024)}>`), {});
  assert.deepEqual(metaTags(`${'<meta a'.repeat(50_000)}<title>${'b'.repeat(200_000)}`), {});
  assert.ok(Date.now() - t < 500, `took ${Date.now() - t} ms`);
  assert.equal(metaTags('<meta property="og:title" content="ok">')['og:title'], 'ok');
});
