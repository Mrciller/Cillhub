// 7.10.3 legal features (EU / DACH): the operator's imprint, privacy notice and terms with versions, the terms gate,
// public notices of illegal content (DSA Art. 16), statements of reasons and one appeal per decision (Art. 17, 20),
// "remove and preserve" by link (TCO Art. 3 and 6), yearly counts for a transparency report and the licence texts.
// The operator details are this instance's own: nothing here is taken from or sent to a hub.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { mkdir, copyFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { snowflake } from '../snowflake.js';
import { DATA_DIR, get, all, run, json, userById, userObj } from '../db.js';
import { HttpError, str, invalid, notFound, plainEmail, intParam } from '../errors.js';
import { viewersOf } from '../permissions.js';
import { sendToUsers, sendToAllUsers } from '../gateway.js';
import { audit, A } from '../audit.js';
import { addJob, schedule } from '../timers.js';
import { requireMfa } from '../mfa.js';
import { deleteMessages, attachmentUrl, getChannel } from '../message.js';
import {
  setting, LEGAL_DOCS, legalDoc, forgetLegalDocs, forgetRequiredVersion, acceptVersion, legalGate, captchaOn, mailConfigured, publicInstance,
} from '../instance.js';
import { requireCaptcha } from '../captcha.js';
import { sendMail, mailError } from '../mail.js';
import { settingsOf } from '../userdata.js';
import { configuredBackends } from '../voice.js';
import { fcmEnabled } from '../fcm.js';
import { publicUrl, configuredUrl, ROLE, mode, signInPolicy } from '../federation.js';
import { systemDm } from './admin.js';
import { destroyGuild } from './guilds.js';

const DAY = 86_400_000;
export const APPEAL_MS = 183 * DAY; // 6 months (DSA Art. 20(1)); also how long removed content is preserved (TCO Art. 6)
// tests only (NODE_ENV=test): a short preservation period, so the deletion job can be seen working
const PRESERVE_MS = (process.env.NODE_ENV === 'test' && Number(process.env.CILLCORD_TEST_PRESERVE_MS)) || APPEAL_MS;
const iso = ms => (ms ? new Date(ms).toISOString() : null);
const sha = s => createHash('sha256').update(s).digest('hex');
const newCode = () => randomBytes(18).toString('base64url'); // 144 bits, unguessable
const codeField = body => str(body, 'code', 10, 64, true);
const de = userId => settingsOf(userId).locale === 'de';
const base = req => configuredUrl() ?? publicUrl(req);

// --- documents -----------------------------------------------------------------------------------------------------------
const docOut = d => d && { version: d.id, en: d.en, de: d.de, hash: d.hash, updated_at: iso(d.created_at) };
function getDoc({ params }) {
  if (!LEGAL_DOCS.includes(params.doc)) throw notFound(10000, 'Document');
  return { doc: params.doc, ...(docOut(legalDoc(params.doc)) ?? { version: null, en: '', de: '', hash: null, updated_at: null }) };
}

const MAX_DOC = 100_000;
// PUT /admin/legal/:doc {en, de, reaccept?}: a new version when the text changed (or re-acceptance is asked for)
function putDoc(ctx) {
  const { doc } = ctx.params;
  if (!LEGAL_DOCS.includes(doc)) throw notFound(10000, 'Document');
  const body = ctx.body ?? {};
  const text = k => {
    if (body[k] == null) return '';
    if (typeof body[k] !== 'string' || body[k].length > MAX_DOC) throw invalid(k, 'BASE_TYPE_BAD_LENGTH', `Must be text of at most ${MAX_DOC} characters.`);
    return body[k].replace(/\r\n/g, '\n');
  };
  const en = text('en'), deText = text('de');
  const reaccept = doc !== 'imprint' && body.reaccept === true;
  const hash = sha(`${en}\u0000${deText}`);
  const cur = legalDoc(doc);
  if (cur?.hash === hash && !reaccept) return { doc, ...docOut(cur), created: false };
  run('INSERT INTO legal_documents (doc, en, de, hash, reaccept, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    doc, en, deText, hash, Number(reaccept), ctx.user.id, Date.now());
  forgetLegalDocs();
  forgetRequiredVersion();
  ctx.audit = { action: 'legal.update', target_type: 'legal_document', target_id: doc, details: { version: legalDoc(doc).id, hash, reaccept } };
  sendToAllUsers('INSTANCE_SETTINGS_UPDATE', publicInstance());
  return { doc, ...docOut(legalDoc(doc)), created: true };
}

// what the admin's template button builds on: the switched-on features, never secrets
function features() {
  const modules = all('SELECT manifest FROM modules WHERE enabled = 1').map(m => json(m.manifest, {}));
  return {
    captcha: captchaOn(), mail: mailConfigured(), push: true, fcm: fcmEnabled,
    gif_provider: process.env.GIPHY_API_KEY ? 'giphy' : process.env.TENOR_API_KEY ? 'tenor' : null,
    voice: configuredBackends(), watch_together: true, link_previews: true,
    federation: { role: ROLE, mode: mode(), sign_in: ROLE === 'hub' ? null : signInPolicy() },
    module_hosts: [...new Set(modules.flatMap(m => m.http_hosts ?? []))],
  };
}
function adminLegal() {
  return {
    documents: Object.fromEntries(LEGAL_DOCS.map(d => [d, docOut(legalDoc(d))])),
    versions: all('SELECT id, doc, hash, reaccept, created_by, created_at FROM legal_documents ORDER BY id DESC LIMIT 200')
      .map(v => ({ ...v, reaccept: !!v.reaccept, created_at: iso(v.created_at) })),
    features: features(),
  };
}

// --- the terms gate ------------------------------------------------------------------------------------------------------
const legalStatus = ({ user }) => ({
  required: legalGate(user), needs_age: !!user.legal_pending, accept_version: acceptVersion(), accepted_version: user.terms_version ?? null,
  accepted_at: iso(user.terms_accepted_at), min_age: setting('min_age'),
});
// the sign-up checks: the checkbox when terms or a privacy notice exist, the age always
export function checkSignUp(body) {
  if (acceptVersion() && body?.terms_accepted !== true) {
    throw invalid('terms_accepted', 'TERMS_NOT_ACCEPTED', 'Accept the terms of use and confirm that you have read the privacy notice.');
  }
  if (body?.age_confirmed !== true) throw invalid('age_confirmed', 'AGE_NOT_CONFIRMED', `You must be at least ${setting('min_age')} years old.`);
}
// POST /legal/accept {version, age_confirmed?}: version must be the current one, so nobody accepts a text they did not see
function accept({ user, body }) {
  if (user.legal_pending) checkSignUp({ terms_accepted: true, ...body });
  const v = acceptVersion();
  if (v && body?.version !== v) throw invalid('version', 'TERMS_VERSION_OUTDATED', 'The terms changed; reload them and accept again.');
  run('UPDATE users SET terms_version = ?, terms_accepted_at = ?, legal_pending = 0 WHERE id = ?', v, Date.now(), user.id);
  return legalStatus({ user: userById(user.id) });
}

// --- statements of reasons (Art. 17) and appeals (Art. 20) -----------------------------------------------------------------
export const GROUNDS = ['terms', 'illegal'];
const CATEGORY = {
  spam: ['Spam or scam', 'Spam oder Betrug'], harassment: ['Harassment or bullying', 'Belästigung oder Mobbing'], hate: ['Hateful content', 'Hassinhalte'],
  nsfw: ['Sexual or explicit content', 'Sexuelle oder explizite Inhalte'], violence: ['Violence or threats', 'Gewalt oder Drohungen'],
  self_harm: ['Self-harm', 'Selbstverletzung'], illegal: ['Illegal content', 'Rechtswidrige Inhalte'], impersonation: ['Impersonation', 'Identitätsmissbrauch'],
  terrorism: ['Terrorist content', 'Terroristische Inhalte'], other: ['Other', 'Sonstiges'],
};
export const DECISION_CATEGORIES = Object.keys(CATEGORY);
const ACTION = {
  delete_message: ['A message of yours was removed', 'Eine Nachricht von dir wurde entfernt'], remove_message: ['A message of yours was removed', 'Eine Nachricht von dir wurde entfernt'],
  timeout: ['You were timed out in a server', 'Du wurdest in einem Server stummgeschaltet'], kick: ['You were removed from a server', 'Du wurdest aus einem Server entfernt'],
  ban: ['You were banned from a server', 'Du wurdest aus einem Server gesperrt'], disable_account: ['Your account was disabled', 'Dein Konto wurde gesperrt'],
  remove_server: ['Your server was removed', 'Dein Server wurde entfernt'], delete_server: ['Your server was removed', 'Dein Server wurde entfernt'],
  hide_listing: ['Your server was hidden from the server directory', 'Dein Server wurde aus dem Serververzeichnis ausgeblendet'],
};
const GROUND = { terms: ['Terms of use', 'Nutzungsbedingungen'], illegal: ['Illegal content', 'Rechtswidriger Inhalt'] };

// {category, ground, reason} from an admin request: required for every action that is not a dismissal
export function statement(body) {
  const b = body ?? {};
  if (!DECISION_CATEGORIES.includes(b.category)) throw invalid('category', 'BASE_TYPE_CHOICES', `Must be one of ${DECISION_CATEGORIES.join(', ')}.`);
  const ground = b.ground ?? (b.category === 'illegal' || b.category === 'terrorism' ? 'illegal' : 'terms');
  if (!GROUNDS.includes(ground)) throw invalid('ground', 'BASE_TYPE_CHOICES', 'Must be terms or illegal.');
  return { category: b.category, ground, reason: str(b, 'reason', 3, 1000) };
}

const appealUntil = d => d.created_at + APPEAL_MS;
function statementText(d, base, code, deLang) {
  const L = deLang ? 1 : 0;
  const [a, c, g] = [ACTION[d.action]?.[L] ?? d.action, CATEGORY[d.category]?.[L] ?? d.category, GROUND[d.ground][L]];
  const where = json(d.target, {}).name;
  const when = new Date(d.created_at).toLocaleDateString(deLang ? 'de-AT' : 'en-GB');
  return deLang
    ? `**Moderationsentscheidung der Administration von ${setting('instance_name')}**\n${a}${where ? ` (${where})` : ''}.\n`
      + `Grund: ${c}\nRechtsgrundlage: ${g}\nBegründung: ${d.reason}\n\nEntschieden am ${when} von einem Menschen, nicht automatisiert. `
      + `Du kannst innerhalb von 6 Monaten einmal Einspruch erheben: ${base}/appeal#${code}`
    : `**Moderation decision by the administrators of ${setting('instance_name')}**\n${a}${where ? ` (${where})` : ''}.\n`
      + `Reason: ${c}\nLegal ground: ${g}\nExplanation: ${d.reason}\n\nDecided on ${when} by a person, not by automated means. `
      + `You can appeal this decision once within 6 months: ${base}/appeal#${code}`;
}

// records a decision and tells the affected account (a disabled account sees it at its next login instead)
export function decide(ctx, { userId, action, category, ground, reason, target = {}, reportId = null }) {
  const code = newCode();
  const d = { id: snowflake(), user_id: userId ?? null, admin_id: ctx.user.id, action, category, ground, reason, target: JSON.stringify(target), report_id: reportId, created_at: Date.now() };
  run(`INSERT INTO moderation_decisions (id, user_id, admin_id, action, category, ground, reason, target, report_id, created_at, appeal_code_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, d.id, d.user_id, d.admin_id, action, category, ground, reason, d.target, reportId, d.created_at, sha(code));
  const u = userId && userById(userId);
  if (u && !u.bot && !u.deleted && !u.disabled && !u.system) systemDm(u.id, statementText(d, base(ctx.req), code, de(u.id)));
  return d.id;
}

// a disabled account's login error: the reason, the ground and a fresh appeal link (the password was right)
export function disabledInfo(userId, req) {
  const d = get(`SELECT * FROM moderation_decisions WHERE user_id = ? AND action IN ('disable_account') ORDER BY created_at DESC LIMIT 1`, userId);
  if (!d) return null;
  let code = null;
  if (!d.appeal && Date.now() < appealUntil(d)) run('UPDATE moderation_decisions SET appeal_code_hash = ? WHERE id = ?', sha(code = newCode()), d.id);
  return {
    action: d.action, category: d.category, ground: d.ground, reason: d.reason, created_at: iso(d.created_at), appeal_until: iso(appealUntil(d)),
    appeal_url: code && `${base(req)}/appeal#${code}`, appeal_status: d.appeal_status, appeal_decision: d.appeal_decision,
  };
}

const appealView = d => ({
  id: d.id, action: d.action, category: d.category, ground: d.ground, reason: d.reason, created_at: iso(d.created_at), appeal_until: iso(appealUntil(d)),
  appeal: d.appeal ? { status: d.appeal_status, text: d.appeal, at: iso(d.appeal_at), decision: d.appeal_decision, decided_at: iso(d.appeal_decided_at) } : null,
});
const byAppealCode = body => {
  const d = get('SELECT * FROM moderation_decisions WHERE appeal_code_hash = ?', sha(codeField(body)));
  if (!d) throw notFound(10000, 'Decision');
  return d;
};
// POST /legal/appeals/lookup {code} and POST /legal/appeals {code, text}: once per decision, within 6 months
const lookupAppeal = ({ body }) => appealView(byAppealCode(body));
function fileAppeal(ctx) {
  const d = byAppealCode(ctx.body);
  const text = str(ctx.body, 'text', 10, 4000);
  if (d.appeal) throw new HttpError(400, 0, 'This decision was already appealed.');
  if (Date.now() > appealUntil(d)) throw new HttpError(400, 0, 'The 6 months for an appeal have passed.');
  if (!run("UPDATE moderation_decisions SET appeal = ?, appeal_at = ?, appeal_status = 'open' WHERE id = ? AND appeal IS NULL", text, Date.now(), d.id).changes) {
    throw new HttpError(400, 0, 'This decision was already appealed.');
  }
  ctx.status = 201;
  return appealView(get('SELECT * FROM moderation_decisions WHERE id = ?', d.id));
}

const decisionObj = d => ({ ...appealView(d), user: d.user_id && userById(d.user_id) ? userObj(userById(d.user_id)) : null, target: json(d.target, {}), admin_id: d.admin_id });
function listAppeals({ query }) {
  const status = query.get('status') ?? 'open';
  if (!['open', 'decided'].includes(status)) throw invalid('status', 'BASE_TYPE_CHOICES', 'Must be open or decided.');
  return all(`SELECT * FROM moderation_decisions WHERE ${status === 'open' ? "appeal_status = 'open'" : "appeal_status IN ('upheld', 'reversed')"}
              ORDER BY appeal_at DESC LIMIT ?`, intParam(query, 'limit', 50, 1, 200)).map(decisionObj);
}
// POST /admin/appeals/:id {outcome: upheld|reversed, text}: a reversed account disable enables the account again
function decideAppeal(ctx) {
  const d = get("SELECT * FROM moderation_decisions WHERE id = ? AND appeal_status = 'open'", ctx.params.decision_id);
  if (!d) throw notFound(10000, 'Appeal');
  const outcome = ctx.body?.outcome;
  if (!['upheld', 'reversed'].includes(outcome)) throw invalid('outcome', 'BASE_TYPE_CHOICES', 'Must be upheld or reversed.');
  const text = str(ctx.body, 'text', 3, 2000);
  run('UPDATE moderation_decisions SET appeal_status = ?, appeal_decision = ?, appeal_decided_at = ?, appeal_admin_id = ? WHERE id = ?', outcome, text, Date.now(), ctx.user.id, d.id);
  const u = d.user_id && userById(d.user_id);
  if (u && outcome === 'reversed' && d.action === 'disable_account') run('UPDATE users SET disabled = 0 WHERE id = ?', u.id);
  if (u && !u.deleted && !u.bot && (!u.disabled || outcome === 'reversed')) {
    const deLang = de(u.id);
    systemDm(u.id, deLang
      ? `**Entscheidung über deinen Einspruch** (${ACTION[d.action]?.[1] ?? d.action}): ${outcome === 'reversed' ? 'Die Entscheidung wurde aufgehoben.' : 'Die Entscheidung bleibt bestehen.'}\n${text}`
      : `**Decision on your appeal** (${ACTION[d.action]?.[0] ?? d.action}): ${outcome === 'reversed' ? 'The decision was reversed.' : 'The decision stands.'}\n${text}`);
  }
  ctx.audit = { action: `appeal.${outcome}`, target_type: 'decision', target_id: d.id, details: { user_id: d.user_id, action: d.action } };
  return decisionObj(get('SELECT * FROM moderation_decisions WHERE id = ?', d.id));
}

// --- public notices (DSA Art. 16) ------------------------------------------------------------------------------------------
// child sexual abuse is the one category where the notifier may stay anonymous (Art. 16(2)(c))
export const NOTICE_CATEGORIES = ['child_abuse', 'terrorism', 'hate_speech', 'violence', 'privacy', 'intellectual_property', 'fraud', 'other_illegal'];
const ANONYMOUS_OK = ['child_abuse'];
const optText = (body, k, max) => (body[k] == null || body[k] === '' ? null : str(body, k, 1, max));

// a link to something on this instance -> ids, never content (public notices name things, they do not read them)
export function parseLink(raw) {
  let path;
  try { path = new URL(String(raw), 'http://x').pathname; } catch { return null; }
  path = path.replace(/^\/api(\/v\d+)?(?=\/)/, '');
  let m;
  if ((m = /^\/channels\/(@me|\d+)\/(\d+)\/(\d+)\/?$/.exec(path))) return { kind: 'message', guild_id: m[1] === '@me' ? null : m[1], channel_id: m[2], message_id: m[3] };
  if ((m = /^\/attachments\/(\d+)\/(\d+)\//.exec(path))) {
    const a = get('SELECT message_id, channel_id FROM attachments WHERE id = ? AND channel_id = ?', m[2], m[1]);
    const ch = a && getChannel(a.channel_id);
    return a ? { kind: 'message', guild_id: ch?.guild_id ?? null, channel_id: a.channel_id, message_id: a.message_id } : { kind: 'attachment' };
  }
  if ((m = /^\/channels\/(\d+)(?:\/\d+)?\/?$/.exec(path))) return { kind: 'server', guild_id: m[1] };
  if ((m = /^\/invite\/([\w-]{2,32})\/?$/.exec(path)) || (m = /^\/invites\/([\w-]{2,32})\/?$/.exec(path))) {
    const inv = get('SELECT guild_id FROM invites WHERE code = ?', m[1]);
    return inv ? { kind: 'server', guild_id: inv.guild_id } : { kind: 'invite' };
  }
  return null;
}

async function notice(ctx) {
  const body = ctx.body ?? {};
  if (!NOTICE_CATEGORIES.includes(body.category)) throw invalid('category', 'BASE_TYPE_CHOICES', `Must be one of ${NOTICE_CATEGORIES.join(', ')}.`);
  const url = optText(body, 'url', 500);
  const description = optText(body, 'description', 2000);
  if (!url && !description) throw invalid('url', 'BASE_TYPE_REQUIRED', 'Give a link to the content or describe where it is.');
  const explanation = str(body, 'explanation', 10, 5000);
  const name = optText(body, 'name', 100);
  const email = optText(body, 'email', 254);
  if (email && !plainEmail(email)) throw invalid('email', 'EMAIL_TYPE_INVALID_EMAIL', 'Not a valid email address.');
  if (!ANONYMOUS_OK.includes(body.category) && (!name || !email)) throw invalid(name ? 'email' : 'name', 'BASE_TYPE_REQUIRED', 'Name and email are required for this category.');
  if (body.good_faith !== true) throw invalid('good_faith', 'BASE_TYPE_REQUIRED', 'Confirm that the notice is accurate and complete to the best of your knowledge.');
  await requireCaptcha(ctx);
  const link = url ? parseLink(url) : null;
  const msg = link?.message_id && get('SELECT author_id, channel_id FROM messages WHERE id = ?', link.message_id);
  const code = newCode();
  const id = snowflake();
  run(`INSERT INTO reports (id, source, message_id, channel_id, guild_id, author_id, reason, note, snapshot, created_at, target_url, reporter_name, reporter_email, code_hash)
       VALUES (?, 'public', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, link?.message_id ?? null, msg?.channel_id ?? link?.channel_id ?? null, link?.guild_id ?? null,
  msg?.author_id ?? null, body.category, explanation, JSON.stringify({ description, link: link?.kind ?? null }), Date.now(), url, name, email, sha(code));
  if (email && mailConfigured()) {
    sendMail({
      to: email, subject: `[${setting('instance_name')}] Notice received / Meldung erhalten (${id})`,
      text: `We received your notice ${id} and will review it. Status: ${base(ctx.req)}/report-content/status#${code}\n\n`
        + `Wir haben deine Meldung ${id} erhalten und prüfen sie. Status: ${base(ctx.req)}/report-content/status#${code}\n`,
    }).catch(e => console.error(`notice receipt mail failed: ${mailError(e)}`));
  }
  ctx.status = 201;
  return { id, code, status_url: `/report-content/status#${code}`, receipt_mailed: !!(email && mailConfigured()) };
}
// POST /legal/notices/status {code}: the state of one notice, nothing about the people involved
function noticeStatus({ body }) {
  const r = get("SELECT * FROM reports WHERE code_hash = ? AND source = 'public'", sha(codeField(body)));
  if (!r) throw notFound(10000, 'Notice');
  return { id: r.id, category: r.reason, status: r.status, created_at: iso(r.created_at), resolved_at: iso(r.resolved_at), decision: r.decision };
}
// the decision on a public notice goes back by mail when the notifier left an address
export function noticeDecided(r, decision) {
  if (!r.reporter_email || !mailConfigured()) return;
  sendMail({
    to: r.reporter_email, subject: `[${setting('instance_name')}] Decision on your notice / Entscheidung zu deiner Meldung (${r.id})`,
    text: `${decision}\n`,
  }).catch(e => console.error(`notice decision mail failed: ${mailError(e)}`));
}

// --- remove and preserve by link (TCO) -------------------------------------------------------------------------------------
// guild content only: direct messages are not public and reach the admins only through a participant's report
function resolveItem(url) {
  const link = parseLink(url);
  if (!link) throw invalid('url', 'LINK_UNKNOWN', 'Paste a link to a message, an attachment or a server on this instance.');
  if (link.kind === 'message') {
    const m = get('SELECT * FROM messages WHERE id = ?', link.message_id);
    const ch = m && getChannel(m.channel_id);
    if (!m || !ch) throw notFound(10008, 'Message');
    if (!ch.guild_id) throw new HttpError(400, 0, 'Direct messages can only be acted on through a report by a participant.');
    const g = get('SELECT id, name FROM guilds WHERE id = ?', ch.guild_id);
    return { kind: 'message', m, ch, g };
  }
  if (link.kind === 'server') {
    const g = get('SELECT * FROM guilds WHERE id = ?', link.guild_id);
    if (!g) throw notFound(10004, 'Guild');
    return { kind: 'server', g };
  }
  throw notFound(10000, 'Item');
}
const itemView = it => (it.kind === 'message' ? {
  type: 'message', guild: { id: it.g.id, name: it.g.name }, channel: { id: it.ch.id, name: it.ch.name }, author: it.m.author_id && userById(it.m.author_id) ? userObj(userById(it.m.author_id)) : null,
  content: it.m.content, timestamp: it.m.timestamp,
  attachments: all('SELECT filename, size, content_type FROM attachments WHERE message_id = ?', it.m.id),
} : {
  type: 'server', guild: { id: it.g.id, name: it.g.name }, owner: userById(it.g.owner_id) ? userObj(userById(it.g.owner_id)) : null,
  member_count: get('SELECT COUNT(*) AS n FROM members WHERE guild_id = ?', it.g.id).n,
});
function previewRemoval(ctx) {
  const view = itemView(resolveItem(str(ctx.body, 'url', 1, 500)));
  ctx.audit = { action: 'removal.preview', target_type: view.type, target_id: view.type === 'message' ? null : view.guild.id };
  return view;
}

const PRESERVED = () => join(DATA_DIR, 'preserved');
async function removeByLink(ctx) {
  const url = str(ctx.body, 'url', 1, 500);
  const s = statement(ctx.body);
  const it = resolveItem(url);
  if (it.kind === 'server') requireMfa(ctx);
  const id = snowflake();
  const now = Date.now();
  let snapshot, authorId, target;
  if (it.kind === 'message') {
    const { m, ch } = it;
    const files = all('SELECT * FROM attachments WHERE message_id = ? ORDER BY rowid', m.id);
    // the files themselves are kept too: deleting the message deletes them
    if (files.length) await mkdir(join(PRESERVED(), id), { recursive: true });
    for (const a of files) await copyFile(join(DATA_DIR, 'attachments', a.channel_id, a.id), join(PRESERVED(), id, a.id)).catch(e => console.error(`preserve ${a.id}: ${e.message}`));
    snapshot = {
      content: m.content, timestamp: m.timestamp, edited_timestamp: m.edited_timestamp, type: m.type, embeds: json(m.embeds, []), webhook_id: m.webhook_id ?? null,
      attachments: files.map(a => ({ id: a.id, filename: a.filename, size: a.size, content_type: a.content_type, url: attachmentUrl(a), preserved: `preserved/${id}/${a.id}` })),
    };
    authorId = m.author_id;
    target = { guild_id: ch.guild_id, channel_id: ch.id, message_id: m.id, name: `${it.g.name} › #${ch.name}` };
    const viewers = viewersOf(ch);
    deleteMessages([m]);
    sendToUsers(viewers, 'MESSAGE_DELETE', { id: m.id, channel_id: ch.id, guild_id: ch.guild_id });
    audit({ user: ctx.user, req: ctx.req }, ch.guild_id, A.MESSAGE_DELETE, m.author_id, { options: { channel_id: ch.id, count: '1' } });
  } else {
    const { g } = it;
    snapshot = {
      content: '', server: { id: g.id, name: g.name, description: g.description, owner_id: g.owner_id, created_at: iso(Number((BigInt(g.id) >> 22n) + 1420070400000n)) },
      channels: all('SELECT id, type, name FROM channels WHERE guild_id = ?', g.id), member_count: get('SELECT COUNT(*) AS n FROM members WHERE guild_id = ?', g.id).n,
      attachments: [],
    };
    authorId = g.owner_id;
    target = { guild_id: g.id, name: g.name };
    destroyGuild(g);
  }
  run(`INSERT INTO reports (id, source, reporter_id, message_id, channel_id, guild_id, author_id, reason, note, snapshot, created_at, status, actions, target_url, resolved_at, preserve_until)
       VALUES (?, 'removal', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'resolved', ?, ?, ?, ?)`, id, ctx.user.id, target.message_id ?? null, target.channel_id ?? null, target.guild_id ?? null,
  authorId, s.category, s.reason, JSON.stringify(snapshot), now, JSON.stringify([{ action: it.kind === 'message' ? 'remove_message' : 'remove_server', admin_id: ctx.user.id, at: iso(now), note: s.reason }]),
  url, now, now + PRESERVE_MS);
  decide(ctx, { userId: authorId, action: it.kind === 'message' ? 'remove_message' : 'remove_server', ...s, target, reportId: id });
  schedule();
  ctx.status = 201;
  ctx.audit = { action: `removal.${it.kind}`, target_type: 'report', target_id: id, details: { ...target, category: s.category, ground: s.ground } };
  return { id, preserve_until: iso(now + PRESERVE_MS) };
}

// preserved copies (removal rows and their files) go after 6 months
addJob({
  name: 'preserved removals',
  next: () => get('SELECT MIN(preserve_until) AS t FROM reports WHERE preserve_until IS NOT NULL').t,
  run: async now => {
    for (const r of all('SELECT id FROM reports WHERE preserve_until IS NOT NULL AND preserve_until <= ?', now)) {
      await rm(join(PRESERVED(), r.id), { recursive: true, force: true });
      run('DELETE FROM reports WHERE id = ?', r.id);
    }
  },
});

// --- transparency numbers -----------------------------------------------------------------------------------------------
function stats({ query }) {
  const year = intParam(query, 'year', new Date().getUTCFullYear(), 2020, 2100);
  const from = Date.UTC(year, 0, 1), to = Date.UTC(year + 1, 0, 1);
  const count = (sql, ...a) => Object.fromEntries(all(sql, ...a).map(r => [r.k, r.n]));
  const times = all(`SELECT resolved_at - created_at AS t FROM reports WHERE source IN ('user', 'public') AND resolved_at >= ? AND resolved_at < ?
                     ORDER BY t`, from, to).map(r => r.t);
  const median = times.length ? (times[(times.length - 1) >> 1] + times[times.length >> 1]) / 2 : null;
  return {
    year,
    notices: {
      by_source: { ...count(`SELECT source AS k, COUNT(*) AS n FROM reports WHERE source IN ('user', 'public') AND created_at >= ? AND created_at < ? GROUP BY source`, from, to),
        directory: get('SELECT COUNT(*) AS n FROM directory_reports WHERE created_at >= ? AND created_at < ?', from, to).n },
      by_category: count(`SELECT reason AS k, COUNT(*) AS n FROM reports WHERE source IN ('user', 'public') AND created_at >= ? AND created_at < ? GROUP BY reason`, from, to),
    },
    actions: count('SELECT action AS k, COUNT(*) AS n FROM moderation_decisions WHERE created_at >= ? AND created_at < ? GROUP BY action', from, to),
    removals_by_link: get("SELECT COUNT(*) AS n FROM reports WHERE source = 'removal' AND created_at >= ? AND created_at < ?", from, to).n,
    appeals: count('SELECT appeal_status AS k, COUNT(*) AS n FROM moderation_decisions WHERE appeal_at >= ? AND appeal_at < ? GROUP BY appeal_status', from, to),
    median_handling_hours: median == null ? null : Math.round(median / 36e5 * 10) / 10,
  };
}

// --- licences (AGPL §13) ---------------------------------------------------------------------------------------------------
// LICENSE and NOTICE sit at the repository root, or next to the server in the image (Dockerfile)
const licenceFile = name => [new URL(`../../../${name}`, import.meta.url), new URL(`../../${name}`, import.meta.url)].find(u => existsSync(u));
const licenses = () => Object.fromEntries(['LICENSE', 'NOTICE'].map(n => [n.toLowerCase(), licenceFile(n) ? readFileSync(licenceFile(n), 'utf8') : null]).concat([['source_url', setting('source_url')]]));

const open = { open: true };
const admin = { admin: true, userOnly: true };
export default [
  ['GET', '/legal/licenses', licenses, open],
  ['GET', '/legal/status', legalStatus, { userOnly: true }],
  ['POST', '/legal/accept', accept, { userOnly: true }],
  ['POST', '/legal/notices', notice, { open: true, maxBody: 16 * 1024, rateLimit: { max: 5, windowMs: 3_600_000 } }],
  ['POST', '/legal/notices/status', noticeStatus, { open: true, maxBody: 1024, rateLimit: { max: 30, windowMs: 3_600_000 } }],
  ['POST', '/legal/appeals/lookup', lookupAppeal, { open: true, maxBody: 1024, rateLimit: { max: 30, windowMs: 3_600_000 } }],
  ['POST', '/legal/appeals', fileAppeal, { open: true, maxBody: 16 * 1024, rateLimit: { max: 5, windowMs: 3_600_000 } }],
  ['GET', '/legal/:doc', getDoc, open],
  ['GET', '/admin/legal', adminLegal, admin],
  ['PUT', '/admin/legal/:doc', putDoc, { ...admin, maxBody: 512 * 1024 }],
  ['POST', '/admin/removals/preview', previewRemoval, admin],
  ['POST', '/admin/removals', removeByLink, admin],
  ['GET', '/admin/appeals', listAppeals, admin],
  ['POST', '/admin/appeals/:decision_id', decideAppeal, admin],
  ['GET', '/admin/reports/stats', stats, admin],
];
