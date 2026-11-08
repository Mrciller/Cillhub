ALTER TABLE users ADD COLUMN avatar TEXT;
ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'online';
ALTER TABLE guilds ADD COLUMN icon TEXT;
ALTER TABLE guilds ADD COLUMN system_channel_id TEXT;
ALTER TABLE members ADD COLUMN nick TEXT;
ALTER TABLE members ADD COLUMN mute INTEGER NOT NULL DEFAULT 0;
ALTER TABLE members ADD COLUMN deaf INTEGER NOT NULL DEFAULT 0;
ALTER TABLE channels ADD COLUMN parent_id TEXT;
ALTER TABLE channels ADD COLUMN user_limit INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN type INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN reference_id TEXT; -- no FK: a reply outlives the message it quotes
ALTER TABLE messages ADD COLUMN mention_everyone INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN mention_roles TEXT NOT NULL DEFAULT '[]';
ALTER TABLE messages ADD COLUMN pinned_at TEXT;
ALTER TABLE invites ADD COLUMN max_uses INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invites ADD COLUMN max_age INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invites ADD COLUMN created_at TEXT;

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

INSERT INTO roles (id, guild_id, name, position, permissions) SELECT id, id, '@everyone', 0, '70356545' FROM guilds;
UPDATE guilds SET system_channel_id =
  (SELECT id FROM channels c WHERE c.guild_id = guilds.id AND c.type = 0 ORDER BY c.position LIMIT 1);
UPDATE invites SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  max_age = CASE WHEN expires_at IS NULL THEN 0 ELSE MAX(0, (expires_at - CAST(unixepoch('subsec') * 1000 AS INTEGER)) / 1000) END;
