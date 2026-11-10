import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

test('GIF integration: zero-config fallback, categories, trending and search', async () => {
  const srv = await startServer({ env: { GIPHY_API_KEY: '', TENOR_API_KEY: '' } });
  try {
    const alice = await srv.register('alice');

    // 1. GET /gifs/categories returns category chips
    const catRes = await srv.api('GET', '/gifs/categories', alice.token);
    assert.equal(catRes.status, 200);
    assert.ok(Array.isArray(catRes.body));
    assert.equal(catRes.body.length, 12);
    const expectedIds = ['trending', 'happy', 'sad', 'applause', 'dance', 'cat', 'anime', 'gg', 'laugh', 'excited', 'shocked', 'thumbsup'];
    assert.deepEqual(catRes.body.map(c => c.id), expectedIds);

    const trendingChip = catRes.body.find(c => c.id === 'trending');
    assert.ok(trendingChip);
    assert.equal(trendingChip.name, 'Trending');
    assert.equal(trendingChip.q, '');

    const catChip = catRes.body.find(c => c.id === 'cat');
    assert.ok(catChip);
    assert.equal(catChip.name, 'Cat');
    assert.equal(catChip.q, 'cat');

    // 2. GET /gifs/trending returns 200 with valid GIF items
    const trendRes = await srv.api('GET', '/gifs/trending', alice.token);
    assert.equal(trendRes.status, 200);
    assert.ok(Array.isArray(trendRes.body));
    assert.ok(trendRes.body.length > 0);
    for (const g of trendRes.body) {
      assert.ok(typeof g.id === 'string' && g.id.length > 0);
      assert.ok(typeof g.url === 'string' && g.url.length > 0);
      assert.ok(typeof g.src === 'string' && g.src.length > 0);
      assert.ok(typeof g.width === 'number');
      assert.ok(typeof g.height === 'number');
    }

    // 3. GET /gifs/search?q=cat returns 200 with matching results
    const searchRes = await srv.api('GET', '/gifs/search?q=cat', alice.token);
    assert.equal(searchRes.status, 200);
    assert.ok(Array.isArray(searchRes.body));
    assert.ok(searchRes.body.length > 0);
    const hasCat = searchRes.body.some(g => g.id.includes('cat') || g.title.toLowerCase().includes('cat'));
    assert.ok(hasCat, 'search results should contain cat gifs');

    // 4. GET /gifs/search with other category queries works
    const danceRes = await srv.api('GET', '/gifs/search?q=dance', alice.token);
    assert.equal(danceRes.status, 200);
    assert.ok(danceRes.body.length > 0);

    // 5. Zero-config fallback with limit query param works
    const limitRes = await srv.api('GET', '/gifs/trending?limit=3', alice.token);
    assert.equal(limitRes.status, 200);
    assert.equal(limitRes.body.length, 3);

    // 6. A search without a match is empty, not the trending list; an empty query still gives trending
    const none = await srv.api('GET', '/gifs/search?q=zzqxnomatch', alice.token);
    assert.equal(none.status, 200);
    assert.deepEqual(none.body, []);
    const blank = await srv.api('GET', '/gifs/search?q=', alice.token);
    assert.equal(blank.status, 200);
    assert.ok(blank.body.length > 0);

    // 7. Unauthenticated calls also succeed (open route)
    const openRes = await srv.api('GET', '/gifs/categories');
    assert.equal(openRes.status, 200);
    assert.ok(Array.isArray(openRes.body));

    const openTrend = await srv.api('GET', '/gifs/trending');
    assert.equal(openTrend.status, 200);
    assert.ok(Array.isArray(openTrend.body));
  } finally {
    await srv.stop();
  }
});
