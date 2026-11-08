// POST /interactions (user docs), the bot's callback, and the interaction webhook routes (official docs)
import { get, json, isMember, userById, userObj, memberRow, memberObj, roleObj, channelObj } from '../db.js';
import { HttpError, invalid, notFound, missingAccess, snowflakeField } from '../errors.js';
import { P, need, has, channelPerms } from '../permissions.js';
import { messageObj } from '../message.js';
import { readPayload } from '../compose.js';
import { findComponent, isSelect } from '../components.js';
import { loadChannel } from './channels.js';
import { commandsFor } from './commands.js';
import {
  isInteractionToken, startInteraction, interactionRecord, ephemeralFor, recordForCallback, respond, recordForWebhook,
  followUp, webhookMessage, webhookEdit, webhookDelete, stageFiles, discardFiles, ephemeralAttachment,
} from '../interactions.js';

const bad = (path, msg) => invalid(path, 'INTERACTION_INVALID', msg);
const SNOW = /^\d{1,19}$/;

// resolved entities (users, members, roles, channels, uploads) for options and selects, checked against the channel's guild.
// uploads: staged files of this request; an ATTACHMENT option's value names one by its data.attachments id (= its files[n])
function resolver(ch, user, uploads = []) {
  const resolved = {};
  const put = (k, id, v) => { (resolved[k] ??= {})[id] = v; };
  const member = (id, path) => {
    const u = SNOW.test(String(id)) && userById(String(id));
    if (!u || u.deleted) throw bad(path, 'Unknown user.');
    put('users', u.id, userObj(u));
    const m = ch.guild_id && memberRow(ch.guild_id, u.id);
    if (ch.guild_id && !m) throw bad(path, 'Not a member of this guild.');
    if (m) { const { user: _, mute, deaf, ...partial } = memberObj(m); put('members', u.id, { ...partial, permissions: String(channelPerms(ch, u.id)) }); }
  };
  const role = (id, path) => {
    const r = ch.guild_id && get('SELECT * FROM roles WHERE id = ? AND guild_id = ?', String(id), ch.guild_id);
    if (!r) throw bad(path, 'Unknown role.');
    put('roles', r.id, roleObj(r));
  };
  const channel = (id, path, types) => {
    const c = get('SELECT * FROM channels WHERE id = ?', String(id));
    const visible = c && (ch.guild_id ? c.guild_id === ch.guild_id : c.id === ch.id) && has(channelPerms(c, user.id), P.VIEW_CHANNEL);
    if (!visible || (types?.length && !types.includes(c.type))) throw bad(path, 'Unknown or unsuitable channel.');
    const o = channelObj(c, user.id);
    put('channels', c.id, { id: c.id, name: o.name, type: c.type, permissions: String(channelPerms(c, user.id)), guild_id: c.guild_id ?? undefined, parent_id: c.parent_id ?? null, ...(o.thread_metadata && { thread_metadata: o.thread_metadata }) });
  };
  const mentionable = (id, path) => (get('SELECT 1 FROM roles WHERE id = ? AND guild_id = ?', String(id), ch.guild_id ?? '') ? role(id, path) : member(id, path));
  const attachment = (v, path, appId) => {
    const a = (typeof v === 'string' || typeof v === 'number') && /^\d{1,2}$/.test(String(v)) && uploads.find(x => x.n === Number(v));
    if (!a) throw bad(path, 'Unknown attachment.');
    put('attachments', a.id, ephemeralAttachment(appId, a));
    return a.id;
  };
  return { resolved, member, role, channel, mentionable, attachment };
}

// slash command options against the command's definition; autocomplete allows partial input and needs one focused option
function checkOptions(defs, given, r, path, autocomplete, focus, appId) {
  if (given == null) given = [];
  if (!Array.isArray(given) || given.length > 25) throw bad(path, 'Options must be a list.');
  const out = [];
  for (const [i, o] of given.entries()) {
    const p = `${path}.${i}`;
    const def = defs.find(d => d.name === o?.name);
    if (!def || (o.type !== undefined && o.type !== def.type)) throw bad(p, 'Unknown option.');
    if (def.type <= 2) {
      if (given.length !== 1) throw bad(path, 'Exactly one subcommand.');
      out.push({ name: def.name, type: def.type, options: checkOptions(def.options ?? [], o.options, r, `${p}.options`, autocomplete, focus, appId) });
      continue;
    }
    const v = o.value;
    const entry = { name: def.name, type: def.type, value: v };
    if (o.focused === true && autocomplete) { focus.n++; entry.focused = true; if (typeof v !== 'string' && typeof v !== 'number') throw bad(p, 'Bad value.'); out.push(entry); continue; }
    if (def.type === 11 && autocomplete) continue; // autocomplete interactions carry no attachments (docs)
    switch (def.type) {
      case 3:
        if (typeof v !== 'string' || v.length < (def.min_length ?? 0) || v.length > (def.max_length ?? 6000)) throw bad(p, 'Bad string.');
        break;
      case 4: case 10:
        if (def.type === 4 ? !Number.isSafeInteger(v) : !(typeof v === 'number' && Number.isFinite(v))) throw bad(p, 'Bad number.');
        if ((def.min_value != null && v < def.min_value) || (def.max_value != null && v > def.max_value)) throw bad(p, 'Out of range.');
        break;
      case 5: if (typeof v !== 'boolean') throw bad(p, 'Bad boolean.'); break;
      case 6: r.member(v, p); break;
      case 7: r.channel(v, p, def.channel_types); break;
      case 8: r.role(v, p); break;
      case 9: r.mentionable(v, p); break;
      case 11: entry.value = r.attachment(v, p, appId); break;
      default: throw bad(p, 'Unknown option type.');
    }
    if (def.choices?.length && !def.choices.some(c => c.value === v)) throw bad(p, 'Not one of the choices.');
    out.push(entry);
  }
  if (!autocomplete) for (const d of defs) if (d.required && !out.some(o => o.name === d.name)) throw bad(path, `Missing required option ${d.name}.`);
  return out;
}

// the invoked command's path (with subcommands) for interaction metadata
const pathName = (name, opts) => (opts?.[0]?.type <= 2 ? pathName(`${name} ${opts[0].name}`, opts[0].options) : name);

function commandData(body, user, ch, app, uploads) {
  const d = body.data ?? {};
  const cmd = commandsFor(user, { guildId: ch.guild_id, ch }).find(c => c.id === String(d.id) && c.application_id === app.id);
  if (!cmd) throw notFound(10063, 'application command');
  const def = json(cmd.data);
  if (d.name !== undefined && d.name !== def.name) throw bad('data.name', 'Does not match the command.');
  const r = resolver(ch, user, uploads);
  const out = { id: cmd.id, name: def.name, type: def.type, ...(cmd.guild_id && { guild_id: cmd.guild_id }) };
  const meta = { name: def.name, command_type: def.type };
  if (def.type === 1) {
    const focus = { n: 0 };
    out.options = checkOptions(def.options ?? [], d.options, r, 'data.options', body.type === 4, focus, app.id);
    if (body.type === 4 && focus.n !== 1) throw bad('data.options', 'Autocomplete needs exactly one focused option.');
    meta.name = pathName(def.name, out.options);
  } else {
    if (body.type === 4) throw bad('type', 'Only slash commands autocomplete.');
    const target = String(d.target_id ?? '');
    if (def.type === 2) { r.member(target, 'data.target_id'); meta.target_user_id = target; }
    else {
      const m = get('SELECT * FROM messages WHERE id = ? AND channel_id = ?', target, ch.id);
      if (!m || !has(ch.perms, P.READ_MESSAGE_HISTORY)) throw notFound(10008, 'Message');
      (r.resolved.messages ??= {})[m.id] = messageObj(m, ch, null);
      meta.target_message_id = m.id;
    }
    out.target_id = target;
  }
  if (Object.keys(r.resolved).length) out.resolved = r.resolved;
  return { data: out, meta };
}

// a click or a selection on a component of a message the app sent (stored, or this user's ephemeral one)
function componentData(body, user, ch, app) {
  const mid = snowflakeField(body, 'message_id');
  const row = get('SELECT * FROM messages WHERE id = ? AND channel_id = ? AND application_id = ?', mid, ch.id, app.id);
  const message = row ? messageObj(row, ch, user.id) : ephemeralFor(mid, user.id, app.id);
  if (!message || message.channel_id !== ch.id) throw notFound(10008, 'Message');
  const d = body.data ?? {};
  const c = findComponent(message.components ?? [], d.custom_id);
  const type = d.component_type ?? d.type;
  if (!c || c.type !== type || c.disabled) throw bad('data.custom_id', 'Unknown or disabled component.');
  const out = { custom_id: c.custom_id, component_type: c.type };
  if (isSelect(c.type)) {
    const values = d.values;
    if (!Array.isArray(values) || values.length < (c.min_values ?? 1) || values.length > (c.max_values ?? 1) || new Set(values).size !== values.length) throw bad('data.values', 'Wrong number of values.');
    const r = resolver(ch, user);
    values.forEach((v, i) => {
      const p = `data.values.${i}`;
      if (c.type === 3) { if (!c.options.some(o => o.value === v)) throw bad(p, 'Not an option.'); return; }
      ({ 5: r.member, 6: r.role, 7: r.mentionable, 8: (id, path) => r.channel(id, path, c.channel_types) })[c.type](v, p);
    });
    out.values = values.map(String);
    if (c.type !== 3) out.resolved = r.resolved;
  }
  return { data: out, message, meta: { interacted_message_id: message.id } };
}

// a modal the app opened for this user: values checked against its text inputs
function modalData(body, user, app) {
  const d = body.data ?? {};
  const parent = interactionRecord(String(d.id ?? ''));
  if (!parent?.modal || parent.userId !== user.id || parent.app.id !== app.id || parent.modal.custom_id !== d.custom_id) throw notFound(10062, 'interaction');
  const given = new Map();
  for (const row of Array.isArray(d.components) ? d.components : []) {
    for (const c of row?.type === 18 ? [row.component] : row?.components ?? []) if (c?.type === 4) given.set(c.custom_id, c.value);
  }
  const rows = parent.modal.components.map(row => {
    const t = row.components[0];
    const v = given.get(t.custom_id) ?? '';
    given.delete(t.custom_id);
    if (typeof v !== 'string' || v.length > (t.max_length ?? 4000) || (v && v.length < (t.min_length ?? 0)) || (t.required !== false && !v)) throw bad(`data.components.${t.custom_id}`, 'Invalid value.');
    return { type: 1, components: [{ type: 4, custom_id: t.custom_id, value: v }] };
  });
  if (given.size) throw bad('data.components', 'Unknown text input.');
  parent.modal = null; // one submission per modal
  return { data: { custom_id: d.custom_id, components: rows }, parent };
}

// JSON, or multipart with payload_json and files[n] for ATTACHMENT options (docs: Create Interaction)
async function create(ctx) {
  const { user } = ctx;
  const { body, files } = await readPayload(ctx);
  if (![2, 3, 4, 5].includes(body.type)) throw bad('type', 'Unsupported interaction type.');
  if (files.length && body.type !== 2) throw bad('files', 'Only application commands take files.');
  const app = get('SELECT * FROM applications WHERE id = ?', String(body.application_id ?? ''));
  if (!app) throw notFound(10002, 'Application');
  const ch = loadChannel(snowflakeField(body, 'channel_id'), user);
  if (body.guild_id != null && String(body.guild_id) !== String(ch.guild_id)) throw bad('guild_id', 'Does not match the channel.');
  if (ch.guild_id ? !isMember(ch.guild_id, app.id) : !get('SELECT 1 FROM dm_recipients WHERE channel_id = ? AND user_id = ?', ch.id, app.id) && body.type !== 3 && body.type !== 5) throw missingAccess();
  if (ch.guild_id && (body.type === 2 || body.type === 4)) need(ch.perms, P.USE_APPLICATION_COMMANDS);
  const nonce = typeof body.nonce === 'string' ? body.nonce.slice(0, 64) : undefined;
  const sessionId = typeof body.session_id === 'string' ? body.session_id : undefined;
  if (files.length && ch.guild_id) need(ch.perms, P.ATTACH_FILES);
  const uploads = await stageFiles(app.id, files, body.data?.attachments);
  let x;
  try {
    x = await interactionData(body, user, ch, app, uploads);
  } catch (e) {
    discardFiles(uploads);
    throw e;
  }
  const used = new Set(Object.keys(x.data.resolved?.attachments ?? {}));
  discardFiles(uploads.filter(a => !used.has(a.id))); // files no option refers to
  startInteraction({ app, user, ch, type: body.type, data: x.data, message: x.message, sessionId, nonce, meta: x.meta });
}

function interactionData(body, user, ch, app, uploads) {
  let x;
  if (body.type === 2 || body.type === 4) x = commandData(body, user, ch, app, uploads);
  else if (body.type === 3) x = componentData(body, user, ch, app);
  else {
    const m = modalData(body, user, app);
    if (m.parent.ch.id !== ch.id) throw bad('channel_id', 'Does not match the modal.');
    const message = m.parent.messageId && (ephemeralFor(m.parent.messageId, user.id, app.id) ?? (() => {
      const row = get('SELECT * FROM messages WHERE id = ?', m.parent.messageId);
      return row && messageObj(row, ch, user.id);
    })());
    x = { data: m.data, message: message || undefined, meta: { ...m.parent.meta, triggering_interaction_id: m.parent.id } };
  }
  return x;
}

// the token is checked before a multipart body is read; files[n] go with the message's `attachments` ({id: n, ...}),
// which sit in `data` for callbacks and at the top level for webhook routes (docs: Uploading Files)
async function withFiles(ctx, rec, inData, fn) {
  const { body, files } = await readPayload(ctx);
  const uploads = await stageFiles(rec.app.id, files, (inData ? body?.data : body)?.attachments);
  try {
    return fn(body ?? {}, uploads);
  } catch (e) {
    discardFiles(uploads);
    throw e;
  }
}

function callback(ctx) {
  const rec = recordForCallback(ctx.params.id, ctx.params.token);
  return withFiles(ctx, rec, true, (body, uploads) => {
    const out = respond(rec, body, ctx.query.get('with_response') === 'true', uploads);
    if (out) ctx.status = 200;
    return out;
  });
}

const viaInteraction = { open: true, when: p => isInteractionToken(p.token) };
const withUploads = { ...viaInteraction, multipart: true };
const rec = ctx => recordForWebhook(ctx.params.webhook_id, ctx.params.token);
const hook = '/webhooks/:webhook_id/:token';
export default [
  ['POST', '/interactions', create, { userOnly: true, multipart: true }],
  ['POST', '/interactions/:id/:token/callback', callback, { open: true, multipart: true }],
  ['POST', hook, ctx => { const r = rec(ctx); return withFiles(ctx, r, false, (body, uploads) => followUp(r, body, uploads)); }, withUploads],
  ['GET', `${hook}/messages/:mid`, ctx => webhookMessage(rec(ctx), ctx.params.mid), viaInteraction],
  ['PATCH', `${hook}/messages/:mid`, ctx => { const r = rec(ctx); return withFiles(ctx, r, false, (body, uploads) => webhookEdit(r, ctx.params.mid, body, uploads)); }, withUploads],
  ['DELETE', `${hook}/messages/:mid`, ctx => webhookDelete(rec(ctx), ctx.params.mid), viaInteraction],
];
