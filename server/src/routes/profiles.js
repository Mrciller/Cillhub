// User profiles (GET /users/:id/profile per user docs) and private notes
import { get, all, run, json, userById, userObj, memberRow, memberObj, isFriend } from '../db.js';
import { HttpError, notFound, missingAccess, idParam } from '../errors.js';
import { sendToUsers } from '../gateway.js';
import { hasBlocked } from './relationships.js';
import { notesOf } from '../userdata.js';

const mutualGuilds = (a, b) => all(`SELECT y.guild_id AS id, y.nick FROM members x JOIN members y ON y.guild_id = x.guild_id
                                    WHERE x.user_id = ? AND y.user_id = ?`, a, b);
const mutualFriends = (a, b) => all(`SELECT x.other_id AS id FROM relationships x JOIN relationships y ON y.other_id = x.other_id
                                     WHERE x.user_id = ? AND y.user_id = ? AND x.type = 1 AND y.type = 1`, a, b);

// visible for yourself, bots, friends, people sharing a guild or with an outgoing request to you (docs)
function profile({ params, query, user }) {
  const u = userById(params.id === '@me' ? user.id : params.id);
  if (!u) throw notFound(10013, 'User');
  const guilds = mutualGuilds(user.id, u.id);
  const pending = get('SELECT 1 FROM relationships WHERE user_id = ? AND other_id = ? AND type = 4', u.id, user.id);
  if (u.id !== user.id && !u.bot && !guilds.length && !isFriend(user.id, u.id) && !pending) throw missingAccess();
  const guildId = idParam(query, 'guild_id');
  const blocked = hasBlocked(u.id, user.id); // fields go missing for whoever is blocked by the profile's owner (docs)
  const c = json(u.customization, {});
  const meta = {
    bio: u.bio ?? '', accent_color: u.accent_color ?? null, pronouns: u.pronouns ?? '', banner: u.banner ?? null,
    theme_colors: c.theme_colors ?? null, profile_effect: c.profile_effect ?? null, widgets: c.widgets ?? [], // v6
  };
  const connections = all('SELECT * FROM user_connections WHERE user_id = ? AND show_on_profile = 1 ORDER BY created_at ASC', u.id).map(r => ({
    id: r.id,
    type: r.type,
    name: r.name,
    verified: Boolean(r.verified),
    show_on_profile: Boolean(r.show_on_profile),
    metadata: json(r.metadata, null),
  }));
  const out = {
    user: { ...userObj(u), ...(!blocked && { bio: meta.bio, pronouns: meta.pronouns }) },
    connected_accounts: blocked ? [] : connections, premium_type: null, premium_since: null, premium_guild_since: null, badges: [], guild_badges: [],
  };
  if (blocked) return out;
  Object.assign(out, {
    user_profile: meta,
    ...(query.get('with_mutual_guilds') !== 'false' && { mutual_guilds: u.id === user.id ? [] : guilds }),
    mutual_friends_count: u.id === user.id || u.bot ? 0 : mutualFriends(user.id, u.id).length,
    ...(query.get('with_mutual_friends') === 'true' && { mutual_friends: mutualFriends(user.id, u.id).map(f => userObj(userById(f.id))) }),
  });
  if (u.bot) out.application = { id: u.id, flags: get('SELECT flags FROM applications WHERE id = ?', u.id)?.flags ?? 0, verified: false, storefront_available: false };
  const m = guildId && guilds.some(g => g.id === guildId) && memberRow(guildId, u.id);
  if (m) {
    out.guild_member = { ...memberObj(m), bio: m.member_bio ?? '' };
    out.guild_member_profile = { guild_id: guildId, bio: m.member_bio ?? '', banner: m.member_banner ?? null, pronouns: '', accent_color: null };
  }
  return out;
}

function getNote({ params, user }) {
  const n = get('SELECT note FROM notes WHERE user_id = ? AND target_id = ?', user.id, params.user_id);
  if (!n) throw notFound(10013, 'User');
  return { note: n.note, note_user_id: params.user_id, user_id: user.id };
}

function getMutualFriends({ params, user }) {
  const targetId = params.id === '@me' ? user.id : params.id;
  const target = userById(targetId);
  if (!target) throw notFound(10013, 'User');
  if (target.id === user.id || target.bot) return [];
  return mutualFriends(user.id, target.id).map(f => userObj(userById(f.id))).filter(Boolean);
}

function getMutualGuilds({ params, user }) {
  const targetId = params.id === '@me' ? user.id : params.id;
  const target = userById(targetId);
  if (!target) throw notFound(10013, 'User');
  if (target.id === user.id) return [];
  const list = mutualGuilds(user.id, target.id);
  return list.map(g => {
    const guild = get('SELECT id, name, icon FROM guilds WHERE id = ?', g.id);
    return guild ? { id: guild.id, name: guild.name, icon: guild.icon, nick: g.nick } : null;
  }).filter(Boolean);
}

// an empty or null note deletes it; at most 256 characters
function putNote({ params, body, user }) {
  if (!userById(params.user_id)) throw notFound(10013, 'User');
  const note = body?.note ?? '';
  if (typeof note !== 'string' || note.length > 256) throw new HttpError(400, 50035, 'Invalid Form Body', { note: { _errors: [{ code: 'BASE_TYPE_MAX_LENGTH', message: 'Must be 256 or fewer in length.' }] } });
  if (note) run('INSERT INTO notes (user_id, target_id, note) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET note = excluded.note', user.id, params.user_id, note);
  else run('DELETE FROM notes WHERE user_id = ? AND target_id = ?', user.id, params.user_id);
  sendToUsers([user.id], 'USER_NOTE_UPDATE', { id: params.user_id, note });
}

const user = { userOnly: true };
export default [
  ['GET', '/users/@me/notes', ({ user: me }) => notesOf(me.id), user],
  ['GET', '/users/@me/notes/:user_id', getNote, user],
  ['PUT', '/users/@me/notes/:user_id', putNote, user],
  ['GET', '/users/:id/mutual-friends', getMutualFriends, user],
  ['GET', '/users/:id/mutual-guilds', getMutualGuilds, user],
  ['GET', '/users/:id/profile', profile, user],
];
