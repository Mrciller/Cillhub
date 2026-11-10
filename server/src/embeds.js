import { invalid } from './errors.js';
import { safeFetch, FetchRefused } from './ssrf.js';
import { proxyUrl } from './proxy.js';
import { sniff, imageSize } from './files.js';

const isHttp = u => typeof u === 'string' && u.length <= 2048 && /^https?:\/\/[^\s]+$/i.test(u);

function text(v, field, max, required = false) {
  if (v == null && !required) return undefined;
  if (typeof v !== 'string' || (required && !v.trim())) throw invalid(field, 'BASE_TYPE_REQUIRED', 'Must be a string.');
  const t = v.trim();
  if (t.length > max) throw invalid(field, 'BASE_TYPE_BAD_LENGTH', `Must be ${max} or fewer in length.`);
  return t;
}

function link(v, field, attachmentUrl) {
  if (v == null) return undefined;
  if (typeof v === 'string' && v.startsWith('attachment://') && attachmentUrl) {
    const url = attachmentUrl(v.slice('attachment://'.length));
    if (url) return { url, proxy_url: url };
  }
  if (!isHttp(v)) throw invalid(field, 'URL_TYPE_INVALID_URL', 'Not a well formed http(s) URL.');
  return { url: v, proxy_url: proxyUrl(v) };
}

const drop = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

// rich embeds from webhooks, with the documented limits; images get proxy_url so clients never fetch third-party hosts
export function richEmbeds(value, attachmentUrl) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 10) throw invalid('embeds', 'BASE_TYPE_MAX_LENGTH', 'At most 10 embeds.');
  let total = 0;
  const out = value.map((e, i) => {
    const f = `embeds.${i}`;
    if (typeof e !== 'object' || e === null) throw invalid(f, 'MODEL_TYPE_CONVERT', 'Must be an embed object.');
    const fields = e.fields ?? [];
    if (!Array.isArray(fields) || fields.length > 25) throw invalid(`${f}.fields`, 'BASE_TYPE_MAX_LENGTH', 'At most 25 fields.');
    if (e.color != null && !(Number.isInteger(e.color) && e.color >= 0 && e.color <= 0xffffff)) throw invalid(`${f}.color`, 'NUMBER_TYPE_COERCE', 'Must be a color integer.');
    if (e.timestamp != null && (typeof e.timestamp !== 'string' || Number.isNaN(Date.parse(e.timestamp)))) throw invalid(`${f}.timestamp`, 'DATE_TYPE_PARSE', 'Must be an ISO8601 timestamp.');
    const author = e.author == null ? undefined : drop({
      name: text(e.author.name, `${f}.author.name`, 256, true),
      url: e.author.url == null ? undefined : link(e.author.url, `${f}.author.url`).url,
      ...(e.author.icon_url != null && (({ url, proxy_url }) => ({ icon_url: url, proxy_icon_url: proxy_url }))(link(e.author.icon_url, `${f}.author.icon_url`, attachmentUrl))),
    });
    const footer = e.footer == null ? undefined : drop({
      text: text(e.footer.text, `${f}.footer.text`, 2048, true),
      ...(e.footer.icon_url != null && (({ url, proxy_url }) => ({ icon_url: url, proxy_icon_url: proxy_url }))(link(e.footer.icon_url, `${f}.footer.icon_url`, attachmentUrl))),
    });
    const embed = drop({
      type: 'rich',
      title: text(e.title, `${f}.title`, 256),
      description: text(e.description, `${f}.description`, 4096),
      url: e.url == null ? undefined : link(e.url, `${f}.url`).url,
      timestamp: e.timestamp == null ? undefined : new Date(e.timestamp).toISOString(),
      color: e.color ?? undefined,
      author, footer,
      image: e.image == null ? undefined : link(e.image.url, `${f}.image.url`, attachmentUrl),
      thumbnail: e.thumbnail == null ? undefined : link(e.thumbnail.url, `${f}.thumbnail.url`, attachmentUrl),
      fields: fields.length ? fields.map((x, j) => ({
        name: text(x?.name, `${f}.fields.${j}.name`, 256, true), value: text(x?.value, `${f}.fields.${j}.value`, 1024, true), inline: !!x.inline,
      })) : undefined,
    });
    total += [embed.title, embed.description, author?.name, footer?.text, ...(embed.fields ?? []).flatMap(x => [x.name, x.value])]
      .reduce((n, s) => n + (s?.length ?? 0), 0);
    return embed;
  });
  if (total > 6000) throw invalid('embeds', 'MAX_EMBED_SIZE_EXCEEDED', 'Embed size exceeds maximum size of 6000.');
  return out;
}

// up to 5 distinct http(s) URLs, skipping the ones wrapped in <...> (the "no preview" syntax)
export function linkUrls(content) {
  const out = [];
  for (const m of content.matchAll(/<?https?:\/\/[^\s<>]+>?/gi)) {
    if (m[0].startsWith('<') && m[0].endsWith('>')) continue;
    const url = m[0].replace(/^</, '').replace(/[)\].,!?:;'"]+$/, '');
    try { new URL(url); } catch { continue; }
    if (!out.includes(url)) out.push(url);
    if (out.length === 5) break;
  }
  return out;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = s => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, e) => {
  if (e[0] === '#') {
    const cp = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : all;
  }
  return ENTITIES[e.toLowerCase()] ?? all;
});

export function metaTags(html) {
  const meta = {};
  // bounded and anchored on the preceding whitespace so a long run of name characters cannot backtrack quadratically
  for (const [tag] of html.matchAll(/<meta\b[^<>]{0,2048}>/gi)) {
    const attrs = {};
    for (const a of tag.matchAll(/\s([\w:-]{1,64})\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) attrs[a[1].toLowerCase()] = decode(a[2] ?? a[3] ?? a[4]);
    const key = (attrs.property ?? attrs.name ?? '').toLowerCase();
    if (key && attrs.content != null && !(key in meta)) meta[key] = attrs.content.trim();
  }
  const title = /<title[^<>]{0,1024}>([^<]{0,4096})<\/title>/i.exec(html);
  if (title && !meta['html:title']) meta['html:title'] = decode(title[1]).trim();
  return meta;
}

const cut = (s, n) => s && (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const int = v => (/^\d{1,5}$/.test(v ?? '') ? Number(v) : undefined);

function htmlEmbed(url, html) {
  const m = metaTags(html);
  const title = m['og:title'] ?? m['twitter:title'] ?? m['html:title'];
  const description = m['og:description'] ?? m['twitter:description'] ?? m.description;
  let image = m['og:image'] ?? m['og:image:url'] ?? m['og:image:secure_url'] ?? m['twitter:image'] ?? m['twitter:image:src'];
  try { image = image && new URL(image, url).href; } catch { image = undefined; }
  if (image) image = image.replace(/^https?:\/\/media[0-9]*\.tenor\.com\/m\//, 'https://media.tenor.com/');
  if (!title && !description && !image) return null;
  const color = /^#[0-9a-f]{6}$/i.test(m['theme-color'] ?? '') ? parseInt(m['theme-color'].slice(1), 16) : undefined;
  const media = isHttp(image) ? drop({ url: image, proxy_url: proxyUrl(image), width: int(m['og:image:width']), height: int(m['og:image:height']) }) : undefined;
  const large = m['twitter:card'] === 'summary_large_image';
  const type = m['og:type']?.startsWith('article') ? 'article' : 'link';
  return drop({
    type, url, title: cut(title, 256), description: cut(description, 350), color,
    provider: m['og:site_name'] ? { name: cut(m['og:site_name'], 256) } : undefined,
    ...(media && (large ? { image: media } : { thumbnail: media })),
  });
}

const YOUTUBE = /^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{11})/i;

async function youtubeEmbed(url, id) {
  const watch = `https://www.youtube.com/watch?v=${id}`;
  let o = {};
  const r = await safeFetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watch)}`).catch(() => null);
  if (r?.status === 200) try { o = JSON.parse(r.body); } catch { /* keep the minimal embed */ }
  const thumb = isHttp(o.thumbnail_url) ? o.thumbnail_url : `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
  return drop({
    type: 'video', url, title: cut(o.title, 256), color: 0xff0000,
    provider: { name: 'YouTube', url: 'https://www.youtube.com' },
    author: o.author_name ? drop({ name: cut(o.author_name, 256), url: isHttp(o.author_url) ? o.author_url : undefined }) : undefined,
    thumbnail: drop({ url: thumb, proxy_url: proxyUrl(thumb), width: o.thumbnail_width, height: o.thumbnail_height }),
    // the client loads the player only on click, from youtube-nocookie
    video: { url: `https://www.youtube-nocookie.com/embed/${id}`, width: 1280, height: 720 },
  });
}

// a failure worth one more try: the site was unreachable, slow or answered 5xx/429 (never an SSRF refusal)
class Transient extends Error {}

async function unfurlOnce(url, opts) {
  const yt = YOUTUBE.exec(url);
  if (yt) return youtubeEmbed(url, yt[1]);
  const r = await safeFetch(url, { maxBytes: 512 * 1024, ...opts, headers: { Accept: 'text/html,application/xhtml+xml,image/*;q=0.8' } });
  if (r.status >= 500 || r.status === 429) throw new Transient(`HTTP ${r.status}`);
  if (r.status !== 200) return null;
  if (r.type.startsWith('image/')) {
    const type = sniff(r.body);
    if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(type)) return null;
    return { type: 'image', url, thumbnail: drop({ url, proxy_url: proxyUrl(url), ...imageSize(r.body, type) }) };
  }
  if (!r.type.includes('html')) return null;
  return htmlEmbed(url, r.body.toString('utf8'));
}

// one URL into one embed, or null; never throws. A transient failure is retried once after retryDelay ms.
export async function unfurl(url, { retryDelay = 2000, ...opts } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await unfurlOnce(url, opts);
    } catch (e) {
      if (e instanceof FetchRefused || attempt > 0) return null;
      await new Promise(r => setTimeout(r, retryDelay));
    }
  }
}
