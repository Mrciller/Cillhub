// Account-private records, including credentials which must never appear in an export.
// Shared messages, votes, reactions, moderation history and guild assets retain the anonymized user ID; so do 1:1 DM
// memberships (the other person keeps the conversation with "Deleted User"; group DMs are left in anonymize()).
// Add new private tables here when adding a migration; export columns are deliberately explicit.
export const PRIVATE_DATA = [
  ['tokens', 'user_id'], ['mfa_backup_codes', 'user_id'], ['password_resets', 'user_id'],
  ['push_subscriptions', 'user_id'], ['webauthn_credentials', 'user_id'],
  ['notes', 'user_id', 'notes', 'target_id, note'],
  ['user_guild_settings', 'user_id', 'guild_settings', 'guild_id, settings'],
  ['recent_mentions', 'user_id', 'recent_mentions', 'message_id, channel_id, guild_id, kind, created_at'],
  ['scheduled_messages', 'user_id', 'scheduled_messages', 'id, channel_id, body, send_at, created_at'],
  ['saved_messages', 'user_id', 'bookmarks', 'message_id, channel_id, saved_at AS created_at, due_at, folder_id, tags'],
  ['saved_message_folders', 'user_id', 'saved_folders', 'id, name, color, icon, created_at'],
  ['user_connections', 'user_id', 'connections', 'id, type, name, verified, show_on_profile, metadata, created_at'],
  ['bot_reminders', 'user_id', 'reminders', 'id, channel_id, guild_id, content, remind_at'],
  ['user_sounds', 'user_id', 'sounds', 'id, name, volume'],
  ['user_e2ee_keys', 'user_id', 'encryption_keys', 'public_key, created_at, updated_at'],
  ['read_states', 'user_id', 'read_states', 'channel_id, last_message_id, mention_count'],
  ['thread_members', 'user_id', 'thread_memberships', 'channel_id, join_timestamp, flags'],
  ['scheduled_event_users', 'user_id', 'event_subscriptions', 'event_id'],
  ['bot_card_members', 'user_id'], ['fed_node_accounts', 'user_id'],
  ['dm_requests', 'recipient_id', 'message_requests', 'channel_id, status, created_at'],
  ['recurring_messages', 'author_id', 'recurring_messages', 'id, channel_id, content, interval_type, time_of_day, next_run, created_at'],
];

export function deletePrivateData(db, userId) {
  for (const [table, column] of PRIVATE_DATA) db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(userId);
}
