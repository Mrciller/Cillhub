-- channels: v3 fields for all types; threads (10, 11, 12) are rows here too, parent_id = their parent channel
ALTER TABLE channels ADD COLUMN nsfw INTEGER NOT NULL DEFAULT 0;
ALTER TABLE channels ADD COLUMN rate_limit_per_user INTEGER NOT NULL DEFAULT 0;
ALTER TABLE channels ADD COLUMN flags INTEGER NOT NULL DEFAULT 0;
ALTER TABLE channels ADD COLUMN owner_id TEXT;
ALTER TABLE channels ADD COLUMN default_auto_archive_duration INTEGER;
ALTER TABLE channels ADD COLUMN default_thread_rate_limit_per_user INTEGER NOT NULL DEFAULT 0;
ALTER TABLE channels ADD COLUMN default_reaction_emoji TEXT; -- JSON {emoji_id, emoji_name}
ALTER TABLE channels ADD COLUMN default_sort_order INTEGER;
ALTER TABLE channels ADD COLUMN default_forum_layout INTEGER NOT NULL DEFAULT 0;
ALTER TABLE channels ADD COLUMN available_tags TEXT NOT NULL DEFAULT '[]';
ALTER TABLE channels ADD COLUMN applied_tags TEXT NOT NULL DEFAULT '[]';
ALTER TABLE channels ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
ALTER TABLE channels ADD COLUMN locked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE channels ADD COLUMN invitable INTEGER NOT NULL DEFAULT 1;
ALTER TABLE channels ADD COLUMN auto_archive_duration INTEGER;
ALTER TABLE channels ADD COLUMN archive_timestamp TEXT;
ALTER TABLE channels ADD COLUMN create_timestamp TEXT;
ALTER TABLE channels ADD COLUMN last_activity INTEGER; -- unix ms of the last thread activity, drives auto-archive
ALTER TABLE channels ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE channels ADD COLUMN total_message_sent INTEGER NOT NULL DEFAULT 0;
CREATE INDEX channels_parent ON channels(parent_id);

CREATE TABLE thread_members (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  join_timestamp TEXT NOT NULL,
  flags INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX thread_members_user ON thread_members(user_id);

ALTER TABLE guilds ADD COLUMN afk_channel_id TEXT;
ALTER TABLE guilds ADD COLUMN afk_timeout INTEGER NOT NULL DEFAULT 300;
ALTER TABLE guilds ADD COLUMN verification_level INTEGER NOT NULL DEFAULT 0;
ALTER TABLE guilds ADD COLUMN description TEXT;
ALTER TABLE guilds ADD COLUMN rules_channel_id TEXT;
ALTER TABLE guilds ADD COLUMN vanity_url_code TEXT;
ALTER TABLE guilds ADD COLUMN vanity_uses INTEGER NOT NULL DEFAULT 0;
ALTER TABLE guilds ADD COLUMN features TEXT NOT NULL DEFAULT '[]'; -- only the mutable ones; the rest are derived
ALTER TABLE guilds ADD COLUMN welcome_screen TEXT; -- JSON {enabled, description, welcome_channels}
ALTER TABLE guilds ADD COLUMN member_verification TEXT; -- JSON {enabled, version, description, form_fields}
CREATE UNIQUE INDEX guilds_vanity ON guilds(vanity_url_code);

ALTER TABLE members ADD COLUMN communication_disabled_until TEXT;
ALTER TABLE members ADD COLUMN pending INTEGER NOT NULL DEFAULT 0;

ALTER TABLE messages ADD COLUMN flags INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN embeds TEXT NOT NULL DEFAULT '[]'; -- rich and system embeds
ALTER TABLE messages ADD COLUMN link_embeds TEXT NOT NULL DEFAULT '[]'; -- from unfurling, replaced on edit
ALTER TABLE messages ADD COLUMN reference TEXT; -- JSON message_reference for everything but plain replies (reference_id)
ALTER TABLE messages ADD COLUMN snapshot TEXT; -- JSON message snapshot of a forward
ALTER TABLE messages ADD COLUMN sticker_items TEXT NOT NULL DEFAULT '[]';
ALTER TABLE messages ADD COLUMN webhook_id TEXT; -- author_id then holds the webhook's creator, to keep the users FK
ALTER TABLE messages ADD COLUMN webhook_author TEXT; -- JSON {username, avatar, avatar_url}
CREATE INDEX messages_author ON messages(author_id);

ALTER TABLE attachments ADD COLUMN description TEXT;
ALTER TABLE attachments ADD COLUMN flags INTEGER NOT NULL DEFAULT 0;
ALTER TABLE attachments ADD COLUMN duration_secs REAL;
ALTER TABLE attachments ADD COLUMN waveform TEXT;
ALTER TABLE attachments ADD COLUMN in_snapshot INTEGER NOT NULL DEFAULT 0; -- copy belonging to a forward's snapshot

-- external-content FTS index over messages.content; rowid is stable because nothing VACUUMs this table
CREATE VIRTUAL TABLE messages_fts USING fts5(content, content='messages', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;
CREATE TRIGGER messages_fts_au AFTER UPDATE OF content ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
INSERT INTO messages_fts(messages_fts) VALUES ('rebuild');

CREATE TABLE polls (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  question TEXT NOT NULL, -- JSON poll media
  answers TEXT NOT NULL, -- JSON [{answer_id, poll_media}]
  allow_multiselect INTEGER NOT NULL,
  layout_type INTEGER NOT NULL DEFAULT 1,
  expiry INTEGER NOT NULL, -- unix ms
  finalized INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE poll_votes (
  message_id TEXT NOT NULL REFERENCES polls(message_id) ON DELETE CASCADE,
  answer_id INTEGER NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  PRIMARY KEY (message_id, answer_id, user_id)
);

CREATE TABLE emojis (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  animated INTEGER NOT NULL,
  roles TEXT NOT NULL DEFAULT '[]',
  user_id TEXT REFERENCES users(id)
);
CREATE INDEX emojis_guild ON emojis(guild_id);

CREATE TABLE stickers (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  tags TEXT NOT NULL,
  format_type INTEGER NOT NULL,
  user_id TEXT REFERENCES users(id)
);
CREATE INDEX stickers_guild ON stickers(guild_id);

CREATE TABLE soundboard_sounds (
  sound_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  volume REAL NOT NULL DEFAULT 1,
  emoji_id TEXT,
  emoji_name TEXT,
  user_id TEXT REFERENCES users(id)
);
CREATE INDEX soundboard_guild ON soundboard_sounds(guild_id);

CREATE TABLE scheduled_events (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  channel_id TEXT,
  creator_id TEXT REFERENCES users(id),
  name TEXT NOT NULL,
  description TEXT,
  scheduled_start_time TEXT NOT NULL,
  scheduled_end_time TEXT,
  privacy_level INTEGER NOT NULL DEFAULT 2,
  status INTEGER NOT NULL DEFAULT 1,
  entity_type INTEGER NOT NULL,
  entity_metadata TEXT, -- JSON
  image TEXT
);
CREATE INDEX scheduled_events_guild ON scheduled_events(guild_id);
CREATE TABLE scheduled_event_users (
  event_id TEXT NOT NULL REFERENCES scheduled_events(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  PRIMARY KEY (event_id, user_id)
);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id TEXT,
  target_id TEXT,
  action_type INTEGER NOT NULL,
  changes TEXT, -- JSON
  options TEXT, -- JSON
  reason TEXT
);
CREATE INDEX audit_log_guild ON audit_log(guild_id);

CREATE TABLE automod_rules (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  creator_id TEXT NOT NULL,
  event_type INTEGER NOT NULL,
  trigger_type INTEGER NOT NULL,
  trigger_metadata TEXT NOT NULL,
  actions TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  exempt_roles TEXT NOT NULL DEFAULT '[]',
  exempt_channels TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX automod_rules_guild ON automod_rules(guild_id);

CREATE TABLE webhooks (
  id TEXT PRIMARY KEY,
  type INTEGER NOT NULL, -- 1 incoming, 2 channel follower
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  avatar TEXT,
  token TEXT, -- incoming only
  source_guild_id TEXT,
  source_channel_id TEXT REFERENCES channels(id) ON DELETE CASCADE
);
CREATE INDEX webhooks_channel ON webhooks(channel_id);
CREATE INDEX webhooks_source ON webhooks(source_channel_id);

-- v3 default @everyone bits: EMBED_LINKS, USE_EXTERNAL_EMOJIS, USE_APPLICATION_COMMANDS, REQUEST_TO_SPEAK,
-- CREATE_PUBLIC/PRIVATE_THREADS, USE_EXTERNAL_STICKERS, SEND_MESSAGES_IN_THREADS, USE_SOUNDBOARD,
-- USE_EXTERNAL_SOUNDS, SEND_VOICE_MESSAGES, SEND_POLLS
UPDATE roles SET permissions = CAST(CAST(permissions AS INTEGER) | 673422955003904 AS TEXT) WHERE id = guild_id;
