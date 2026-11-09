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
