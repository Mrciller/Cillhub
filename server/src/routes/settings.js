// User settings document (allow-listed) and user guild settings (notification settings)
import { get, isMember } from '../db.js';
import { notFound, missingAccess } from '../errors.js';
import { sendToUsers, refreshPresence } from '../gateway.js';
import { addJob, schedule } from '../timers.js';
import {
  settingsOf, settingsPatch, saveSettings, favoriteGifsChange, privateNodesChange, patchGuildSettings, nextCustomStatusExpiry, expiredCustomStatus,
} from '../userdata.js';

function patchSettings({ body, user }) {
  const changes = settingsPatch(body, user.id);
  saveSettings(user.id, changes);
  sendToUsers([user.id], 'USER_SETTINGS_UPDATE', changes);
  if ('status' in changes || 'custom_status' in changes) refreshPresence(user.id);
  if (changes.custom_status?.expires_at) schedule();
  return settingsOf(user.id);
}

function changeFavoriteGifs(user, list) {
  saveSettings(user.id, { favorite_gifs: list });
  sendToUsers([user.id], 'USER_SETTINGS_UPDATE', { favorite_gifs: list });
  return settingsOf(user.id);
}
function changePrivateNodes(user, list) {
  saveSettings(user.id, { private_nodes: list });
  sendToUsers([user.id], 'USER_SETTINGS_UPDATE', { private_nodes: list });
  return settingsOf(user.id);
}

// guild id '@me' holds the settings for private channels
function patchGuildSettingsRoute({ params, body, user }) {
  const key = params.guild_id;
  if (key !== '@me') {
    if (!get('SELECT 1 FROM guilds WHERE id = ?', key)) throw notFound(10004, 'Guild');
    if (!isMember(key, user.id)) throw missingAccess();
  }
  const channelOk = id => (key === '@me'
    ? !!get('SELECT 1 FROM dm_recipients WHERE channel_id = ? AND user_id = ?', id, user.id)
    : !!get('SELECT 1 FROM channels WHERE id = ? AND guild_id = ?', id, key));
  const out = patchGuildSettings(user.id, key, body, channelOk);
  sendToUsers([user.id], 'USER_GUILD_SETTINGS_UPDATE', out);
  return out;
}

// expired custom statuses are cleared and announced
addJob({
  name: 'custom status expiry',
  next: nextCustomStatusExpiry,
  run(now) {
    for (const id of expiredCustomStatus(now)) {
      saveSettings(id, { custom_status: null });
      sendToUsers([id], 'USER_SETTINGS_UPDATE', { custom_status: null });
      refreshPresence(id);
    }
  },
});

const user = { userOnly: true };
export default [
  ['GET', '/users/@me/settings', ({ user: me }) => settingsOf(me.id), user],
  ['PATCH', '/users/@me/settings', patchSettings, user],
  ['PUT', '/users/@me/settings/favorite-gifs', ({ body, user: me }) => changeFavoriteGifs(me, favoriteGifsChange(me.id, body ?? null)), user],
  ['DELETE', '/users/@me/settings/favorite-gifs', ({ query, user: me }) => changeFavoriteGifs(me, favoriteGifsChange(me.id, undefined, query.get('url'))), user],
  ['PUT', '/users/@me/settings/private-nodes', ({ body, user: me }) => changePrivateNodes(me, privateNodesChange(me.id, body ?? null)), user],
  ['DELETE', '/users/@me/settings/private-nodes', ({ query, user: me }) => changePrivateNodes(me, privateNodesChange(me.id, undefined, query.get('origin'))), user],
  ['PATCH', '/users/@me/guilds/:guild_id/settings', patchGuildSettingsRoute, user],
];
