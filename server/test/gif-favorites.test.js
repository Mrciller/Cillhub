import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

test('favorite_gifs: validated, deduplicated by url, stored and synced', async () => {
  const srv = await startServer({ env: { GIPHY_API_KEY: '', TENOR_API_KEY: '' } });
  try {
    const alice = await srv.register('alice');
    const patch = body => srv.api('PATCH', '/users/@me/settings', alice.token, body);
    assert.deepEqual((await srv.api('GET', '/users/@me/settings', alice.token)).body.favorite_gifs, []);

    // a GIF search item as the picker gets it: src is the server's root-relative proxy path
    const [hit] = (await srv.api('GET', '/gifs/trending?limit=1', alice.token)).body;
    const fromSearch = { url: hit.url, src: hit.src, width: hit.width, height: hit.height, format: 'gif' };
    const fromChat = { url: 'https://example.com/a.gif', src: '/attachments/1/2/a.gif', width: 0, height: 0, format: 'image', extra: 'dropped' };
    const gw = await srv.gateway(alice.token);
    const ok = await patch({ favorite_gifs: [fromSearch, fromChat, { ...fromSearch, format: 'mp4' }] });
    assert.equal(ok.status, 200);
    const { extra, ...stored } = fromChat;
    assert.deepEqual(ok.body.favorite_gifs, [fromSearch, stored], 'first of each url kept, unknown keys dropped');
    assert.deepEqual((await gw.event('USER_SETTINGS_UPDATE')).favorite_gifs, [fromSearch, stored]);
    assert.deepEqual((await srv.api('GET', '/users/@me/settings', alice.token)).body.favorite_gifs, [fromSearch, stored]);

    const base = { url: 'https://example.com/x.gif', src: 'https://example.com/x.gif', width: 10, height: 10, format: 'gif' };
    for (const bad of [
      { favorite_gifs: 'nope' },
      { favorite_gifs: [null] },
      { favorite_gifs: [{ ...base, url: 'http://example.com/x.gif' }] },
      { favorite_gifs: [{ ...base, url: '/external/abc' }] },
      { favorite_gifs: [{ ...base, url: `https://example.com/${'a'.repeat(2048)}` }] },
      { favorite_gifs: [{ ...base, src: 'javascript:alert(1)' }] },
      { favorite_gifs: [{ ...base, src: '//evil.example/x.gif' }] },
      { favorite_gifs: [{ ...base, src: '/api/v9/users/@me' }] },
      { favorite_gifs: [{ ...base, width: 1.5 }] },
      { favorite_gifs: [{ ...base, height: 10001 }] },
      { favorite_gifs: [{ ...base, format: 'png' }] },
      { favorite_gifs: Array.from({ length: 251 }, (_, i) => ({ ...base, url: `https://example.com/${i}.gif` })) },
    ]) assert.equal((await patch(bad)).status, 400, JSON.stringify(bad).slice(0, 120));
    assert.equal((await patch({ favorite_gifs: Array.from({ length: 250 }, (_, i) => ({ ...base, url: `https://example.com/${i}.gif` })) })).status, 200);
  } finally {
    await srv.stop();
  }
});

test('favorite-gifs: PUT adds one (newest first, deduplicated), DELETE ?url= removes one, both synced', async () => {
  const srv = await startServer({ env: { GIPHY_API_KEY: '', TENOR_API_KEY: '' } });
  try {
    const bob = await srv.register('bob');
    const gif = n => ({ url: `https://example.com/${n}.gif`, src: `https://example.com/${n}.gif`, width: 10, height: 10, format: 'gif' });
    const put = g => srv.api('PUT', '/users/@me/settings/favorite-gifs', bob.token, g);
    const del = url => srv.api('DELETE', `/users/@me/settings/favorite-gifs${url === undefined ? '' : `?url=${encodeURIComponent(url)}`}`, bob.token);
    await srv.api('PATCH', '/users/@me/settings', bob.token, { favorite_gifs: [gif(1)] });
    const gw = await srv.gateway(bob.token);
    const r = await put({ ...gif(2), extra: 1 });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.favorite_gifs, [gif(2), gif(1)]);
    assert.deepEqual((await gw.event('USER_SETTINGS_UPDATE')).favorite_gifs, [gif(2), gif(1)]);
    assert.deepEqual((await put({ ...gif(1), width: 20 })).body.favorite_gifs, [{ ...gif(1), width: 20 }, gif(2)], 'again: moved to the front');
    assert.equal((await put({ ...gif(3), url: 'http://example.com/3.gif' })).status, 400);
    assert.equal((await put(null)).status, 400);
    assert.equal((await del()).status, 400);
    assert.deepEqual((await del(gif(1).url)).body.favorite_gifs, [gif(2)]);
    assert.deepEqual((await del('https://example.com/unknown.gif')).body.favorite_gifs, [gif(2)], 'unknown url: nothing changes');
    // the list stays at 250: the oldest drops
    await srv.api('PATCH', '/users/@me/settings', bob.token, { favorite_gifs: Array.from({ length: 250 }, (_, i) => gif(100 + i)) });
    const full = (await put(gif(9))).body.favorite_gifs;
    assert.deepEqual([full.length, full[0].url, full.at(-1).url], [250, gif(9).url, gif(348).url]);
  } finally {
    await srv.stop();
  }
});
