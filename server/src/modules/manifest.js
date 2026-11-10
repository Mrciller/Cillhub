// cillhub-module.json (CONTRACT-v8 §1, settings §5, panels §6.1): validated and normalized. Pure: no database, no files
// beyond the unpacked package map it is given.
import { HttpError, invalid } from '../errors.js';
import { validateCommand } from '../routes/commands.js';

export const PERMISSIONS = ['commands', 'messages.read', 'messages.send', 'members.read', 'roles.manage', 'channels.manage', 'voice.read', 'storage', 'http.fetch', 'http.routes', 'ui', 'schedule'];
export const SLOTS = ['channel_panel', 'guild_sidebar', 'message_accessory'];
export const SETTING_TYPES = ['text', 'number', 'toggle', 'select', 'channel', 'role', 'user', 'secret'];
const TOP = ['manifest_version', 'id', 'name', 'version', 'description', 'author', 'homepage', 'main', 'icon', 'permissions', 'http_hosts', 'commands', 'settings', 'ui'];
export const ID = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const VERSION = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(-[0-9A-Za-z.-]{1,40})?$/;
const LABEL = '[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?';
const HOST = new RegExp(`^(\\*\\.)?${LABEL}(\\.${LABEL})*$`);
const EMOJI = /^(\p{Extended_Pictographic}|\p{Regional_Indicator}{2}|[#*0-9]️?⃣)[️‍\p{Extended_Pictographic}\p{Emoji_Modifier}]*$/u;

export const bad = (field, msg) => invalid(field, 'MODULE_MANIFEST_INVALID', `${field}: ${msg}`);
const isStr = (v, min, max) => typeof v === 'string' && v.length >= min && v.length <= max;
const obj = v => typeof v === 'object' && v !== null && !Array.isArray(v);
const only = (o, keys, field) => { for (const k of Object.keys(o)) if (!keys.includes(k)) throw bad(`${field}.${k}`, 'unknown field.'); };
const optStr = (o, k, max, field = k) => {
  if (o[k] == null) return null;
  if (!isStr(o[k], 0, max)) throw bad(field, `must be a string of at most ${max} characters.`);
  return o[k];
};

// image types an icon may have, by magic bytes
const imageType = b => (b[0] === 0x89 && b[1] === 0x50 ? 'png' : b[0] === 0xff && b[1] === 0xd8 ? 'jpeg'
  : b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP' ? 'webp' : null);

export function validateSetting(s, i) {
  const f = `settings.${i}`;
  if (!obj(s)) throw bad(f, 'must be an object.');
  const extras = { text: ['max_length', 'multiline', 'placeholder'], number: ['min', 'max', 'integer'], select: ['options'], channel: ['channel_types'] }[s.type] ?? [];
  if (!SETTING_TYPES.includes(s.type)) throw bad(`${f}.type`, `must be one of ${SETTING_TYPES.join(', ')}.`);
  only(s, ['key', 'type', 'label', 'description', 'required', 'default', 'per_server', ...extras], f);
  if (typeof s.key !== 'string' || !/^[a-z][a-z0-9_]{0,39}$/.test(s.key)) throw bad(`${f}.key`, 'must match ^[a-z][a-z0-9_]{0,39}$.');
  if (!isStr(s.label, 1, 100)) throw bad(`${f}.label`, 'must be 1-100 characters.');
  for (const k of ['required', 'per_server', 'multiline', 'integer']) if (s[k] != null && typeof s[k] !== 'boolean') throw bad(`${f}.${k}`, 'must be a boolean.');
  const out = { key: s.key, type: s.type, label: s.label, description: optStr(s, 'description', 300, `${f}.description`), required: !!s.required, default: null, per_server: !!s.per_server };
  if (s.type === 'text') {
    if (s.max_length != null && !(Number.isInteger(s.max_length) && s.max_length >= 1 && s.max_length <= 2000)) throw bad(`${f}.max_length`, 'must be an integer from 1 to 2000.');
    Object.assign(out, { max_length: s.max_length ?? 200, multiline: !!s.multiline, placeholder: optStr(s, 'placeholder', 200, `${f}.placeholder`) });
  }
  if (s.type === 'number') {
    for (const k of ['min', 'max']) if (s[k] != null && !Number.isFinite(s[k])) throw bad(`${f}.${k}`, 'must be a number.');
    if (s.min != null && s.max != null && s.min > s.max) throw bad(`${f}.min`, 'must not be larger than max.');
    Object.assign(out, { min: s.min ?? null, max: s.max ?? null, integer: !!s.integer });
  }
  if (s.type === 'select') {
    const o = s.options;
    if (!Array.isArray(o) || o.length < 1 || o.length > 25) throw bad(`${f}.options`, 'must list 1-25 options.');
    out.options = o.map((x, j) => {
      if (!obj(x) || !isStr(x.value, 1, 100) || !isStr(x.label, 1, 100)) throw bad(`${f}.options.${j}`, 'needs a value (1-100 characters) and a label (1-100 characters).');
      only(x, ['value', 'label'], `${f}.options.${j}`);
      return { value: x.value, label: x.label };
    });
    if (new Set(out.options.map(x => x.value)).size !== out.options.length) throw bad(`${f}.options`, 'values must be unique.');
  }
  if (s.type === 'channel') {
    if (s.channel_types != null && !(Array.isArray(s.channel_types) && s.channel_types.length <= 20 && s.channel_types.every(t => Number.isInteger(t) && t >= 0 && t <= 16))) throw bad(`${f}.channel_types`, 'must be a list of channel types.');
    out.channel_types = s.channel_types ?? null;
  }
  if (s.default != null) {
    if (['secret', 'channel', 'role', 'user'].includes(s.type)) throw bad(`${f}.default`, `a ${s.type} setting has no default.`);
    const err = checkValue(out, s.default);
    if (err) throw bad(`${f}.default`, err);
    out.default = s.default;
  }
  return out;
}

// a value against its setting's type (ids are only checked for their form here; existence is the store's job); an error text or null
export function checkValue(def, v) {
  switch (def.type) {
    case 'text': return typeof v === 'string' && v.length <= def.max_length && (def.multiline || !/[\r\n]/.test(v)) ? null : `must be text of at most ${def.max_length} characters${def.multiline ? '' : ' on one line'}.`;
    case 'number':
      if (typeof v !== 'number' || !Number.isFinite(v)) return 'must be a number.';
      if (def.integer && !Number.isInteger(v)) return 'must be a whole number.';
      if ((def.min != null && v < def.min) || (def.max != null && v > def.max)) return `must be between ${def.min ?? '-∞'} and ${def.max ?? '∞'}.`;
      return null;
    case 'toggle': return typeof v === 'boolean' ? null : 'must be true or false.';
    case 'select': return def.options.some(o => o.value === v) ? null : 'must be one of the options.';
    case 'secret': return isStr(v, 0, 2000) ? null : 'must be text of at most 2000 characters.';
    default: return typeof v === 'string' && /^\d{1,19}$/.test(v) ? null : 'must be an id.';
  }
}

function validatePanel(p, i, files) {
  const f = `ui.panels.${i}`;
  if (!obj(p)) throw bad(f, 'must be an object.');
  only(p, ['id', 'slot', 'title', 'entry', 'height', 'icon'], f);
  if (typeof p.id !== 'string' || !/^[a-z0-9-]{1,32}$/.test(p.id)) throw bad(`${f}.id`, 'must match ^[a-z0-9-]{1,32}$.');
  if (!SLOTS.includes(p.slot)) throw bad(`${f}.slot`, `must be one of ${SLOTS.join(', ')}.`);
  if (!isStr(p.title, 1, 40)) throw bad(`${f}.title`, 'must be 1-40 characters.');
  if (typeof p.entry !== 'string' || !p.entry.endsWith('.html') || !files.has(p.entry)) throw bad(`${f}.entry`, 'must name an .html file in the package.');
  if (p.height != null && !(Number.isInteger(p.height) && p.height >= 80 && p.height <= 800)) throw bad(`${f}.height`, 'must be an integer from 80 to 800.');
  if (p.icon != null && !(isStr(p.icon, 1, 16) && EMOJI.test(p.icon))) throw bad(`${f}.icon`, 'must be one emoji.');
  return { id: p.id, slot: p.slot, title: p.title, entry: p.entry, height: p.height ?? 360, icon: p.icon ?? null };
}

export function validateManifest(m, files) {
  if (!obj(m)) throw bad('manifest', 'must be a JSON object.');
  only(m, TOP, 'manifest');
  if (m.manifest_version !== 1) throw bad('manifest_version', 'must be 1.');
  if (typeof m.id !== 'string' || !ID.test(m.id)) throw bad('id', 'must be 3-40 lowercase letters, digits or dashes, not starting or ending with a dash.');
  if (!isStr(m.name, 1, 64) || !m.name.trim()) throw bad('name', 'must be 1-64 characters.');
  if (typeof m.version !== 'string' || !VERSION.test(m.version)) throw bad('version', 'must be a semantic version MAJOR.MINOR.PATCH (optional -pre suffix).');
  const homepage = optStr(m, 'homepage', 300);
  if (homepage) {
    let u;
    try { u = new URL(homepage); } catch { /* checked below */ }
    if (u?.protocol !== 'https:') throw bad('homepage', 'must be an https:// URL.');
  }
  const main = m.main ?? 'index.js';
  if (typeof main !== 'string' || !/\.m?js$/.test(main) || !files.has(main)) throw bad('main', 'must name a .js file in the package.');
  if (m.icon != null) {
    const b = typeof m.icon === 'string' && files.get(m.icon);
    if (!b || !imageType(b) || b.length > 256 * 1024) throw bad('icon', 'must name a PNG, JPEG or WebP file of at most 256 KiB in the package.');
  }
  const permissions = m.permissions ?? [];
  if (!Array.isArray(permissions) || !permissions.every(p => PERMISSIONS.includes(p))) throw bad('permissions', `must be a list of ${PERMISSIONS.join(', ')}.`);
  if (new Set(permissions).size !== permissions.length) throw bad('permissions', 'must not repeat a permission.');
  const hosts = m.http_hosts ?? [];
  if (!Array.isArray(hosts) || hosts.length > 20) throw bad('http_hosts', 'must be a list of at most 20 host names.');
  for (const [i, h] of hosts.entries()) {
    if (typeof h !== 'string' || h.length > 253 || !HOST.test(h) || /^\d+$/.test(h.split('.').pop())) throw bad(`http_hosts.${i}`, 'must be a lowercase host name (optionally *.host), without IP address or port.');
    if (h.startsWith('*.') && h.split('.').length < 3) throw bad(`http_hosts.${i}`, 'a wildcard needs a domain under it (*.example.com), not a whole top-level domain.'); // shortcut: no public suffix list, *.co.uk passes; add one if a module ever asks for it
  }
  if (new Set(hosts).size !== hosts.length) throw bad('http_hosts', 'must not repeat a host.');
  if (permissions.includes('http.fetch') !== hosts.length > 0) throw bad('http_hosts', 'must be non-empty with the http.fetch permission and empty without it.');
  const cmds = m.commands ?? [];
  if (!Array.isArray(cmds) || cmds.length > 25) throw bad('commands', 'must be a list of at most 25 commands.');
  if (cmds.length && !permissions.includes('commands')) throw bad('commands', 'needs the commands permission.');
  const commands = cmds.map((c, i) => {
    if (!obj(c)) throw bad(`commands.${i}`, 'must be an object.');
    try {
      return validateCommand({ ...c, contexts: [0], integration_types: [0] }, true); // modules act only in servers
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      const [field, v] = Object.entries(e.body.errors ?? {})[0] ?? ['', null];
      throw bad(`commands.${i}${field ? `.${field}` : ''}`, v?._errors?.[0]?.message ?? e.message);
    }
  });
  if (new Set(commands.map(c => `${c.type}:${c.name}`)).size !== commands.length) throw bad('commands', 'names must be unique per command type.');
  const settingsIn = m.settings ?? [];
  if (!Array.isArray(settingsIn) || settingsIn.length > 50) throw bad('settings', 'must be a list of at most 50 settings.');
  const settings = settingsIn.map(validateSetting);
  if (new Set(settings.map(s => s.key)).size !== settings.length) throw bad('settings', 'keys must be unique.');
  let panels = [];
  if (m.ui != null) {
    if (!obj(m.ui)) throw bad('ui', 'must be an object.');
    only(m.ui, ['panels'], 'ui');
    const list = m.ui.panels ?? [];
    if (!Array.isArray(list) || list.length > 10) throw bad('ui.panels', 'must be a list of at most 10 panels.');
    panels = list.map((p, i) => validatePanel(p, i, files));
    if (new Set(panels.map(p => p.id)).size !== panels.length) throw bad('ui.panels', 'ids must be unique.');
    if (panels.length && !permissions.includes('ui')) throw bad('ui.panels', 'needs the ui permission.');
  }
  return {
    manifest_version: 1, id: m.id, name: m.name, version: m.version, description: optStr(m, 'description', 400), author: optStr(m, 'author', 100),
    homepage, main, icon: m.icon ?? null, permissions, http_hosts: hosts, commands, settings, ui: { panels },
  };
}

// the manifest file of an unpacked package
export function readManifest(files) {
  const raw = files.get('cillhub-module.json');
  if (!raw) throw invalid('file', 'MODULE_PACKAGE_INVALID', 'The package has no cillhub-module.json at its root or in its single top-level folder.');
  let m;
  try { m = JSON.parse(raw.toString('utf8')); } catch { throw bad('manifest', 'cillhub-module.json is not valid JSON.'); }
  return validateManifest(m, files);
}
