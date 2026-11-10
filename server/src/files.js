import { mkdirSync, rmSync, createReadStream } from 'node:fs';
import { writeFile, readFile, rename, stat, open } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { DATA_DIR, get, run } from './db.js';
import { HttpError, invalid } from './errors.js';
import { attachmentSig } from './proxy.js';

const IMAGES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const INLINE = new Set([...IMAGES, 'video/mp4', 'video/webm', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm']);
const MAX_IMAGE = 8 * 1024 * 1024;
const SECURITY = { 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" };

const ascii = (buf, at, s) => buf.toString('latin1', at, at + s.length) === s;

// the type the bytes prove, among the types we would serve inline
export function sniff(buf) {
  if (ascii(buf, 0, '\x89PNG\r\n\x1a\n')) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (ascii(buf, 0, 'GIF87a') || ascii(buf, 0, 'GIF89a')) return 'image/gif';
  if (ascii(buf, 0, 'RIFF') && ascii(buf, 8, 'WEBP')) return 'image/webp';
  if (ascii(buf, 0, 'RIFF') && ascii(buf, 8, 'WAVE')) return 'audio/wav';
  if (ascii(buf, 4, 'ftyp')) return 'video/mp4';
  if (ascii(buf, 0, '\x1a\x45\xdf\xa3')) return 'video/webm';
  if (ascii(buf, 0, 'OggS')) return 'audio/ogg';
  if (ascii(buf, 0, 'ID3') || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  return null;
}

export function imageSize(buf, type) {
  try {
    if (type === 'image/png') return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (type === 'image/gif') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    if (type === 'image/webp') {
      if (ascii(buf, 12, 'VP8 ')) return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      if (ascii(buf, 12, 'VP8L')) { const b = buf.readUInt32LE(21); return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 }; }
      if (ascii(buf, 12, 'VP8X')) return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
    }
    if (type === 'image/jpeg') {
      for (let i = 2; i + 9 < buf.length;) {
        if (buf[i] !== 0xff) return null;
        const marker = buf[i + 1];
        if (marker === 0xff) { i++; continue; } // fill byte
        // SOF0..SOF15 carry the frame size; C4, C8 and CC are other segments in that range
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
        }
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
  } catch { /* truncated header */ }
  return null;
}

const dir = (...parts) => {
  const d = join(DATA_DIR, ...parts);
  mkdirSync(d, { recursive: true });
  return d;
};

// bytes of a base64 data URI whose label and magic bytes are both one of types
export function dataUri(value, field, types, max) {
  const m = typeof value === 'string' && /^data:([\w.+-]+\/[\w.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!m || !types.includes(m[1])) throw invalid(field, 'IMAGE_INVALID', `Must be a ${types.join(', ')} data URI.`);
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length > max) throw invalid(field, 'BINARY_TYPE_MAX_SIZE', `File must be at most ${max / 1024} KiB.`);
  const type = sniff(bytes);
  if (!types.includes(type)) throw invalid(field, 'IMAGE_INVALID', `File is not a ${types.join(', ')} file.`);
  return { bytes, type };
}

// avatar, guild icon or event cover from a data URI; returns the new hash (null clears). kind: 'avatars' | 'icons' | 'guild-events'
export async function saveImage(value, field, kind, ownerId) {
  if (value === null) return null;
  const { bytes } = dataUri(value, field, IMAGES, MAX_IMAGE);
  const hash = randomBytes(16).toString('hex');
  await writeFile(join(dir(kind, ownerId), hash), bytes);
  return hash;
}

export const removeImage = (kind, ownerId, hash) => hash && rmSync(join(DATA_DIR, kind, ownerId, hash), { force: true });

export const safeFilename = name => String(name).replace(/[^\w.-]+/g, '_').replace(/^\.+/, '').slice(-100) || 'file';

// the first n bytes of a file (fewer if it is shorter)
async function head(file, n) {
  const fh = await open(file);
  try {
    const { buffer, bytesRead } = await fh.read(Buffer.alloc(n), 0, n, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

// moves one streamed upload (src/multipart.js) into place; returns the attachment fields the DB row needs
export async function saveAttachment(channelId, id, file) {
  const dest = join(dir('attachments', channelId), id);
  await rename(file.path, dest);
  let bytes = await head(dest, 64 * 1024);
  const proven = sniff(bytes);
  // a JPEG's frame size can sit behind large metadata segments
  if (proven === 'image/jpeg' && !imageSize(bytes, proven) && file.size > bytes.length) bytes = await readFile(dest);
  const claimed = /^[\w.+-]+\/[\w.+-]+$/.test(file.type) ? file.type.toLowerCase() : 'application/octet-stream';
  // an inline-capable type is only kept when the bytes prove it; anything else keeps the client's word but downloads
  const content_type = proven ?? (INLINE.has(claimed) ? 'application/octet-stream' : claimed);
  return { filename: safeFilename(file.name), size: file.size, content_type, ...imageSize(bytes, proven) };
}

export const removeAttachment = (channelId, id) => rmSync(join(DATA_DIR, 'attachments', channelId, id), { force: true });
export const removeChannelFiles = channelId => rmSync(join(DATA_DIR, 'attachments', channelId), { recursive: true, force: true });

// emoji, sticker and soundboard files: DATA_DIR/<kind>/<id>, served by their bytes' type whatever extension is asked for
export const saveAsset = (kind, id, bytes) => writeFile(join(dir(kind), id), bytes);
export const removeAsset = (kind, id) => rmSync(join(DATA_DIR, kind, id), { force: true });

const IMAGE_PATH = /^\/(avatars|icons|guild-events|banners|channel-icons|app-icons|splashes|welcome-backgrounds|guild-tag-badges|role-icons|chat-backgrounds)\/(\d{1,19})\/([0-9a-f]{32})(?:\.(?:png|jpg|jpeg|gif|webp))?$/;
const ROLE_ICON_PATH = /^\/roles\/(\d{1,19})\/icons\/([0-9a-f]{32})(?:\.(?:png|jpg|jpeg|webp))?$/; // the user docs' spelling of role-icons
const DECORATION_PATH = /^\/avatar-decoration-presets\/([0-9a-f]{32})(?:\.(?:png|webp))?$/;
const MEMBER_IMAGE_PATH = /^\/guilds\/(\d{1,19})\/users\/(\d{1,19})\/(avatars|banners)\/([0-9a-f]{32})(?:\.(?:png|jpg|jpeg|gif|webp))?$/;
// /attachments/<channel>/<id>/<sig>/<filename>; uploads from before signed URLs (legacy_url) also answer without <sig>
const ATTACHMENT_PATH = /^\/attachments\/(\d{1,19})\/(\d{1,19})\/(?:([\w-]{22})\/)?([^/]+)$/;
const ASSET_PATH = /^\/(emojis|stickers|soundboard-sounds|user-sounds)\/(\d{1,19})(?:\.(?:png|gif|webp|jpg|jpeg|json|mp3|ogg))?$/;
const ASSET_TABLE = { emojis: 'emojis WHERE id', stickers: 'stickers WHERE id', 'soundboard-sounds': 'soundboard_sounds WHERE sound_id', 'user-sounds': 'user_sounds WHERE id' };
export const isCdnPath = pathname => IMAGE_PATH.test(pathname) || MEMBER_IMAGE_PATH.test(pathname) || ATTACHMENT_PATH.test(pathname) || ASSET_PATH.test(pathname)
  || ROLE_ICON_PATH.test(pathname) || DECORATION_PATH.test(pathname);

const IMAGE_OWNER = {
  avatars: (id, hash) => get('SELECT 1 FROM users WHERE id = ? AND avatar = ?', id, hash) ?? get('SELECT 1 FROM webhooks WHERE id = ? AND avatar = ?', id, hash),
  icons: (id, hash) => get('SELECT 1 FROM guilds WHERE id = ? AND icon = ?', id, hash),
  'guild-events': (id, hash) => get('SELECT 1 FROM scheduled_events WHERE id = ? AND image = ?', id, hash),
  banners: (id, hash) => get('SELECT 1 FROM users WHERE id = ? AND banner = ?', id, hash) ?? get('SELECT 1 FROM guilds WHERE id = ? AND banner = ?', id, hash),
  splashes: (id, hash) => get('SELECT 1 FROM guilds WHERE id = ? AND splash = ?', id, hash),
  'welcome-backgrounds': (id, hash) => get("SELECT 1 FROM guilds WHERE id = ? AND json_extract(welcome_screen, '$.background') = ?", id, hash),
  'guild-tag-badges': (id, hash) => get("SELECT 1 FROM guilds WHERE id = ? AND json_extract(profile, '$.badge_hash') = ?", id, hash),
  'role-icons': (id, hash) => get('SELECT 1 FROM roles WHERE id = ? AND icon = ?', id, hash),
  'chat-backgrounds': (id, hash) => get("SELECT 1 FROM users WHERE id = ? AND json_extract(settings, '$.chat_background') = ?", id, hash),
  'channel-icons': (id, hash) => get('SELECT 1 FROM channels WHERE id = ? AND icon = ?', id, hash),
  'app-icons': (id, hash) => get('SELECT 1 FROM applications WHERE id = ? AND icon = ?', id, hash),
};

const headType = async file => sniff(await head(file, 16));

// RFC 9110 single byte range of a representation of size bytes: {start, end}, 'unsatisfiable', or null when there is
// no Range or it is one we ignore (malformed, several ranges, last < first), which means the whole file
export function byteRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? '').trim());
  if (!m || (!m[1] && !m[2])) return null;
  if (!m[1]) {
    const n = Number(m[2]);
    return n > 0 && size > 0 ? { start: Math.max(0, size - n), end: size - 1 } : 'unsatisfiable';
  }
  const start = Number(m[1]);
  if (m[2] && Number(m[2]) < start) return null;
  if (start >= size) return 'unsatisfiable';
  return { start, end: m[2] ? Math.min(Number(m[2]), size - 1) : size - 1 };
}

// answers GET/HEAD for a file path or a Buffer with Range support (206, 416); headers carry type and security headers
export function sendRanged(req, res, headers, body, size = body.length) {
  const range = byteRange(req.headers.range, size);
  const common = { ...headers, 'Accept-Ranges': 'bytes' };
  if (range === 'unsatisfiable') {
    res.writeHead(416, { ...common, 'Content-Range': `bytes */${size}`, 'Content-Length': 0 });
    return res.end();
  }
  const { start, end } = range ?? { start: 0, end: size - 1 };
  res.writeHead(range ? 206 : 200, {
    ...common, 'Content-Length': size ? end - start + 1 : 0, ...(range && { 'Content-Range': `bytes ${start}-${end}/${size}` }),
  });
  if (req.method === 'HEAD' || !size) return res.end();
  if (Buffer.isBuffer(body)) return res.end(body.subarray(start, end + 1));
  createReadStream(body, { start, end }).pipe(res);
}

export async function serveCdn(req, res, pathname) {
  let file, type, disposition, cache = 'public, max-age=31536000, immutable';
  const roleIcon = ROLE_ICON_PATH.exec(pathname);
  if (roleIcon) pathname = `/role-icons/${roleIcon[1]}/${roleIcon[2]}`;
  const decoration = DECORATION_PATH.exec(pathname);
  const img = IMAGE_PATH.exec(pathname);
  const asset = ASSET_PATH.exec(pathname);
  const memberImg = MEMBER_IMAGE_PATH.exec(pathname);
  if (decoration) {
    if (!get('SELECT 1 FROM guild_decorations WHERE asset = ?', decoration[1])) throw new HttpError(404, 0, '404: Not Found');
    file = join(DATA_DIR, 'avatar-decorations', decoration[1]);
    type = await headType(file);
    disposition = 'inline';
  } else if (memberImg) {
    const [, guildId, userId, kind, hash] = memberImg;
    const col = kind === 'avatars' ? 'avatar' : 'banner';
    if (!get(`SELECT 1 FROM members WHERE guild_id = ? AND user_id = ? AND ${col} = ?`, guildId, userId, hash)) throw new HttpError(404, 0, '404: Not Found');
    file = join(DATA_DIR, `member-${kind}`, guildId, userId, hash);
    type = await headType(file);
    disposition = 'inline';
  } else if (img) {
    const [, kind, id, hash] = img;
    if (!IMAGE_OWNER[kind](id, hash)) throw new HttpError(404, 0, '404: Not Found');
    file = join(DATA_DIR, kind, id, hash);
    type = await headType(file);
    disposition = 'inline';
  } else if (asset) {
    const [, kind, id] = asset;
    if (!get(`SELECT 1 FROM ${ASSET_TABLE[kind]} = ?`, id)) throw new HttpError(404, 0, '404: Not Found');
    file = join(DATA_DIR, kind, id);
    type = await headType(file);
    disposition = 'inline';
  } else {
    const [, channelId, id, sig, name] = ATTACHMENT_PATH.exec(pathname);
    const a = get('SELECT * FROM attachments WHERE id = ? AND channel_id = ?', id, channelId);
    if (!a || name !== a.filename || (sig ? sig !== attachmentSig(channelId, id) : !a.legacy_url)) throw new HttpError(404, 0, '404: Not Found');
    file = join(DATA_DIR, 'attachments', channelId, id);
    type = a.content_type;
    disposition = `${INLINE.has(type) ? 'inline' : 'attachment'}; filename="${a.filename}"`;
    // shared caches must not keep attachments (they outlive deletion); view-once is never stored and goes on the first full GET
    cache = 'private, max-age=31536000, immutable';
    if (a.flags & 16) {
      cache = 'no-store';
      // shortcut: Range reads leave it in place (players seek); a recipient can keep the bytes anyway, view-once is client-honoured
      if (req.method === 'GET' && !req.headers.range) {
        if (!run('DELETE FROM attachments WHERE id = ?', a.id).changes) throw new HttpError(404, 0, '404: Not Found');
        res.on('close', () => removeAttachment(channelId, id));
      }
    }
  }
  const { size } = await stat(file);
  sendRanged(req, res, {
    ...SECURITY, 'Content-Type': type, 'Content-Disposition': disposition, 'Cache-Control': cache,
  }, file, size);
}
