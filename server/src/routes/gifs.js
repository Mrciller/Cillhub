import { HttpError, intParam } from '../errors.js';
import { proxyUrl } from '../proxy.js';
import { setting } from '../instance.js';

const GIPHY_KEY = process.env.GIPHY_API_KEY;
// no built-in key: without GIPHY_API_KEY or TENOR_API_KEY the picker only offers the curated catalog below
const TENOR_KEY = process.env.TENOR_API_KEY;
const TENOR_CLIENT = process.env.TENOR_CLIENT_KEY || 'cillhub';
const GIPHY_BASE = 'https://api.giphy.com/v1/gifs';
const TENOR_BASE = 'https://tenor.googleapis.com/v2';

export const CATEGORIES = [
  { id: 'trending', name: 'Trending', q: '' },
  { id: 'happy', name: 'Happy', q: 'happy' },
  { id: 'sad', name: 'Sad', q: 'sad' },
  { id: 'applause', name: 'Applause', q: 'applause' },
  { id: 'dance', name: 'Dance', q: 'dance' },
  { id: 'cat', name: 'Cat', q: 'cat' },
  { id: 'anime', name: 'Anime', q: 'anime' },
  { id: 'gg', name: 'GG', q: 'gg' },
  { id: 'laugh', name: 'Laugh', q: 'laugh' },
  { id: 'excited', name: 'Excited', q: 'excited' },
  { id: 'shocked', name: 'Shocked', q: 'shocked' },
  { id: 'thumbsup', name: 'Thumbs Up', q: 'thumbs up' },
];

export function normalizeTenorUrl(url) {
  if (!url) return '';
  return url.replace(/^https?:\/\/media[0-9]*\.tenor\.com\/m\//, 'https://media.tenor.com/');
}

const CURATED_CATALOG = [
  {
    id: '7523542997650649169',
    title: 'Cat Dancing',
    url: 'https://media.tenor.com/aGj-frNYMFEAAAAC/cat-cat-dance.gif',
    src: proxyUrl('https://media.tenor.com/aGj-frNYMFEAAAAC/cat-cat-dance.gif'),
    preview: proxyUrl('https://media.tenor.com/aGj-frNYMFEAAAAM/cat-cat-dance.gif'),
    width: 498,
    height: 476,
    tags: ['cat', 'kitten', 'dance', 'happy', 'trending'],
  },
  {
    id: '3910325972591826807',
    title: 'Cat Handshake',
    url: 'https://media.tenor.com/NkREwRhR13cAAAAC/handshake-cat-meme.gif',
    src: proxyUrl('https://media.tenor.com/NkREwRhR13cAAAAC/handshake-cat-meme.gif'),
    preview: proxyUrl('https://media.tenor.com/NkREwRhR13cAAAAM/handshake-cat-meme.gif'),
    width: 276,
    height: 498,
    tags: ['cat', 'handshake', 'deal', 'trending'],
  },
  {
    id: '15123892793141871648',
    title: 'Happy Dance Cats',
    url: 'https://media.tenor.com/0eLcXZRPxCAAAAAC/happy-dance-cats.gif',
    src: proxyUrl('https://media.tenor.com/0eLcXZRPxCAAAAAC/happy-dance-cats.gif'),
    preview: proxyUrl('https://media.tenor.com/0eLcXZRPxCAAAAAM/happy-dance-cats.gif'),
    width: 480,
    height: 480,
    tags: ['dance', 'happy', 'cats', 'excited', 'trending'],
  },
  {
    id: '12638875631523783822',
    title: 'Shoulder Roll Dance',
    url: 'https://media.tenor.com/r2ZObFlQ5I4AAAAC/shoulder-roll-little-black-girl-dancing.gif',
    src: proxyUrl('https://media.tenor.com/r2ZObFlQ5I4AAAAC/shoulder-roll-little-black-girl-dancing.gif'),
    preview: proxyUrl('https://media.tenor.com/r2ZObFlQ5I4AAAAM/shoulder-roll-little-black-girl-dancing.gif'),
    width: 318,
    height: 480,
    tags: ['dance', 'groove', 'cool', 'trending'],
  },
  {
    id: '16675060056907675944',
    title: 'Applause Crowd',
    url: 'https://media.tenor.com/52m2xgRJeSgAAAAC/clapping-clap.gif',
    src: proxyUrl('https://media.tenor.com/52m2xgRJeSgAAAAC/clapping-clap.gif'),
    preview: proxyUrl('https://media.tenor.com/52m2xgRJeSgAAAAM/clapping-clap.gif'),
    width: 498,
    height: 280,
    tags: ['applause', 'clapping', 'cheering', 'bravo', 'trending', 'happy'],
  },
  {
    id: '11417951659847615064',
    title: 'Applause Standing',
    url: 'https://media.tenor.com/nnS2iivMglgAAAAC/very-good.gif',
    src: proxyUrl('https://media.tenor.com/nnS2iivMglgAAAAC/very-good.gif'),
    preview: proxyUrl('https://media.tenor.com/nnS2iivMglgAAAAM/very-good.gif'),
    width: 220,
    height: 238,
    tags: ['applause', 'very good', 'clapping', 'respect'],
  },
  {
    id: '8449124749132300414',
    title: 'Sad Crying Dog',
    url: 'https://media.tenor.com/dUFSMab-AH4AAAAC/dog-meme-meme-dog.gif',
    src: proxyUrl('https://media.tenor.com/dUFSMab-AH4AAAAC/dog-meme-meme-dog.gif'),
    preview: proxyUrl('https://media.tenor.com/dUFSMab-AH4AAAAM/dog-meme-meme-dog.gif'),
    width: 319,
    height: 320,
    tags: ['sad', 'crying', 'tears', 'upset', 'depressed', 'unhappy'],
  },
  {
    id: '13598694562309744302',
    title: 'Sad Single Tear',
    url: 'https://media.tenor.com/vLhEp8uCJq4AAAAC/dean-winchester-jensen-ackles.gif',
    src: proxyUrl('https://media.tenor.com/vLhEp8uCJq4AAAAC/dean-winchester-jensen-ackles.gif'),
    preview: proxyUrl('https://media.tenor.com/vLhEp8uCJq4AAAAM/dean-winchester-jensen-ackles.gif'),
    width: 245,
    height: 263,
    tags: ['sad', 'crying', 'tear', 'upset'],
  },
  {
    id: '3322575507661412535',
    title: 'Anime Facepalm',
    url: 'https://media.tenor.com/Lhwo0gmSWLcAAAAC/higuruma-jjk.gif',
    src: proxyUrl('https://media.tenor.com/Lhwo0gmSWLcAAAAC/higuruma-jjk.gif'),
    preview: proxyUrl('https://media.tenor.com/Lhwo0gmSWLcAAAAM/higuruma-jjk.gif'),
    width: 320,
    height: 188,
    tags: ['anime', 'shocked', 'tired', 'facepalm'],
  },
  {
    id: '12597428908881363633',
    title: 'Anime Excited',
    url: 'https://media.tenor.com/rtMO2T0cQrEAAAAC/42.gif',
    src: proxyUrl('https://media.tenor.com/rtMO2T0cQrEAAAAC/42.gif'),
    preview: proxyUrl('https://media.tenor.com/rtMO2T0cQrEAAAAM/42.gif'),
    width: 498,
    height: 372,
    tags: ['anime', 'excited', 'wow', 'sparkle', 'happy', 'trending'],
  },
  {
    id: '7735878336384052246',
    title: 'Good Game GG Pixel',
    url: 'https://media.tenor.com/a1tcXEnPrBYAAAAC/gg-wp.gif',
    src: proxyUrl('https://media.tenor.com/a1tcXEnPrBYAAAAC/gg-wp.gif'),
    preview: proxyUrl('https://media.tenor.com/a1tcXEnPrBYAAAAM/gg-wp.gif'),
    width: 498,
    height: 498,
    tags: ['gg', 'good game', 'gaming', 'esports', 'wp', 'trending'],
  },
  {
    id: '7714254636875870349',
    title: 'GG Brofist',
    url: 'https://media.tenor.com/aw6JuGnlcI0AAAAC/pewdiepie-brofist.gif',
    src: proxyUrl('https://media.tenor.com/aw6JuGnlcI0AAAAC/pewdiepie-brofist.gif'),
    preview: proxyUrl('https://media.tenor.com/aw6JuGnlcI0AAAAM/pewdiepie-brofist.gif'),
    width: 498,
    height: 469,
    tags: ['gg', 'brofist', 'fistbump', 'respect', 'gaming'],
  },
  {
    id: '3717613948823709624',
    title: 'Laughing Cat',
    url: 'https://media.tenor.com/M5eeMI-sp7gAAAAC/funny.gif',
    src: proxyUrl('https://media.tenor.com/M5eeMI-sp7gAAAAC/funny.gif'),
    preview: proxyUrl('https://media.tenor.com/M5eeMI-sp7gAAAAM/funny.gif'),
    width: 240,
    height: 233,
    tags: ['laugh', 'lol', 'cat', 'haha', 'funny', 'happy', 'trending'],
  },
  {
    id: '6983358578546172979',
    title: 'Laughing Bear',
    url: 'https://media.tenor.com/YOnfoLVr5DMAAAAC/laughs-laughing-cute.gif',
    src: proxyUrl('https://media.tenor.com/YOnfoLVr5DMAAAAC/laughs-laughing-cute.gif'),
    preview: proxyUrl('https://media.tenor.com/YOnfoLVr5DMAAAAM/laughs-laughing-cute.gif'),
    width: 498,
    height: 404,
    tags: ['laugh', 'lol', 'haha', 'cute', 'bear', 'happy'],
  },
  {
    id: '11366929630539488910',
    title: 'Super Excited Scream',
    url: 'https://media.tenor.com/nb9yRj8rHo4AAAAC/excited-ah.gif',
    src: proxyUrl('https://media.tenor.com/nb9yRj8rHo4AAAAC/excited-ah.gif'),
    preview: proxyUrl('https://media.tenor.com/nb9yRj8rHo4AAAAM/excited-ah.gif'),
    width: 498,
    height: 354,
    tags: ['excited', 'hype', 'screaming', 'yes', 'happy', 'trending'],
  },
  {
    id: '16963945808433096689',
    title: 'Excited Laugh',
    url: 'https://media.tenor.com/62wK1Xyhp_EAAAAC/happy.gif',
    src: proxyUrl('https://media.tenor.com/62wK1Xyhp_EAAAAC/happy.gif'),
    preview: proxyUrl('https://media.tenor.com/62wK1Xyhp_EAAAAM/happy.gif'),
    width: 498,
    height: 280,
    tags: ['excited', 'happy', 'celebrate', 'laugh'],
  },
  {
    id: '9858523764566581784',
    title: 'Shocked Dog',
    url: 'https://media.tenor.com/iNCDIZS84hgAAAAC/help.gif',
    src: proxyUrl('https://media.tenor.com/iNCDIZS84hgAAAAC/help.gif'),
    preview: proxyUrl('https://media.tenor.com/iNCDIZS84hgAAAAM/help.gif'),
    width: 498,
    height: 486,
    tags: ['shocked', 'omg', 'what', 'surprised', 'dog', 'trending'],
  },
  {
    id: '9375488175388231856',
    title: 'Shocked Cat',
    url: 'https://media.tenor.com/ghxs0nHkCLAAAAAC/shocked-shock.gif',
    src: proxyUrl('https://media.tenor.com/ghxs0nHkCLAAAAAC/shocked-shock.gif'),
    preview: proxyUrl('https://media.tenor.com/ghxs0nHkCLAAAAAM/shocked-shock.gif'),
    width: 480,
    height: 480,
    tags: ['shocked', 'cat', 'omg', 'gasp'],
  },
  {
    id: '5676038700371371386',
    title: 'Cat Thumbs Up',
    url: 'https://media.tenor.com/TsVXIAMBZXoAAAAC/cat-thumbs-up-thumbs-up.gif',
    src: proxyUrl('https://media.tenor.com/TsVXIAMBZXoAAAAC/cat-thumbs-up-thumbs-up.gif'),
    preview: proxyUrl('https://media.tenor.com/TsVXIAMBZXoAAAAM/cat-thumbs-up-thumbs-up.gif'),
    width: 256,
    height: 240,
    tags: ['thumbsup', 'thumbs up', 'agree', 'ok', 'yes', 'cat', 'trending'],
  },
  {
    id: '13206845596055018221',
    title: 'Thumbs Up Computer Kid',
    url: 'https://media.tenor.com/t0gkGMRKmu0AAAAC/ok-nice-grafic.gif',
    src: proxyUrl('https://media.tenor.com/t0gkGMRKmu0AAAAC/ok-nice-grafic.gif'),
    preview: proxyUrl('https://media.tenor.com/t0gkGMRKmu0AAAAM/ok-nice-grafic.gif'),
    width: 320,
    height: 240,
    tags: ['thumbsup', 'thumbs up', 'ok', 'nice', 'agree'],
  },
];

function sanitizeGif(item) {
  const { id, title, url, src, width, height, preview } = item;
  return { id, title: title ?? '', url, src, width: Number(width) || 0, height: Number(height) || 0, preview: preview ?? src };
}

function giphyGifObj(g) {
  const src = g.images?.downsized ?? g.images?.original;
  const preview = g.images?.fixed_width_still ?? g.images?.original_still ?? src;
  if (!src?.url || !preview?.url) return null;
  return {
    id: g.id,
    title: g.title ?? '',
    url: g.url,
    src: proxyUrl(src.url),
    width: Number(src.width) || 0,
    height: Number(src.height) || 0,
    preview: proxyUrl(preview.url),
  };
}

function tenorGifObj(item) {
  const gifRaw = item.media_formats?.gif ?? item.media_formats?.mediumgif ?? item.media_formats?.tinygif;
  const previewRaw = item.media_formats?.tinygif ?? item.media_formats?.nanogif ?? gifRaw;
  const gifUrl = normalizeTenorUrl(gifRaw?.url);
  const previewUrl = normalizeTenorUrl(previewRaw?.url) || gifUrl;
  if (!gifUrl) return null;
  const dims = gifRaw.dims ?? [0, 0];
  return {
    id: String(item.id),
    title: item.title || item.content_description || '',
    url: gifUrl,
    src: proxyUrl(gifUrl),
    width: dims[0] || 0,
    height: dims[1] || 0,
    preview: previewUrl ? proxyUrl(previewUrl) : proxyUrl(gifUrl),
  };
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const gifCache = new Map();
function getCached(key) {
  const item = gifCache.get(key);
  if (!item) return null;
  if (Date.now() > item.expires) {
    gifCache.delete(key);
    return null;
  }
  return item.data;
}
function setCached(key, data) {
  if (gifCache.size > 200) {
    const firstKey = gifCache.keys().next().value;
    gifCache.delete(firstKey);
  }
  gifCache.set(key, { data, expires: Date.now() + CACHE_TTL_MS });
}

async function callGiphy(path, params) {
  const res = await fetch(`${GIPHY_BASE}/${path}?${new URLSearchParams({ api_key: GIPHY_KEY, rating: 'pg-13', ...params })}`, { signal: AbortSignal.timeout(5000) })
    .catch(() => null);
  if (!res?.ok) throw new HttpError(502, 0, 'GIF provider unavailable');
  const body = await res.json().catch(() => ({}));
  return (body.data ?? []).map(giphyGifObj).filter(Boolean);
}

async function callTenor(endpoint, params) {
  const query = new URLSearchParams({
    key: TENOR_KEY,
    client_key: TENOR_CLIENT,
    media_filter: 'gif,tinygif',
    ...params,
  });
  const res = await fetch(`${TENOR_BASE}/${endpoint}?${query}`, { signal: AbortSignal.timeout(5000) })
    .catch(() => null);
  if (!res?.ok) throw new HttpError(502, 0, 'GIF provider unavailable');
  const body = await res.json().catch(() => ({}));
  return (body.results ?? []).map(tenorGifObj).filter(Boolean);
}

function curatedTrending(limit) {
  const trending = CURATED_CATALOG.filter(g => g.tags.includes('trending'));
  const remaining = CURATED_CATALOG.filter(g => !g.tags.includes('trending'));
  return [...trending, ...remaining].slice(0, limit).map(sanitizeGif);
}

function curatedSearch(query, limit) {
  const q = query.trim().toLowerCase();
  if (!q) return curatedTrending(limit);
  const words = q.split(/\s+/).filter(Boolean);

  const scored = CURATED_CATALOG.map(item => {
    let score = 0;
    const titleLower = item.title.toLowerCase();
    const idLower = item.id.toLowerCase();
    for (const w of words) {
      if (item.tags.includes(w)) score += 10;
      else if (item.tags.some(t => t.includes(w))) score += 5;
      if (titleLower.includes(w)) score += 4;
      if (idLower.includes(w)) score += 3;
    }
    return { item, score };
  }).filter(x => x.score > 0);

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(x => sanitizeGif(x.item));
}

async function getGifs(mode, query) {
  if (!setting('gifs_enabled')) throw new HttpError(404, 0, '404: Not Found');
  const limit = intParam(query, 'limit', 25, 1, 50);
  const q = String(query.get('q') ?? '').slice(0, 100);
  const cacheKey = `${mode}:${q}:${limit}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  let results = null;
  if (GIPHY_KEY) {
    try {
      results = mode === 'trending' ? await callGiphy('trending', { limit: String(limit) }) : await callGiphy('search', { q, limit: String(limit) });
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) throw err;
      results = mode === 'trending' ? curatedTrending(limit) : curatedSearch(q, limit);
    }
  } else if (TENOR_KEY) {
    try {
      results = mode === 'trending' || !q ? await callTenor('featured', { limit: String(limit) }) : await callTenor('search', { q, limit: String(limit) });
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) throw err;
      results = mode === 'trending' ? curatedTrending(limit) : curatedSearch(q, limit);
    }
  } else {
    results = mode === 'trending' ? curatedTrending(limit) : curatedSearch(q, limit);
  }

  if (results && results.length) {
    setCached(cacheKey, results);
  }
  return results ?? [];
}

export default [
  ['GET', '/gifs/categories', () => {
    if (!setting('gifs_enabled')) throw new HttpError(404, 0, '404: Not Found');
    return CATEGORIES;
  }, { open: true }],
  ['GET', '/gifs/search', ({ query }) => getGifs('search', query), { open: true }],
  ['GET', '/gifs/trending', ({ query }) => getGifs('trending', query), { open: true }],
];
