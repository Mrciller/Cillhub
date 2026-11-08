import { get, run, json, memberIds, memberRow, memberObj, guildObj } from '../db.js';
import { HttpError, str, int, bool, invalid, snowflakeField, notFound, missingAccess } from '../errors.js';
import { saveImage, removeImage } from '../files.js';
import { P, has } from '../permissions.js';
import { sendToUsers } from '../gateway.js';
import { audit, A, diff } from '../audit.js';
import { recheck } from '../voice.js';
import { loadGuild } from './guilds.js';

const guildRow = id => get('SELECT * FROM guilds WHERE id = ?', id);
const guildUpdate = g => sendToUsers(memberIds(g.id), 'GUILD_UPDATE', guildObj(guildRow(g.id)));

// --- welcome screen (guild.mdx) ---
const welcomeObj = g => {
  const w = json(g.welcome_screen, {});
  return {
    description: w.description ?? g.description ?? null, welcome_channels: w.welcome_channels ?? [],
    background: w.background ?? null, accent_color: w.accent_color ?? null, // v6 Cillhub extras
  };
};
export const welcomeFor = g => (json(g.welcome_screen)?.enabled ? welcomeObj(g) : undefined);

function getWelcome({ params, user }) {
  const g = loadGuild(params.id, user);
  if (!json(g.welcome_screen)?.enabled && !has(g.perms, P.MANAGE_GUILD)) throw notFound(10069, 'Welcome Screen');
  return welcomeObj(g);
}

async function patchWelcome(ctx) {
  const g = loadGuild(ctx.params.id, ctx.user, P.MANAGE_GUILD);
  const body = ctx.body ?? {};
  const w = { enabled: false, ...json(g.welcome_screen, {}) };
  if (body.enabled != null) w.enabled = bool(body, 'enabled');
  if (body.description !== undefined) w.description = body.description === null ? null : str(body, 'description', 0, 140) || null;
  if (body.welcome_channels != null) {
    if (!Array.isArray(body.welcome_channels) || body.welcome_channels.length > 5) throw invalid('welcome_channels', 'BASE_TYPE_MAX_LENGTH', 'At most 5 channels.');
    w.welcome_channels = body.welcome_channels.map(c => {
      const id = snowflakeField(c, 'channel_id');
      if (!get('SELECT 1 FROM channels WHERE id = ? AND guild_id = ? AND type NOT IN (4, 10, 11, 12)', id, g.id)) throw notFound(10003, 'Channel');
      return {
        channel_id: id, description: str(c, 'description', 1, 50),
        emoji_id: c.emoji_id == null ? null : snowflakeField(c, 'emoji_id'), emoji_name: c.emoji_name == null ? null : str(c, 'emoji_name', 1, 32),
      };
    });
  }
  if (body.accent_color !== undefined) w.accent_color = body.accent_color === null ? null : int(body, 'accent_color', 0, 0xffffff);
  const oldBackground = w.background ?? null;
  if (body.background !== undefined) w.background = await saveImage(body.background, 'background', 'welcome-backgrounds', g.id);
  run('UPDATE guilds SET welcome_screen = ? WHERE id = ?', JSON.stringify(w), g.id);
  if (oldBackground && oldBackground !== (w.background ?? null)) removeImage('welcome-backgrounds', g.id, oldBackground);
  audit(ctx, g.id, A.GUILD_UPDATE, g.id, { changes: diff({ welcome_screen: json(g.welcome_screen) }, { welcome_screen: w }) });
  guildUpdate(g);
  return welcomeObj(guildRow(g.id));
}

// --- rules screening (user docs: member verification with TERMS fields) ---
const verificationObj = g => {
  const v = json(g.member_verification, {});
  return { version: v.version ?? null, description: v.description ?? g.description ?? null, form_fields: v.form_fields ?? [] };
};
export const gateEnabled = g => !!json(g.member_verification)?.enabled;

function getVerification({ params, query, user }) {
  const g = guildRow(params.id);
  if (!g) throw notFound(10004, 'Guild');
  // non-members may read the rules through an invite of this guild, before joining
  const code = query.get('invite_code');
  const viaInvite = code && (get('SELECT 1 FROM invites WHERE code = ? AND guild_id = ?', code, g.id) || g.vanity_url_code === code);
  if (!viaInvite) loadGuild(g.id, user);
  if (!gateEnabled(g)) throw notFound(10068, 'Member Verification');
  return verificationObj(g);
}

function patchVerification(ctx) {
  const g = loadGuild(ctx.params.id, ctx.user, P.MANAGE_GUILD);
  const body = ctx.body ?? {};
  const v = { enabled: false, form_fields: [], ...json(g.member_verification, {}) };
  if (body.enabled != null) v.enabled = bool(body, 'enabled');
  if (body.description !== undefined) v.description = body.description === null ? null : str(body, 'description', 0, 300) || null;
  if (body.form_fields != null) {
    if (!Array.isArray(body.form_fields) || body.form_fields.length > 5) throw invalid('form_fields', 'BASE_TYPE_MAX_LENGTH', 'At most 5 fields.');
    v.form_fields = body.form_fields.map(f => {
      if (f?.field_type !== 'TERMS') throw invalid('form_fields', 'BASE_TYPE_CHOICES', 'Only TERMS fields are supported.');
      if (!Array.isArray(f.values) || !f.values.length || f.values.length > 16) throw invalid('form_fields', 'BASE_TYPE_BAD_LENGTH', 'Between 1 and 16 rules.');
      return {
        field_type: 'TERMS', label: str(f, 'label', 1, 300), values: f.values.map((x, i) => str(f.values, i, 1, 300)),
        required: true, description: null, automations: null,
      };
    });
  }
  if (v.enabled && !v.form_fields.length) throw invalid('form_fields', 'BASE_TYPE_REQUIRED', 'The gate needs rules to accept.');
  v.version = new Date().toISOString();
  run('UPDATE guilds SET member_verification = ? WHERE id = ?', JSON.stringify(v), g.id);
  audit(ctx, g.id, A.GUILD_UPDATE, g.id, { changes: diff({ member_verification: json(g.member_verification) }, { member_verification: v }) });
  guildUpdate(g);
  return verificationObj(guildRow(g.id));
}

// accepting the rules lifts `pending`; both the user-docs join request and a plain accept route land here
function accept(guildId, user) {
  const m = memberRow(guildId, user.id);
  if (!m) throw missingAccess();
  if (m.pending) {
    run('UPDATE members SET pending = 0 WHERE guild_id = ? AND user_id = ?', guildId, user.id);
    sendToUsers(memberIds(guildId), 'GUILD_MEMBER_UPDATE', { guild_id: guildId, ...memberObj(memberRow(guildId, user.id)) });
    recheck(guildId, user.id);
  }
  return memberObj(memberRow(guildId, user.id));
}

function joinRequest({ params, body, user }) {
  const g = guildRow(params.id);
  if (!g) throw notFound(10004, 'Guild');
  const fields = Array.isArray(body?.form_fields) ? body.form_fields : [];
  if (gateEnabled(g) && !fields.some(f => f?.field_type === 'TERMS' && f.response === true)) {
    throw invalid('form_fields', 'BASE_TYPE_REQUIRED', 'Accept the rules (TERMS response true).');
  }
  const m = accept(g.id, user);
  return {
    id: g.id, join_request_id: g.id, created_at: m.joined_at, application_status: 'APPROVED', guild_id: g.id, user_id: user.id,
    form_responses: fields, last_seen: null, rejection_reason: null, interview_channel_id: null,
  };
}

// --- vanity URL ---
function patchVanity(ctx) {
  const g = loadGuild(ctx.params.id, ctx.user, P.MANAGE_GUILD);
  const raw = ctx.body?.code;
  const code = raw === null || raw === '' ? null : raw;
  if (code !== null && (typeof code !== 'string' || !/^[a-z0-9-]{3,32}$/.test(code))) throw invalid('code', 'BASE_TYPE_BAD_LENGTH', 'Codes are 3-32 characters of a-z, 0-9 and -.');
  if (code && (get('SELECT 1 FROM guilds WHERE vanity_url_code = ? AND id != ?', code, g.id) || get('SELECT 1 FROM invites WHERE code = ?', code))) {
    throw new HttpError(400, 50020, 'Invite code is either invalid or taken');
  }
  run('UPDATE guilds SET vanity_url_code = ?, vanity_uses = CASE WHEN vanity_url_code IS ? THEN vanity_uses ELSE 0 END WHERE id = ?', code, code, g.id);
  audit(ctx, g.id, A.GUILD_UPDATE, g.id, { changes: diff({ vanity_url_code: g.vanity_url_code }, { vanity_url_code: code }) });
  guildUpdate(g);
  const out = guildRow(g.id);
  return { code: out.vanity_url_code, uses: out.vanity_uses };
}

export default [
  ['GET', '/guilds/:id/welcome-screen', getWelcome],
  ['PATCH', '/guilds/:id/welcome-screen', patchWelcome, { maxBody: 12 * 1024 * 1024 }],
  ['GET', '/guilds/:id/member-verification', getVerification],
  ['PATCH', '/guilds/:id/member-verification', patchVerification],
  ['PUT', '/guilds/:id/requests/@me', joinRequest],
  ['POST', '/guilds/:id/members/@me/accept-rules', ({ params, user }) => accept(loadGuild(params.id, user).id, user)],
  ['GET', '/guilds/:id/vanity-url', ({ params, user }) => {
    const g = loadGuild(params.id, user, P.MANAGE_GUILD);
    return { code: g.vanity_url_code, uses: g.vanity_uses };
  }],
  ['PATCH', '/guilds/:id/vanity-url', patchVanity],
];
