// v6 customization: display name styles, avatar decorations (built-in and server-uploaded), nameplates, profile themes,
// effects and widgets, server tags (guild profile), user sounds and the chat background
import { snowflake } from '../snowflake.js';
import { randomBytes } from 'node:crypto';
import { get, all, run, json, audienceOf, memberIds, isMember, userById, userObj, guildObj } from '../db.js';
import { HttpError, str, invalid, notFound } from '../errors.js';
import { P } from '../permissions.js';
import { sendToUsers, guildParts, presences } from '../gateway.js';
import { dataUri, saveAsset, removeAsset, saveImage, removeImage } from '../files.js';
import { audioDuration } from '../audio.js';
import { settingsOf, saveSettings } from '../userdata.js';
import { audit, A, diff } from '../audit.js';
import { loadGuild } from './guilds.js';

const fail = (field, message, code = 'BASE_TYPE_BAD_VALUE') => { throw invalid(field, code, message); };
const PRESET = /^[a-z][a-z0-9_-]{0,39}$/; // built-in collectibles are named by the client's own library
const SNOWFLAKE = /^\d{1,19}$/;
const COLOR = (v, f) => (Number.isInteger(v) && v >= 0 && v <= 0xffffff ? v : fail(f, 'Must be a colour integer 0-16777215.'));
const HEX = (v, f) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : fail(f, 'Must be a hex colour like #5865f2.'));

// --- display name styles (user docs: Display Name Style; fonts and effects per the docs' tables) ----------------------
const FONTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 100, 101, 102]; // 100-102: Cillhub's bundled Inter, JetBrains Mono, OpenDyslexic
const EFFECTS = [1, 2, 3, 4, 5, 6, 7, 8];
// display_name_font_id / _effect_id / _colors of a user or member PATCH: undefined (untouched), null (cleared) or the object
export function nameStyles(body, current) {
  const keys = ['display_name_font_id', 'display_name_effect_id', 'display_name_colors'];
  if (keys.every(k => body[k] === undefined)) return undefined;
  if (keys.every(k => body[k] === null || body[k] === undefined) && keys.some(k => body[k] === null)) return null;
  const font = body.display_name_font_id ?? current?.font_id ?? 11;
  const effect = body.display_name_effect_id ?? current?.effect_id ?? 1;
  const colors = body.display_name_colors ?? current?.colors ?? [];
  if (!FONTS.includes(font)) fail('display_name_font_id', 'Unknown display name font.');
  if (!EFFECTS.includes(effect)) fail('display_name_effect_id', 'Unknown display name effect.');
  if (!Array.isArray(colors) || colors.length > 2) fail('display_name_colors', 'At most 2 colours ([] = only the font).');
  return { font_id: font, effect_id: effect, colors: colors.map((c, i) => COLOR(c, `display_name_colors.${i}`)) };
}

// --- profile widgets (Cillhub extra) --------------------------------------------------------------------------------------
const SOCIAL_HOSTS = {
  twitch: ['twitch.tv'], youtube: ['youtube.com', 'youtu.be'], x: ['x.com', 'twitter.com'], instagram: ['instagram.com'],
  tiktok: ['tiktok.com'], steam: ['steamcommunity.com', 'store.steampowered.com'], faceit: ['faceit.com'],
};
export function socialUrl(platform, value, f) {
  if (!Object.hasOwn(SOCIAL_HOSTS, platform)) fail(`${f}.platform`, `Must be one of ${Object.keys(SOCIAL_HOSTS).join(', ')}.`);
  let u;
  try { u = new URL(String(value)); } catch { fail(`${f}.url`, 'Must be a https link.'); }
  if (typeof value !== 'string' || value.length > 256 || u.protocol !== 'https:' || u.username || u.password || u.port) fail(`${f}.url`, 'Must be a https link of at most 256 characters without credentials or port.');
  const host = u.hostname.toLowerCase().replace(/^(www|m)\./, '');
  if (!SOCIAL_HOSTS[platform].includes(host)) fail(`${f}.url`, `A ${platform} link must point to ${SOCIAL_HOSTS[platform].join(' or ')}.`);
  return u.href;
}
const text = (v, f, max) => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : fail(f, `Must be 1 to ${max} characters.`));
function widgets(v) {
  if (!Array.isArray(v) || v.length > 3) fail('widgets', 'At most 3 widgets.');
  const seen = new Set();
  return v.map((w, i) => {
    const f = `widgets.${i}`;
    if (seen.has(w?.type)) fail(`${f}.type`, 'Each widget type at most once.');
    seen.add(w?.type);
    if (w?.type === 'main_game') return { type: 'main_game', game: text(w.game, `${f}.game`, 64) };
    if (w?.type === 'rank') return { type: 'rank', game: text(w.game, `${f}.game`, 64), rank: text(w.rank, `${f}.rank`, 64) };
    if (w?.type === 'socials') {
      if (!Array.isArray(w.links) || !w.links.length || w.links.length > 7) fail(`${f}.links`, 'Between 1 and 7 links.');
      const platforms = new Set();
      return {
        type: 'socials', links: w.links.map((l, j) => {
          if (platforms.has(l?.platform)) fail(`${f}.links.${j}.platform`, 'One link per platform.');
          platforms.add(l?.platform);
          return { platform: l.platform, url: socialUrl(l?.platform, l?.url, `${f}.links.${j}`) };
        }),
      };
    }
    return fail(`${f}.type`, 'Must be main_game, socials or rank.');
  });
}

const PALETTES = ['none', 'crimson', 'berry', 'sky', 'teal', 'forest', 'bubble_gum', 'violet', 'cobalt', 'clover', 'lemon', 'white'];
const decorationObj = d => ({ id: d.id, guild_id: d.guild_id, name: d.name, asset: d.asset, sku_id: d.id });

// the user's customization document after a PATCH /users/@me body (null when nothing in it applies)
export function customizationPatch(body, user) {
  const c = json(user.customization, {});
  const before = JSON.stringify(c);
  const styles = nameStyles(body, c.display_name_styles);
  if (styles !== undefined) c.display_name_styles = styles;
  if (body.avatar_decoration_sku_id !== undefined) {
    const v = body.avatar_decoration_sku_id;
    if (v === null) c.avatar_decoration_data = null;
    else if (typeof v === 'string' && SNOWFLAKE.test(v)) {
      const d = get('SELECT * FROM guild_decorations WHERE id = ?', v);
      if (!d || !isMember(d.guild_id, user.id)) fail('avatar_decoration_sku_id', 'Unknown avatar decoration.');
      c.avatar_decoration_data = { asset: d.asset, sku_id: d.id, expires_at: null, guild_id: d.guild_id };
    } else if (typeof v === 'string' && PRESET.test(v)) c.avatar_decoration_data = { asset: v, sku_id: '0', expires_at: null };
    else fail('avatar_decoration_sku_id', 'Must be a server decoration id, a built-in decoration name or null.');
  }
  if (body.nameplate_sku_id !== undefined || body.nameplate_palette !== undefined) {
    const v = body.nameplate_sku_id === undefined ? c.collectibles?.nameplate?.asset ?? null : body.nameplate_sku_id;
    const palette = body.nameplate_palette ?? c.collectibles?.nameplate?.palette ?? 'none';
    if (!PALETTES.includes(palette)) fail('nameplate_palette', `Must be one of ${PALETTES.join(', ')}.`);
    if (v !== null && !(typeof v === 'string' && PRESET.test(v))) fail('nameplate_sku_id', 'Must be a built-in nameplate name or null.');
    c.collectibles = v === null ? null : { nameplate: { asset: v, sku_id: '0', label: v, palette, expires_at: null } };
  }
  if (body.theme_colors !== undefined) {
    const v = body.theme_colors;
    if (v !== null && !(Array.isArray(v) && v.length === 2)) fail('theme_colors', 'Must be two colours or null.');
    c.theme_colors = v && v.map((x, i) => COLOR(x, `theme_colors.${i}`));
  }
  if (body.profile_effect_id !== undefined) {
    const v = body.profile_effect_id;
    if (v !== null && !(typeof v === 'string' && PRESET.test(v))) fail('profile_effect_id', 'Must be a built-in profile effect name or null.');
    c.profile_effect = v && { id: v, expires_at: null };
  }
  if (body.widgets !== undefined) c.widgets = body.widgets === null ? [] : widgets(body.widgets);
  return JSON.stringify(c) === before ? null : JSON.stringify(c);
}

export const announceUser = userId => {
  const u = userById(userId);
  sendToUsers(audienceOf(userId), 'USER_UPDATE', id => userObj(u, id === userId));
};

// --- server-uploaded avatar decorations (MANAGE_GUILD_EXPRESSIONS; APNG/PNG/WebP up to 512 KiB) -------------------------
const decorationsOf = guildId => all('SELECT * FROM guild_decorations WHERE guild_id = ? ORDER BY rowid', guildId).map(decorationObj);
guildParts.push(g => ({ avatar_decorations: decorationsOf(g.id) }));
const decorationsUpdate = guildId => sendToUsers(memberIds(guildId), 'GUILD_AVATAR_DECORATIONS_UPDATE', { guild_id: guildId, avatar_decorations: decorationsOf(guildId) });

async function createDecoration(ctx) {
  const g = loadGuild(ctx.params.id, ctx.user, P.MANAGE_GUILD_EXPRESSIONS);
  const name = str(ctx.body, 'name', 2, 32);
  const { bytes } = dataUri(ctx.body.image, 'image', ['image/png', 'image/webp'], 512 * 1024);
  if (get('SELECT COUNT(*) AS n FROM guild_decorations WHERE guild_id = ?', g.id).n >= 50) throw new HttpError(400, 30008, 'Maximum number of avatar decorations reached (50)');
  const id = snowflake();
  const asset = randomBytes(16).toString('hex');
  await saveAsset('avatar-decorations', asset, bytes);
  run('INSERT INTO guild_decorations (id, guild_id, name, asset, user_id) VALUES (?, ?, ?, ?, ?)', id, g.id, name, asset, ctx.user.id);
  audit(ctx, g.id, A.GUILD_UPDATE, g.id, { changes: [{ key: 'avatar_decoration_create', new_value: { id, name } }] });
  decorationsUpdate(g.id);
  ctx.status = 201;
  return decorationObj(get('SELECT * FROM guild_decorations WHERE id = ?', id));
}

// whoever wears one of these decorations goes back to none
export function unequipDecorations(ids) {
  for (const id of ids) {
    for (const u of all("SELECT id FROM users WHERE json_extract(customization, '$.avatar_decoration_data.sku_id') = ?", id)) {
      run("UPDATE users SET customization = json_set(customization, '$.avatar_decoration_data', json('null')) WHERE id = ?", u.id);
      announceUser(u.id);
    }
  }
}

function deleteDecoration(ctx) {
  const g = loadGuild(ctx.params.id, ctx.user, P.MANAGE_GUILD_EXPRESSIONS);
  const d = get('SELECT * FROM guild_decorations WHERE id = ? AND guild_id = ?', ctx.params.decoration_id, g.id);
  if (!d) throw notFound(10000, 'Avatar Decoration');
  run('DELETE FROM guild_decorations WHERE id = ?', d.id);
  removeAsset('avatar-decorations', d.asset);
  unequipDecorations([d.id]);
  audit(ctx, g.id, A.GUILD_UPDATE, g.id, { changes: [{ key: 'avatar_decoration_delete', old_value: { id: d.id, name: d.name } }] });
  decorationsUpdate(g.id);
}

// --- guild profile and server tag (user docs: discovery.mdx Guild Profile; MANAGE_GUILD) ---------------------------------
const TAG = /^[\p{L}\p{N}]{2,4}$/u;
function profileObj(g) {
  const p = json(g.profile, {});
  return {
    id: g.id, name: g.name, icon_hash: g.icon, member_count: memberIds(g.id).length, online_count: presences(memberIds(g.id)).length,
    description: g.description ?? '', brand_color_primary: p.brand_color_primary ?? null, banner_hash: null, game_application_ids: [],
    game_activity: {}, tag: p.tag ?? null, badge: p.badge ?? 0, badge_color_primary: p.badge_color_primary ?? null,
    badge_color_secondary: p.badge_color_secondary ?? null, badge_hash: p.badge_hash ?? null, traits: [],
    features: guildObj(g).features, visibility: 2, custom_banner_hash: null, premium_subscription_count: 0, premium_tier: 0,
  };
}

async function patchProfile(ctx) {
  const g = loadGuild(ctx.params.id, ctx.user, P.MANAGE_GUILD);
  const body = ctx.body ?? {};
  const p = json(g.profile, {});
  const before = { ...p };
  if (body.brand_color_primary !== undefined) p.brand_color_primary = body.brand_color_primary === null ? null : HEX(body.brand_color_primary, 'brand_color_primary');
  if (body.tag !== undefined) p.tag = body.tag === null || body.tag === '' ? null : (typeof body.tag === 'string' && TAG.test(body.tag) ? body.tag : fail('tag', 'A tag is 2 to 4 letters or digits.'));
  if (body.badge !== undefined) p.badge = Number.isInteger(body.badge) && body.badge >= 0 && body.badge <= 40 ? body.badge : fail('badge', 'Must be a badge type 0-40.');
  for (const k of ['badge_color_primary', 'badge_color_secondary']) if (body[k] !== undefined) p[k] = body[k] === null ? null : HEX(body[k], k);
  if (body.badge_image !== undefined) {
    // Cillhub extra: an uploaded badge icon (PNG/WebP up to 256 KiB) instead of a built-in badge type
    p.badge_hash = body.badge_image === null ? null : await saveBadge(body.badge_image, g.id);
  }
  run('UPDATE guilds SET profile = ? WHERE id = ?', JSON.stringify(p), g.id);
  if (before.badge_hash && before.badge_hash !== p.badge_hash) removeImage('guild-tag-badges', g.id, before.badge_hash);
  const after = get('SELECT * FROM guilds WHERE id = ?', g.id);
  audit(ctx, g.id, A.GUILD_UPDATE, g.id, { changes: diff(before, p, ['brand_color_primary', 'tag', 'badge', 'badge_color_primary', 'badge_color_secondary', 'badge_hash']) });
  sendToUsers(memberIds(g.id), 'GUILD_UPDATE', guildObj(after));
  if (['tag', 'badge', 'badge_hash', 'badge_color_primary', 'badge_color_secondary'].some(k => before[k] !== p[k])) {
    for (const u of all("SELECT id FROM users WHERE json_extract(customization, '$.primary_guild_id') = ?", g.id)) announceUser(u.id);
  }
  return profileObj(after);
}

function saveBadge(value, guildId) {
  dataUri(value, 'badge_image', ['image/png', 'image/webp'], 256 * 1024); // smaller and stricter than saveImage's own check
  return saveImage(value, 'badge_image', 'guild-tag-badges', guildId);
}

// PUT /users/@me/clan (user docs: Set Guild Identity) -> the user object
function setIdentity({ body, user }) {
  const enabled = body?.identity_enabled;
  const guildId = body?.identity_guild_id;
  const c = json(user.customization, {});
  if (enabled === false || guildId === null) c.primary_guild_id = null;
  else if (guildId !== undefined) {
    const g = typeof guildId === 'string' && SNOWFLAKE.test(guildId) && get('SELECT * FROM guilds WHERE id = ?', guildId);
    if (!g || !isMember(g.id, user.id)) fail('identity_guild_id', 'Unknown guild.');
    if (!json(g.profile, {}).tag) fail('identity_guild_id', 'This server has no tag.');
    c.primary_guild_id = g.id;
  }
  run('UPDATE users SET customization = ? WHERE id = ?', JSON.stringify(c), user.id);
  announceUser(user.id);
  return userObj(userById(user.id), true);
}

// --- user sounds (OGG/MP3, at most 5 s and 256 KiB, 20 per user) ---------------------------------------------------------
const soundObj = s => ({ id: s.id, name: s.name, volume: s.volume, user_id: s.user_id, url: `/user-sounds/${s.id}` });

async function createSound(ctx) {
  const name = str(ctx.body, 'name', 1, 32);
  const volume = ctx.body.volume ?? 1;
  if (typeof volume !== 'number' || volume < 0 || volume > 1) fail('volume', 'Volume is between 0 and 1.', 'NUMBER_TYPE_COERCE');
  const { bytes, type } = dataUri(ctx.body.sound, 'sound', ['audio/mpeg', 'audio/ogg'], 256 * 1024);
  const seconds = audioDuration(bytes, type);
  if (seconds == null || seconds > 5) fail('sound', 'Sounds are readable MP3 or Ogg files of at most 5 seconds.', 'SOUND_INVALID');
  if (get('SELECT COUNT(*) AS n FROM user_sounds WHERE user_id = ?', ctx.user.id).n >= 20) throw new HttpError(400, 30045, 'Maximum number of sounds reached (20)');
  const id = snowflake();
  await saveAsset('user-sounds', id, bytes);
  run('INSERT INTO user_sounds (id, user_id, name, volume) VALUES (?, ?, ?, ?)', id, ctx.user.id, name, volume);
  ctx.status = 201;
  return soundObj(get('SELECT * FROM user_sounds WHERE id = ?', id));
}

function deleteSound({ params, user }) {
  const s = get('SELECT * FROM user_sounds WHERE id = ? AND user_id = ?', params.sound_id, user.id);
  if (!s) throw notFound(10097, 'Sound');
  run('DELETE FROM user_sounds WHERE id = ?', s.id);
  removeAsset('user-sounds', s.id);
  if (settingsOf(user.id).entrance_sound?.sound_id === s.id) {
    saveSettings(user.id, { entrance_sound: null });
    sendToUsers([user.id], 'USER_SETTINGS_UPDATE', { entrance_sound: null });
  }
}

// --- chat background (own upload, shown only in the user's own client) ---------------------------------------------------
async function putChatBackground(ctx, clear = false) {
  const old = settingsOf(ctx.user.id).chat_background;
  const hash = clear ? null : await saveImage(ctx.body?.image, 'image', 'chat-backgrounds', ctx.user.id);
  saveSettings(ctx.user.id, { chat_background: hash });
  if (old && old !== hash) removeImage('chat-backgrounds', ctx.user.id, old);
  sendToUsers([ctx.user.id], 'USER_SETTINGS_UPDATE', { chat_background: hash });
  return { chat_background: hash };
}

export const user = { userOnly: true };
export default [
  ['GET', '/guilds/:id/avatar-decorations', ({ params, user: me }) => decorationsOf(loadGuild(params.id, me).id)],
  ['POST', '/guilds/:id/avatar-decorations', createDecoration, { maxBody: 1024 * 1024 }],
  ['DELETE', '/guilds/:id/avatar-decorations/:decoration_id', deleteDecoration],
  ['GET', '/guilds/:id/profile', ({ params, user: me }) => profileObj(loadGuild(params.id, me))],
  ['PATCH', '/guilds/:id/profile', patchProfile],
  ['PUT', '/users/@me/clan', setIdentity, user],
  ['GET', '/users/@me/sounds', ({ user: me }) => all('SELECT * FROM user_sounds WHERE user_id = ? ORDER BY rowid', me.id).map(soundObj), user],
  ['POST', '/users/@me/sounds', createSound, user],
  ['DELETE', '/users/@me/sounds/:sound_id', deleteSound, user],
  ['PUT', '/users/@me/chat-background', putChatBackground, { ...user, maxBody: 12 * 1024 * 1024 }],
  ['DELETE', '/users/@me/chat-background', async ctx => { await putChatBackground(ctx, true); }, user],
];
