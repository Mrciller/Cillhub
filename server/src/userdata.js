// The user settings document, user guild settings and notes: storage, defaults and validation
import { get, all, run, json } from './db.js';
import { invalid } from './errors.js';

const SNOWFLAKE = /^\d{1,19}$/;
const fail = (field, message) => { throw invalid(field, 'BASE_TYPE_BAD_VALUE', message); };
const oneOf = (...vals) => (v, f) => (vals.includes(v) ? v : fail(f, `Must be one of ${vals.join(', ')}.`));
const boolean = (v, f) => (typeof v === 'boolean' ? v : fail(f, 'Must be a boolean.'));
const intIn = (min, max) => (v, f) => (Number.isInteger(v) && v >= min && v <= max ? v : fail(f, `Must be an integer between ${min} and ${max}.`));
const strOrNull = max => (v, f) => (v === null || (typeof v === 'string' && v.length <= max) ? v || null : fail(f, `Must be a string of at most ${max} characters or null.`));
const isoOrNull = (v, f) => (v === null ? null : typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : fail(f, 'Must be an ISO8601 timestamp or null.'));
const snowflakeList = max => (v, f) => (Array.isArray(v) && v.length <= max && v.every(x => typeof x === 'string' && SNOWFLAKE.test(x)) ? [...new Set(v)] : fail(f, 'Must be a list of snowflakes.'));

function customStatus(v, f) {
  if (v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) fail(f, 'Must be a custom status object or null.');
  const out = {
    text: strOrNull(128)(v.text ?? null, `${f}.text`),
    emoji_id: v.emoji_id == null ? null : SNOWFLAKE.test(String(v.emoji_id)) ? String(v.emoji_id) : fail(`${f}.emoji_id`, 'Not a snowflake.'),
    emoji_name: strOrNull(32)(v.emoji_name ?? null, `${f}.emoji_name`),
    expires_at: isoOrNull(v.expires_at ?? null, `${f}.expires_at`),
  };
  return out.text || out.emoji_id || out.emoji_name ? out : null;
}

function guildFolders(v, f) {
  if (!Array.isArray(v) || v.length > 200) fail(f, 'Must be a list of guild folders.');
  return v.map((x, i) => ({
    id: x?.id == null ? null : intIn(0, 2 ** 31)(x.id, `${f}.${i}.id`),
    guild_ids: snowflakeList(200)(x?.guild_ids, `${f}.${i}.guild_ids`),
    name: strOrNull(100)(x?.name ?? null, `${f}.${i}.name`),
    color: x?.color == null ? null : intIn(0, 0xffffff)(x.color, `${f}.${i}.color`),
  }));
}

// --- v6 personal appearance -------------------------------------------------------------------------------------
const HEX = /^#[0-9a-f]{6}$/i;
const KEY = /^[a-z][a-z0-9_]{0,47}$/;
const hexColor = (v, f) => (typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : fail(f, 'Must be a hex colour like #1e1f22.'));
const keyName = max => (v, f) => (typeof v === 'string' && v.length <= max && /^[\w:-]+$/.test(v) ? v : fail(f, `Must be an id of at most ${max} letters, digits, _, - or :.`));
const nullable = check => (v, f) => (v === null ? null : check(v, f));
const numIn = (min, max) => (v, f) => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : fail(f, `Must be a number between ${min} and ${max}.`));

// a custom theme: id and name, every other value a hex colour, a list of at most 2 hex colours (gradient) or null,
// one level of nesting allowed (e.g. colors: {...}); at most 24 keys per object
function themeValues(v, f, depth = 0) {
  if (typeof v !== 'object' || v === null || Array.isArray(v) || Object.keys(v).length > 24) fail(f, 'Must be a theme object of at most 24 keys.');
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    const at = `${f}.${k}`;
    if (!KEY.test(k)) fail(at, 'Unknown theme key.');
    if (depth === 0 && k === 'id') out.id = keyName(64)(x, at);
    else if (depth === 0 && k === 'name') out.name = typeof x === 'string' && x.trim().length >= 1 && x.length <= 32 ? x.trim() : fail(at, 'Must be 1 to 32 characters.');
    else if (x === null) out[k] = null;
    else if (Array.isArray(x)) out[k] = x.length <= 2 ? x.map((c, i) => hexColor(c, `${at}.${i}`)) : fail(at, 'At most 2 colours.');
    else if (typeof x === 'object') out[k] = depth === 0 ? themeValues(x, at, 1) : fail(at, 'Nested too deep.');
    else out[k] = hexColor(x, at);
  }
  return out;
}
function customThemes(v, f) {
  if (!Array.isArray(v) || v.length > 10) fail(f, 'Must be a list of at most 10 themes.');
  const out = v.map((t, i) => themeValues(t, `${f}.${i}`));
  out.forEach((t, i) => { if (!t.id || !t.name) fail(`${f}.${i}`, 'Every theme needs an id and a name.'); });
  if (new Set(out.map(t => t.id)).size !== out.length) fail(f, 'Theme ids must be unique.');
  return out;
}
const CSS_MAX = 50 * 1024;
const customCss = (v, f) => (v === null ? null : typeof v === 'string' && Buffer.byteLength(v) <= CSS_MAX ? v || null : fail(f, 'Must be at most 50 KB of CSS or null.'));

// {muted?, volume?, events: {<event>: {sound: built-in id | "user:<id>" | null, volume: 0-100}}}
function soundSettings(v, f) {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(f, 'Must be a sound settings object.');
  const out = { muted: v.muted === undefined ? false : boolean(v.muted, `${f}.muted`), volume: v.volume === undefined ? 100 : intIn(0, 100)(v.volume, `${f}.volume`), events: {} };
  const events = v.events ?? {};
  if (typeof events !== 'object' || Array.isArray(events) || Object.keys(events).length > 32) fail(`${f}.events`, 'At most 32 events.');
  for (const [k, e] of Object.entries(events)) {
    const at = `${f}.events.${k}`;
    if (!KEY.test(k) || typeof e !== 'object' || e === null) fail(at, 'Must be {sound, volume}.');
    out.events[k] = { sound: e.sound == null ? null : keyName(64)(e.sound, `${at}.sound`), volume: e.volume === undefined ? 100 : intIn(0, 100)(e.volume, `${at}.volume`) };
  }
  for (const k of Object.keys(v)) if (!['muted', 'volume', 'events'].includes(k)) fail(`${f}.${k}`, 'Unknown sound setting.');
  return out;
}

// action -> key combination (e.g. "ctrl+shift+m"), null = unbound
function keybinds(v, f) {
  if (typeof v !== 'object' || v === null || Array.isArray(v) || Object.keys(v).length > 64) fail(f, 'Must be a map of at most 64 keybinds.');
  return Object.fromEntries(Object.entries(v).map(([k, combo]) => {
    if (!/^[a-z][a-z0-9_-]{0,47}$/.test(k)) fail(`${f}.${k}`, 'Unknown action name.');
    return [k, combo === null ? null : typeof combo === 'string' && combo.length >= 1 && combo.length <= 64 ? combo : fail(`${f}.${k}`, 'Must be a key combination of at most 64 characters or null.')];
  }));
}

// {sound_id, guild_id}: a soundboard sound of a server you are in, or {sound_id, guild_id: null}: one of your own sounds
function entranceSound(v, f, userId) {
  if (v === null) return null;
  if (typeof v !== 'object' || !SNOWFLAKE.test(String(v.sound_id ?? ''))) fail(f, 'Must be {sound_id, guild_id} or null.');
  const soundId = String(v.sound_id);
  if (v.guild_id == null) {
    if (!get('SELECT 1 FROM user_sounds WHERE id = ? AND user_id = ?', soundId, userId)) fail(`${f}.sound_id`, 'Unknown sound.');
    return { sound_id: soundId, guild_id: null };
  }
  const guildId = String(v.guild_id);
  if (!get(`SELECT 1 FROM soundboard_sounds s JOIN members m ON m.guild_id = s.guild_id AND m.user_id = ?
            WHERE s.sound_id = ? AND s.guild_id = ?`, userId, soundId, guildId)) fail(`${f}.sound_id`, 'Unknown sound.');
  return { sound_id: soundId, guild_id: guildId };
}

function privacySettings(v, f) {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(f, 'Must be a privacy object.');
  const out = {};
  if (v.dm_read_receipts !== undefined) out.dm_read_receipts = boolean(v.dm_read_receipts, `${f}.dm_read_receipts`);
  return out;
}

// favourite GIFs, newest first: url = the link that is sent (unique key, https); src = what is shown, https or our own
// root-relative media path (GIF search answers /external/<token>, attachments /attachments/...); width/height 0 = unknown
const MEDIA_PATH = /^\/(external|attachments)\/[^\s?#\\]+$/;
const isHttps = v => { try { return new URL(v).protocol === 'https:'; } catch { return false; } };
const link = local => (v, f) => (typeof v === 'string' && v.length <= 2048 && ((/^https:\/\/\S+$/.test(v) && isHttps(v)) || (local && MEDIA_PATH.test(v)))
  ? v : fail(f, local ? 'Must be an https URL or a /external/ or /attachments/ path of at most 2048 characters.' : 'Must be an https URL of at most 2048 characters.'));
function favoriteGifs(v, f) {
  if (!Array.isArray(v) || v.length > 250) fail(f, 'Must be a list of at most 250 GIFs.');
  const seen = new Set();
  return v.map((g, i) => {
    const at = `${f}.${i}`;
    if (typeof g !== 'object' || g === null || Array.isArray(g)) fail(at, 'Must be {url, src, width, height, format}.');
    return {
      url: link(false)(g.url, `${at}.url`), src: link(true)(g.src, `${at}.src`),
      width: intIn(0, 10000)(g.width, `${at}.width`), height: intIn(0, 10000)(g.height, `${at}.height`),
      format: oneOf('gif', 'mp4', 'webm', 'image')(g.format, `${at}.format`),
    };
  }).filter(g => !seen.has(g.url) && seen.add(g.url));
}

// the allow-list: the documented user settings names where they exist, Cillhub's own keys for the rest
const SETTINGS = {
  privacy: [privacySettings, { dm_read_receipts: true }],
  custom_themes: [customThemes, []],
  active_theme: [nullable(keyName(64)), null],
  custom_css: [customCss, null],
  custom_css_enabled: [boolean, false],
  chat_font: [keyName(32), 'system'],
  chat_line_height: [numIn(1, 3), 1.375],
  message_spacing: [intIn(0, 32), 16],
  chat_background: [(v, f) => (v === null ? null : fail(f, 'Upload with PUT /users/@me/chat-background; only null clears it here.')), null],
  chat_background_opacity: [intIn(0, 100), 30],
  default_emoji_skin_tone: [intIn(0, 5), 0],
  show_avatars: [boolean, true],
  show_timestamps: [boolean, true],
  sound_settings: [soundSettings, { muted: false, volume: 100, events: {} }],
  entrance_sound: [entranceSound, null],
  keybinds: [keybinds, {}],
  theme: [oneOf('dark', 'light', 'ash', 'onyx'), 'dark'],
  message_display_compact: [boolean, false],
  font_size: [intIn(12, 24), 16],
  zoom: [intIn(50, 200), 100],
  reduced_motion: [oneOf('auto', 'on', 'off'), 'auto'],
  saturation: [intIn(0, 100), 100],
  render_embeds: [boolean, true], // show embeds
  inline_embed_media: [boolean, true], // show link previews (images and videos from links)
  inline_attachment_media: [boolean, true],
  render_reactions: [boolean, true],
  gif_auto_play: [boolean, true],
  favorite_gifs: [favoriteGifs, []],
  animate_emoji: [(v, f) => (typeof v === 'boolean' ? v : oneOf('always', 'hover', 'never')(v, f)), true],
  animate_stickers: [oneOf(0, 1, 2, 'always', 'hover', 'never'), 0],
  convert_emoticons: [boolean, true],
  developer_mode: [boolean, false],
  locale: [oneOf('en-US', 'de'), 'en-US'],
  timestamp_hour_cycle: [oneOf('auto', 'h12', 'h23'), 'auto'],
  show_current_game: [boolean, true],
  guild_folders: [guildFolders, []],
  guild_positions: [snowflakeList(200), []],
  status: [oneOf('online', 'idle', 'dnd', 'invisible'), 'online'],
  custom_status: [customStatus, null],
};

const stored = userId => get('SELECT settings, status FROM users WHERE id = ?', userId);

// the full document: defaults, what was saved, and the live status column
export function settingsOf(userId) {
  const row = stored(userId);
  const out = Object.fromEntries(Object.entries(SETTINGS).map(([k, [, d]]) => [k, d]));
  Object.assign(out, json(row?.settings, {}), { status: row?.status ?? 'online' });
  return out;
}

// validates a PATCH body against the allow-list; returns only the changed keys
export function settingsPatch(body, userId) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw invalid('_root', 'MODEL_TYPE_CONVERT', 'Must be an object.');
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    if (!Object.hasOwn(SETTINGS, k)) throw invalid(k, 'UNKNOWN_SETTING', 'This setting does not exist.');
    out[k] = SETTINGS[k][0](v, k, userId);
  }
  return out;
}

export function saveSettings(userId, changes) {
  const { status, ...rest } = changes;
  const doc = { ...json(stored(userId).settings, {}), ...rest };
  run('UPDATE users SET settings = ? WHERE id = ?', JSON.stringify(doc), userId);
  if (status) run('UPDATE users SET status = ? WHERE id = ?', status, userId);
}

const live = cs => cs && (!cs.expires_at || cs.expires_at > new Date().toISOString());
export function customStatusActivity(userId) {
  const cs = json(stored(userId)?.settings, {}).custom_status;
  if (!live(cs)) return null;
  return {
    type: 4, name: 'Custom Status', ...(cs.text && { state: cs.text }),
    ...((cs.emoji_name || cs.emoji_id) && { emoji: { name: cs.emoji_name, ...(cs.emoji_id && { id: cs.emoji_id }) } }),
  };
}

// users whose custom status has expired (for the expiry timer) and when the next one does
export const nextCustomStatusExpiry = () => {
  const r = get("SELECT MIN(json_extract(settings, '$.custom_status.expires_at')) AS t FROM users WHERE json_extract(settings, '$.custom_status.expires_at') IS NOT NULL");
  return r?.t ? Date.parse(r.t) : null;
};
export const expiredCustomStatus = now => all(
  "SELECT id FROM users WHERE json_extract(settings, '$.custom_status.expires_at') <= ?", new Date(now).toISOString(),
).map(r => r.id);

// --- user guild settings -----------------------------------------------------------------------------------------
const MUTE_FIELDS = (v, f) => {
  if (v === null) return null;
  if (typeof v !== 'object') fail(f, 'Must be a mute config or null.');
  return { end_time: isoOrNull(v.end_time ?? null, `${f}.end_time`), selected_time_window: v.selected_time_window == null ? -1 : intIn(-1, 2 ** 31)(v.selected_time_window, `${f}.selected_time_window`) };
};
const GUILD_FIELDS = {
  suppress_everyone: boolean, suppress_roles: boolean, mute_scheduled_events: boolean, message_notifications: oneOf(0, 1, 2),
  flags: intIn(0, 2 ** 31), mobile_push: boolean, muted: boolean, mute_config: MUTE_FIELDS, hide_muted_channels: boolean,
  notify_highlights: oneOf(0, 1, 2),
};
const OVERRIDE_FIELDS = { collapsed: boolean, flags: intIn(0, 2 ** 31), message_notifications: oneOf(0, 1, 2, 3), muted: boolean, mute_config: MUTE_FIELDS };

const guildDefaults = key => ({
  guild_id: key === '@me' ? null : key, suppress_everyone: false, suppress_roles: false, mute_scheduled_events: false,
  message_notifications: 0, flags: 0, mobile_push: true, muted: false, mute_config: null, hide_muted_channels: false,
  channel_overrides: [], notify_highlights: 0, version: 0,
});

export function guildSettingsOf(userId, key) {
  const row = get('SELECT settings FROM user_guild_settings WHERE user_id = ? AND guild_id = ?', userId, key);
  return { ...guildDefaults(key), ...json(row?.settings, {}) };
}

// PATCH body (partial user guild settings (docs), channel_overrides as a map) merged into the stored object
export function patchGuildSettings(userId, key, body, channelOk) {
  if (typeof body !== 'object' || body === null) throw invalid('_root', 'MODEL_TYPE_CONVERT', 'Must be an object.');
  const cur = guildSettingsOf(userId, key);
  for (const [k, v] of Object.entries(body)) {
    if (k === 'channel_overrides') continue;
    if (!Object.hasOwn(GUILD_FIELDS, k)) throw invalid(k, 'UNKNOWN_SETTING', 'This setting does not exist.');
    cur[k] = GUILD_FIELDS[k](v, k);
  }
  if (body.channel_overrides != null) {
    if (typeof body.channel_overrides !== 'object' || Array.isArray(body.channel_overrides)) throw invalid('channel_overrides', 'MODEL_TYPE_CONVERT', 'Must be a map of channel ids to overrides.');
    const byChannel = new Map(cur.channel_overrides.map(o => [o.channel_id, o]));
    for (const [id, o] of Object.entries(body.channel_overrides)) {
      if (!SNOWFLAKE.test(id) || !channelOk(id)) throw invalid('channel_overrides', 'CHANNEL_INVALID', `Unknown channel ${id}.`);
      const next = byChannel.get(id) ?? { channel_id: id, collapsed: false, flags: 0, message_notifications: 3, muted: false, mute_config: null };
      for (const [k, v] of Object.entries(o ?? {})) {
        if (k === 'channel_id') continue;
        if (!Object.hasOwn(OVERRIDE_FIELDS, k)) throw invalid(`channel_overrides.${id}.${k}`, 'UNKNOWN_SETTING', 'This setting does not exist.');
        next[k] = OVERRIDE_FIELDS[k](v, `channel_overrides.${id}.${k}`);
      }
      byChannel.set(id, next);
    }
    cur.channel_overrides = [...byChannel.values()];
  }
  cur.version += 1;
  const { guild_id, ...doc } = cur;
  run(`INSERT INTO user_guild_settings (user_id, guild_id, settings) VALUES (?, ?, ?)
       ON CONFLICT DO UPDATE SET settings = excluded.settings`, userId, key, JSON.stringify(doc));
  return cur;
}

export function guildSettingsReady(userId) {
  const entries = all('SELECT guild_id FROM user_guild_settings WHERE user_id = ?', userId).map(r => guildSettingsOf(userId, r.guild_id));
  return { entries, partial: false, version: entries.reduce((n, e) => Math.max(n, e.version), 0) };
}

const muteActive = (muted, cfg) => !!muted && (!cfg?.end_time || cfg.end_time > new Date().toISOString());

// whether a mention (kind: user | role | everyone | dm) in this channel may notify the user, per their settings and mutes
export function notifies(userId, ch, kind) {
  const gs = guildSettingsOf(userId, ch.guild_id ?? '@me');
  if (!gs.mobile_push || muteActive(gs.muted, gs.mute_config)) return false;
  const ids = [ch.id, ch.parent_id].filter(Boolean);
  const overrides = gs.channel_overrides.filter(o => ids.includes(o.channel_id));
  if (overrides.some(o => muteActive(o.muted, o.mute_config))) return false;
  const own = overrides.find(o => o.channel_id === ch.id && o.message_notifications !== 3) ?? overrides.find(o => o.message_notifications !== 3);
  if ((own?.message_notifications ?? gs.message_notifications) === 2) return false;
  if (kind === 'everyone' && gs.suppress_everyone) return false;
  if (kind === 'role' && gs.suppress_roles) return false;
  return true;
}

export const notesOf = userId => Object.fromEntries(all('SELECT target_id, note FROM notes WHERE user_id = ?', userId).map(r => [r.target_id, r.note]));
