-- v13: Server guide, saved message folders & tags, verified user connections

CREATE TABLE IF NOT EXISTS guild_server_guide (
  guild_id TEXT PRIMARY KEY REFERENCES guilds(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1,
  welcome_message TEXT,
  new_member_actions TEXT NOT NULL DEFAULT '[]',
  resource_pages TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS saved_message_folders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT,
  icon TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS saved_message_folders_user ON saved_message_folders(user_id);

ALTER TABLE saved_messages ADD COLUMN folder_id TEXT REFERENCES saved_message_folders(id) ON DELETE SET NULL;
ALTER TABLE saved_messages ADD COLUMN tags TEXT DEFAULT '[]';

CREATE TABLE IF NOT EXISTS user_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 1,
  show_on_profile INTEGER NOT NULL DEFAULT 1,
  metadata TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(user_id, type, name)
);
CREATE INDEX IF NOT EXISTS user_connections_user ON user_connections(user_id);
