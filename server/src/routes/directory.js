// v7 server directory, on the user API's discovery routes and shapes (user docs, resources/discovery.mdx; Join Guild in
// resources/guild.mdx). Both roles: Manage Server members list their server (GET/PATCH /guilds/:id/discovery-metadata) and
// anyone may join a listed server (PUT /guilds/:id/members/@me); on a connected node the listing goes to the hub with the
// next heartbeat (sent at once). Hub only: browsing (GET /discoverable-guilds), reports and moderation.
import { snowflake } from '../snowflake.js';
import { get, all, run, json, guildObj, isMember } from '../db.js';
import { HttpError, invalid, intParam, notFound } from '../errors.js';
import { P } from '../permissions.js';
import { isOnline } from '../gateway.js';
import { proxyUrl } from '../proxy.js';
import { isHub, fedState, heartbeat } from '../federation.js';
import { REPORT_REASONS } from './admin.js';
import { hubOnly, clean, listingInput, nodePublic, CATEGORIES, rememberedHide, rememberHide, forgetHide } from './hub.js';
import { loadGuild } from './guilds.js';
import { addToGuild } from './invites.js';

const iso = ms => (ms ? new Date(ms).toISOString() : null);
const CATEGORY_NAMES = { esports: 'Esports', gaming: 'Gaming', community: 'Community', music: 'Music', education: 'Education', tech: 'Science & Tech', art: 'Art', entertainment: 'Entertainment', other: 'Other' };
// discovery categories are integers: 1 = esports … 9 = other (the order of CATEGORIES)
const categoryId = name => CATEGORIES.indexOf(name) + 1;
const categoryName = id => CATEGORIES[Number(id) - 1];

// a discoverable guild object (+ Cillhub: icon_url/banner_url ready to use, node: the node directory record or null).
// Hub servers show live name, description, icon and member count; node servers the node's synced data, images through
// the media proxy (never the node's own URL)
export function entryObj(d) {
  const g = !d.node_id && get('SELECT * FROM guilds WHERE id = ?', d.guild_id);
  const node = d.node_id && get('SELECT * FROM fed_nodes WHERE id = ?', d.node_id);
  const members = g && all('SELECT user_id FROM members WHERE guild_id = ?', g.id).map(m => m.user_id);
  return {
    id: d.guild_id, name: g ? g.name : d.name, description: (g ? clean(g.description ?? '', 300) : d.description) || null,
    icon: g ? g.icon : null, banner: g ? g.banner : null, splash: null, discovery_splash: null, features: ['DISCOVERABLE'],
    icon_url: g ? (g.icon ? `/icons/${g.id}/${g.icon}.png` : null) : d.icon_url && proxyUrl(d.icon_url),
    banner_url: g ? (g.banner ? `/banners/${g.id}/${g.banner}.png` : null) : d.banner_url && proxyUrl(d.banner_url),
    keywords: json(d.tags, []), preferred_locale: d.language ?? 'en-US', primary_category_id: categoryId(d.category),
    approximate_member_count: g ? members.length : d.member_count, approximate_presence_count: g ? members.filter(isOnline).length : null,
    node: node ? nodePublic(node) : null,
  };
}

// --- listing a server (Manage Server) ---------------------------------------------------------------------------------
const listing = guildId => get(`SELECT * FROM directory_entries WHERE node_id = '' AND guild_id = ?`, guildId);
// the discovery metadata object (+ Cillhub: listed, hidden, preferred_locale; on nodes the hub sync state)
// on a node, `hidden` comes from the hub (its last heartbeat answer lists the node's servers hub admins hid)
const hubHidden = guildId => (isHub ? null : fedState()?.hidden?.find(h => h.guild_id === guildId) ?? null);
const metadataObj = (guildId, d) => ({
  guild_id: guildId, listed: !!d, hidden: !!d?.hidden || !!(d && hubHidden(guildId)), hidden_reason: d ? (d.hidden_reason ?? hubHidden(guildId)?.reason ?? null) : null,
  primary_category_id: d ? categoryId(d.category) : 0, keywords: d ? json(d.tags, []) : null,
  preferred_locale: d?.language ?? null, emoji_discoverability_enabled: false, is_published: false, reasons_to_join: [], social_links: null,
  about: null, category_ids: [], partner_actioned_timestamp: null, partner_application_timestamp: null,
  ...(!isHub && { hub_status: fedState()?.status ?? null, synced_at: fedState()?.last_heartbeat_at ?? null, sync_error: fedState()?.last_error ?? null }),
});
const notConnected = () => new HttpError(400, 0, 'This instance is not connected to a hub, so it has no server directory.');

function getMetadata({ params, user }) {
  const d = listing(loadGuild(params.id, user, P.MANAGE_GUILD).id);
  if (!d) throw notFound(0, 'Discovery metadata');
  return metadataObj(d.guild_id, d);
}
// PATCH {listed, primary_category_id, keywords (≤ 5 × 30), preferred_locale}; listed false removes the listing
async function patchMetadata(ctx) {
  const g = loadGuild(ctx.params.id, ctx.user, P.MANAGE_GUILD);
  const b = ctx.body ?? {};
  const old = listing(g.id);
  if (b.listed === false) {
    if (old) run('DELETE FROM directory_entries WHERE id = ?', old.id);
    if (!isHub && fedState()) await heartbeat();
    return metadataObj(g.id, null);
  }
  if (!isHub && !fedState()) throw notConnected();
  const category = b.primary_category_id != null ? categoryName(b.primary_category_id) : old?.category;
  if (!category) throw invalid('primary_category_id', 'BASE_TYPE_CHOICES', `Must be one of 1–${CATEGORIES.length}.`);
  const input = listingInput({
    category, tags: b.keywords ?? (old ? json(old.tags, []) : []), language: b.preferred_locale !== undefined ? b.preferred_locale : old?.language ?? null,
    description: g.description ?? '',
  });
  const now = Date.now();
  // hub-local guilds use an empty node id, the same key the hide map uses. Unlisting deletes the row; the map keeps the hide.
  const hide = isHub ? rememberedHide('', g.id) : null;
  run(`INSERT INTO directory_entries (id, node_id, guild_id, name, description, tags, category, language, member_count, invite_code, hidden, hidden_reason, created_at, updated_at)
       VALUES (?, '', ?, ?, ?, ?, ?, ?, 0, '', ?, ?, ?, ?)
       ON CONFLICT (node_id, guild_id) DO UPDATE SET name = excluded.name, description = excluded.description, tags = excluded.tags,
         category = excluded.category, language = excluded.language, hidden = excluded.hidden, hidden_reason = excluded.hidden_reason, updated_at = excluded.updated_at`,
  snowflake(), g.id, g.name, input.description, JSON.stringify(input.tags), input.category, input.language, hide ? 1 : 0, hide?.reason ?? null, now, now);
  if (!isHub) await heartbeat(); // the hub sees it now, not in 5 minutes
  return metadataObj(g.id, listing(g.id));
}

// PUT /guilds/:id/members/@me (Join Guild): only for servers listed (and not hidden) in this instance's directory; 204 when
// already a member, else the guild object
function joinListed({ params, user }) {
  const g = get('SELECT * FROM guilds WHERE id = ?', params.id);
  if (g && isMember(g.id, user.id)) return undefined;
  const d = g && listing(g.id);
  if (!d || d.hidden) throw notFound(10004, 'Guild');
  addToGuild(g, user);
  return guildObj(g, true);
}

// --- browsing (hub users) -------------------------------------------------------------------------------------------------
// visible: not hidden; hub servers that still exist with invites allowed; node servers of active nodes
const VISIBLE = `d.hidden = 0 AND ((d.node_id = '' AND EXISTS (SELECT 1 FROM guilds g WHERE g.id = d.guild_id AND g.invites_disabled = 0))
  OR EXISTS (SELECT 1 FROM fed_nodes n WHERE n.id = d.node_id AND n.status = 'active'))`;
const like = q => `%${q.replace(/[\\%_]/g, c => `\\${c}`)}%`;

// GET /discoverable-guilds?query&category_id&locale&limit (≤ 48, 24)&offset -> {guilds, total, limit, offset}, by member count
function browse({ query }) {
  hubOnly();
  // hub servers: keep the stored name, description and member count fresh for search and sorting
  run(`UPDATE directory_entries SET name = COALESCE((SELECT name FROM guilds WHERE id = guild_id), name),
       description = COALESCE((SELECT description FROM guilds WHERE id = guild_id), ''),
       member_count = (SELECT COUNT(*) FROM members WHERE guild_id = directory_entries.guild_id) WHERE node_id = ''`);
  const q = String(query.get('query') ?? '').trim().slice(0, 100);
  const category = query.get('category_id') ? categoryName(query.get('category_id')) ?? '-' : '';
  const language = query.get('locale') ?? '';
  const where = `${VISIBLE} AND (? = '' OR d.category = ?) AND (? = '' OR d.language = ?)
    AND (? = '' OR d.name LIKE ? ESCAPE '\\' OR d.description LIKE ? ESCAPE '\\' OR d.tags LIKE ? ESCAPE '\\')`;
  const args = [category, category, language, language, q, like(q), like(q), like(q)];
  const limit = intParam(query, 'limit', 24, 1, 48);
  const offset = intParam(query, 'offset', 0, 0, 2999);
  return {
    guilds: all(`SELECT d.* FROM directory_entries d WHERE ${where} ORDER BY d.member_count DESC, d.id LIMIT ? OFFSET ?`, ...args, limit, offset).map(entryObj),
    total: get(`SELECT COUNT(*) AS n FROM directory_entries d WHERE ${where}`, ...args).n, limit, offset,
  };
}
// both roles, so a node's own Server Directory settings page gets the same list
const categories = () => CATEGORIES.map(id => ({ id: categoryId(id), name: CATEGORY_NAMES[id], is_primary: true }));

// a listing by guild id (hub servers first; node guild ids are another instance's snowflakes)
const entryOf = (guildId, extra = '') => get(`SELECT d.* FROM directory_entries d WHERE d.guild_id = ? ${extra} ORDER BY d.node_id = '' DESC LIMIT 1`, guildId);

// POST /discoverable-guilds/:guild_id/report {reason, note?}: reason is one of the message report reasons, or free text
// (kept as the note with reason "other")
function report(ctx) {
  hubOnly();
  const d = entryOf(ctx.params.guild_id, `AND ${VISIBLE}`);
  if (!d) throw notFound(10004, 'Guild');
  const raw = clean(ctx.body?.reason, 1000);
  if (!raw) throw invalid('reason', 'BASE_TYPE_REQUIRED', 'Say what is wrong with this server.');
  const known = REPORT_REASONS.includes(raw);
  if (get('SELECT 1 FROM directory_reports WHERE entry_id = ? AND reporter_id = ?', d.id, ctx.user.id)) throw new HttpError(400, 0, 'You already reported this server.');
  const id = snowflake();
  run('INSERT INTO directory_reports (id, entry_id, reporter_id, reason, note, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    id, d.id, ctx.user.id, known ? raw : 'other', (known ? clean(ctx.body.note, 1000) : raw) || null, Date.now());
  ctx.status = 201;
  return { id, guild_id: d.guild_id, reason: known ? raw : 'other', created_at: new Date().toISOString() };
}

// --- moderation (hub admins) --------------------------------------------------------------------------------------------
const openReports = d => all(`SELECT * FROM directory_reports WHERE entry_id = ? AND status = 'open' ORDER BY created_at DESC`, d.id)
  .map(r => ({ id: r.id, reason: r.reason, note: r.note, reporter_id: r.reporter_id, created_at: iso(r.created_at) }));
const adminEntry = d => ({ guild: entryObj(d), hidden: !!d.hidden, hidden_reason: d.hidden_reason, reports: openReports(d) });

// GET /admin/directory?query&filter=all|reported|hidden&limit -> [{guild, hidden, hidden_reason, reports (open)}]
function adminList({ query }) {
  hubOnly();
  const filter = query.get('filter') ?? 'all';
  const q = String(query.get('query') ?? '').trim().slice(0, 100);
  const where = filter === 'hidden' ? 'd.hidden = 1'
    : filter === 'reported' ? `EXISTS (SELECT 1 FROM directory_reports r WHERE r.entry_id = d.id AND r.status = 'open')` : '1';
  return all(`SELECT d.* FROM directory_entries d WHERE ${where} AND (? = '' OR d.name LIKE ? ESCAPE '\\') ORDER BY d.updated_at DESC LIMIT ?`,
    q, like(q), intParam(query, 'limit', 100, 1, 500)).map(adminEntry);
}
function loadEntry(guildId) {
  const d = entryOf(guildId);
  if (!d) throw notFound(10004, 'Guild');
  return d;
}
// PATCH /admin/directory/:guild_id {hidden, reason?}: hiding survives heartbeats; the owner sees `hidden` in the metadata
function setHidden(ctx) {
  hubOnly();
  const d = loadEntry(ctx.params.guild_id);
  if (typeof ctx.body?.hidden !== 'boolean') throw invalid('hidden', 'BASE_TYPE_BOOLEAN', 'Must be a boolean.');
  const hidden = ctx.body.hidden;
  const reason = hidden ? clean(ctx.body.reason, 200) || null : null;
  run('UPDATE directory_entries SET hidden = ?, hidden_reason = ? WHERE id = ?', Number(hidden), reason, d.id);
  if (hidden) rememberHide(d.node_id, d.guild_id, reason);
  else forgetHide(d.node_id, d.guild_id);
  if (hidden) run(`UPDATE directory_reports SET status = 'resolved', action = 'hide', resolved_by = ?, resolved_at = ? WHERE entry_id = ? AND status = 'open'`, ctx.user.id, Date.now(), d.id);
  ctx.audit = { action: hidden ? 'directory.hide' : 'directory.unhide', target_type: 'directory_entry', target_id: d.id, details: { guild_id: d.guild_id, node_id: d.node_id || null, reason: ctx.body.reason ?? null } };
  return adminEntry(loadEntry(d.guild_id));
}
// DELETE /admin/directory/:guild_id/reports: dismisses the open reports
function dismiss(ctx) {
  hubOnly();
  const d = loadEntry(ctx.params.guild_id);
  const n = run(`UPDATE directory_reports SET status = 'resolved', action = 'dismiss', resolved_by = ?, resolved_at = ? WHERE entry_id = ? AND status = 'open'`, ctx.user.id, Date.now(), d.id).changes;
  ctx.audit = { action: 'directory.reports.dismiss', target_type: 'directory_entry', target_id: d.id, details: { guild_id: d.guild_id, count: n } };
}

const user = { userOnly: true };
const admin = { admin: true };
export default [
  ['GET', '/guilds/:id/discovery-metadata', getMetadata, user],
  ['PATCH', '/guilds/:id/discovery-metadata', patchMetadata, user],
  ['PUT', '/guilds/:id/members/@me', joinListed, user],
  ['GET', '/discovery/categories', categories, user],
  ['GET', '/discoverable-guilds', browse, user],
  ['POST', '/discoverable-guilds/:guild_id/report', report, user],
  ['GET', '/admin/directory', adminList, admin],
  ['PATCH', '/admin/directory/:guild_id', setHidden, admin],
  ['DELETE', '/admin/directory/:guild_id/reports', dismiss, admin],
];
