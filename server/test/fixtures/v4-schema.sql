-- Frozen copy of the v4 schema (user_version 4), for the v4 -> v5 migration test.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  global_name TEXT,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL
, avatar TEXT, status TEXT NOT NULL DEFAULT 'online', bot INTEGER NOT NULL DEFAULT 0, bio TEXT, banner TEXT, accent_color INTEGER, pronouns TEXT, settings TEXT NOT NULL DEFAULT '{}', mfa_secret TEXT, mfa_last_step INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0);
CREATE TABLE tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id)
, created_at INTEGER, last_used INTEGER, os TEXT, platform TEXT);
CREATE TABLE guilds (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id)
, icon TEXT, system_channel_id TEXT, afk_channel_id TEXT, afk_timeout INTEGER NOT NULL DEFAULT 300, verification_level INTEGER NOT NULL DEFAULT 0, description TEXT, rules_channel_id TEXT, vanity_url_code TEXT, vanity_uses INTEGER NOT NULL DEFAULT 0, features TEXT NOT NULL DEFAULT '[]', welcome_screen TEXT, member_verification TEXT);
CREATE TABLE members (
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  joined_at TEXT NOT NULL, nick TEXT, mute INTEGER NOT NULL DEFAULT 0, deaf INTEGER NOT NULL DEFAULT 0, communication_disabled_until TEXT, pending INTEGER NOT NULL DEFAULT 0, avatar TEXT, banner TEXT, bio TEXT,
  PRIMARY KEY (guild_id, user_id)
);
CREATE TABLE channels (
  id TEXT PRIMARY KEY,
  type INTEGER NOT NULL,
  guild_id TEXT REFERENCES guilds(id) ON DELETE CASCADE,
  name TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  topic TEXT,
  last_message_id TEXT
, parent_id TEXT, user_limit INTEGER NOT NULL DEFAULT 0, nsfw INTEGER NOT NULL DEFAULT 0, rate_limit_per_user INTEGER NOT NULL DEFAULT 0, flags INTEGER NOT NULL DEFAULT 0, owner_id TEXT, default_auto_archive_duration INTEGER, default_thread_rate_limit_per_user INTEGER NOT NULL DEFAULT 0, default_reaction_emoji TEXT, default_sort_order INTEGER, default_forum_layout INTEGER NOT NULL DEFAULT 0, available_tags TEXT NOT NULL DEFAULT '[]', applied_tags TEXT NOT NULL DEFAULT '[]', archived INTEGER NOT NULL DEFAULT 0, locked INTEGER NOT NULL DEFAULT 0, invitable INTEGER NOT NULL DEFAULT 1, auto_archive_duration INTEGER, archive_timestamp TEXT, create_timestamp TEXT, last_activity INTEGER, message_count INTEGER NOT NULL DEFAULT 0, total_message_sent INTEGER NOT NULL DEFAULT 0, icon TEXT);
CREATE TABLE dm_recipients (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  PRIMARY KEY (channel_id, user_id)
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id),
  content TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  edited_timestamp TEXT
, type INTEGER NOT NULL DEFAULT 0, reference_id TEXT, mention_everyone INTEGER NOT NULL DEFAULT 0, mention_roles TEXT NOT NULL DEFAULT '[]', pinned_at TEXT, flags INTEGER NOT NULL DEFAULT 0, embeds TEXT NOT NULL DEFAULT '[]', link_embeds TEXT NOT NULL DEFAULT '[]', reference TEXT, snapshot TEXT, sticker_items TEXT NOT NULL DEFAULT '[]', webhook_id TEXT, webhook_author TEXT, components TEXT NOT NULL DEFAULT '[]', application_id TEXT, interaction_metadata TEXT, call TEXT);
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
, managed INTEGER NOT NULL DEFAULT 0, bot_id TEXT);
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
, description TEXT, flags INTEGER NOT NULL DEFAULT 0, duration_secs REAL, waveform TEXT, in_snapshot INTEGER NOT NULL DEFAULT 0);
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
CREATE TABLE thread_members (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  join_timestamp TEXT NOT NULL,
  flags INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (channel_id, user_id)
);
CREATE VIRTUAL TABLE messages_fts USING fts5(content, content='messages', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
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
CREATE TABLE stickers (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  tags TEXT NOT NULL,
  format_type INTEGER NOT NULL,
  user_id TEXT REFERENCES users(id)
);
CREATE TABLE soundboard_sounds (
  sound_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  volume REAL NOT NULL DEFAULT 1,
  emoji_id TEXT,
  emoji_name TEXT,
  user_id TEXT REFERENCES users(id)
);
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
CREATE TABLE notes (
  user_id TEXT NOT NULL REFERENCES users(id),
  target_id TEXT NOT NULL REFERENCES users(id),
  note TEXT NOT NULL,
  PRIMARY KEY (user_id, target_id)
);
CREATE TABLE user_guild_settings (
  user_id TEXT NOT NULL REFERENCES users(id),
  guild_id TEXT NOT NULL, -- '@me' for private channels
  settings TEXT NOT NULL, -- JSON user guild settings object
  PRIMARY KEY (user_id, guild_id)
);
CREATE TABLE recent_mentions (
  user_id TEXT NOT NULL REFERENCES users(id),
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  guild_id TEXT,
  kind TEXT NOT NULL, -- user, role, everyone
  created_at INTEGER NOT NULL, -- unix ms
  PRIMARY KEY (user_id, message_id)
);
CREATE TABLE push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE mfa_backup_codes (
  user_id TEXT NOT NULL REFERENCES users(id),
  code_hash TEXT NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, code_hash)
);
CREATE TABLE applications (
  id TEXT PRIMARY KEY REFERENCES users(id),
  owner_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon TEXT,
  flags INTEGER NOT NULL DEFAULT 0,
  bot_public INTEGER NOT NULL DEFAULT 1,
  interactions_endpoint_url TEXT,
  public_key TEXT NOT NULL, -- hex Ed25519 key the app verifies HTTP interactions with
  private_key TEXT NOT NULL -- PKCS#8 PEM, signs HTTP interactions for this app
);
CREATE TABLE application_commands (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  guild_id TEXT REFERENCES guilds(id) ON DELETE CASCADE, -- NULL = global
  type INTEGER NOT NULL,
  name TEXT NOT NULL,
  data TEXT NOT NULL, -- JSON of the validated command fields
  version TEXT NOT NULL
);
CREATE INDEX members_user ON members(user_id);
CREATE INDEX channels_guild ON channels(guild_id);
CREATE INDEX dm_recipients_user ON dm_recipients(user_id);
CREATE INDEX messages_channel ON messages(channel_id);
CREATE INDEX roles_guild ON roles(guild_id);
CREATE INDEX attachments_message ON attachments(message_id);
CREATE INDEX channels_parent ON channels(parent_id);
CREATE INDEX thread_members_user ON thread_members(user_id);
CREATE UNIQUE INDEX guilds_vanity ON guilds(vanity_url_code);
CREATE INDEX messages_author ON messages(author_id);
CREATE INDEX emojis_guild ON emojis(guild_id);
CREATE INDEX stickers_guild ON stickers(guild_id);
CREATE INDEX soundboard_guild ON soundboard_sounds(guild_id);
CREATE INDEX scheduled_events_guild ON scheduled_events(guild_id);
CREATE INDEX audit_log_guild ON audit_log(guild_id);
CREATE INDEX automod_rules_guild ON automod_rules(guild_id);
CREATE INDEX webhooks_channel ON webhooks(channel_id);
CREATE INDEX webhooks_source ON webhooks(source_channel_id);
CREATE INDEX tokens_user ON tokens(user_id);
CREATE INDEX recent_mentions_created ON recent_mentions(created_at);
CREATE INDEX push_subscriptions_user ON push_subscriptions(user_id);
CREATE INDEX applications_owner ON applications(owner_id);
CREATE UNIQUE INDEX application_commands_name ON application_commands(application_id, IFNULL(guild_id, ''), type, name);
PRAGMA user_version = 4;
