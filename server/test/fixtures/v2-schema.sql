-- Frozen copy of the v2 schema (user_version 2), for the v2 -> v3 migration test.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  global_name TEXT,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL
, avatar TEXT, status TEXT NOT NULL DEFAULT 'online');
CREATE TABLE tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id)
);
CREATE TABLE guilds (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id)
, icon TEXT, system_channel_id TEXT);
CREATE TABLE members (
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  joined_at TEXT NOT NULL, nick TEXT, mute INTEGER NOT NULL DEFAULT 0, deaf INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id)
);
CREATE INDEX members_user ON members(user_id);
CREATE TABLE channels (
  id TEXT PRIMARY KEY,
  type INTEGER NOT NULL,
  guild_id TEXT REFERENCES guilds(id) ON DELETE CASCADE,
  name TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  topic TEXT,
  last_message_id TEXT
, parent_id TEXT, user_limit INTEGER NOT NULL DEFAULT 0);
CREATE INDEX channels_guild ON channels(guild_id);
CREATE TABLE dm_recipients (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX dm_recipients_user ON dm_recipients(user_id);
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id),
  content TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  edited_timestamp TEXT
, type INTEGER NOT NULL DEFAULT 0, reference_id TEXT, mention_everyone INTEGER NOT NULL DEFAULT 0, mention_roles TEXT NOT NULL DEFAULT '[]', pinned_at TEXT);
CREATE INDEX messages_channel ON messages(channel_id);
CREATE TABLE invites (
  code TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  inviter_id TEXT NOT NULL REFERENCES users(id),
  uses INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER -- unix ms, NULL = never
, max_uses INTEGER NOT NULL DEFAULT 0, max_age INTEGER NOT NULL DEFAULT 0, created_at TEXT);
CREATE TABLE roles (
  id TEXT PRIMARY KEY, -- @everyone: id = guild id
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color INTEGER NOT NULL DEFAULT 0,
  hoist INTEGER NOT NULL DEFAULT 0,
  mentionable INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL,
  permissions TEXT NOT NULL
);
CREATE INDEX roles_guild ON roles(guild_id);
CREATE TABLE member_roles (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (guild_id, user_id, role_id),
  FOREIGN KEY (guild_id, user_id) REFERENCES members(guild_id, user_id) ON DELETE CASCADE
);
CREATE TABLE overwrites (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL,
  type INTEGER NOT NULL, -- 0 role, 1 member
  allow TEXT NOT NULL,
  deny TEXT NOT NULL,
  PRIMARY KEY (channel_id, target_id)
);
CREATE TABLE bans (
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  reason TEXT,
  PRIMARY KEY (guild_id, user_id)
);
CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  size INTEGER NOT NULL,
  content_type TEXT NOT NULL, -- an inline type only when the magic bytes matched
  width INTEGER,
  height INTEGER
);
CREATE INDEX attachments_message ON attachments(message_id);
CREATE TABLE reactions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  PRIMARY KEY (message_id, emoji, user_id)
);
CREATE TABLE read_states (
  user_id TEXT NOT NULL REFERENCES users(id),
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  last_message_id TEXT,
  mention_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, channel_id)
);
CREATE TABLE relationships (
  user_id TEXT NOT NULL REFERENCES users(id),
  other_id TEXT NOT NULL REFERENCES users(id),
  type INTEGER NOT NULL, -- from user_id's view: 1 friend, 3 incoming, 4 outgoing
  PRIMARY KEY (user_id, other_id)
);
PRAGMA user_version = 2;
