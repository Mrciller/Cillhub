-- Existing connections were self-asserted. None have provider-backed ownership proof.
CREATE TABLE user_connections_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  show_on_profile INTEGER NOT NULL DEFAULT 1,
  metadata TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(user_id, type, name)
);
INSERT INTO user_connections_new SELECT id, user_id, type, name, 0, show_on_profile, metadata, created_at FROM user_connections;
DROP TABLE user_connections;
ALTER TABLE user_connections_new RENAME TO user_connections;
CREATE INDEX user_connections_user ON user_connections(user_id);

-- Backfill cleanup for previously anonymized accounts (soft deletion does not trigger FK cascades).
DELETE FROM user_connections WHERE user_id IN (SELECT id FROM users WHERE deleted = 1);
DELETE FROM saved_messages WHERE user_id IN (SELECT id FROM users WHERE deleted = 1);
DELETE FROM saved_message_folders WHERE user_id IN (SELECT id FROM users WHERE deleted = 1);
DELETE FROM user_e2ee_keys WHERE user_id IN (SELECT id FROM users WHERE deleted = 1);
DELETE FROM password_resets WHERE user_id IN (SELECT id FROM users WHERE deleted = 1);
DELETE FROM read_states WHERE user_id IN (SELECT id FROM users WHERE deleted = 1);
DELETE FROM thread_members WHERE user_id IN (SELECT id FROM users WHERE deleted = 1);
DELETE FROM scheduled_event_users WHERE user_id IN (SELECT id FROM users WHERE deleted = 1);
DELETE FROM bot_card_members WHERE user_id IN (SELECT id FROM users WHERE deleted = 1);
DELETE FROM fed_node_accounts WHERE user_id IN (SELECT id FROM users WHERE deleted = 1);
DELETE FROM dm_requests WHERE recipient_id IN (SELECT id FROM users WHERE deleted = 1);
DELETE FROM recurring_messages WHERE author_id IN (SELECT id FROM users WHERE deleted = 1);
UPDATE users SET calendar_token = NULL, hub_user_id = NULL, hub_avatar = NULL, home = NULL, mfa_last_step = 0 WHERE deleted = 1;
