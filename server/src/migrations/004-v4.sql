-- users: bots, profiles, settings document, TOTP, deletion
ALTER TABLE users ADD COLUMN bot INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN bio TEXT;
ALTER TABLE users ADD COLUMN banner TEXT;
ALTER TABLE users ADD COLUMN accent_color INTEGER;
ALTER TABLE users ADD COLUMN pronouns TEXT;
ALTER TABLE users ADD COLUMN settings TEXT NOT NULL DEFAULT '{}'; -- allow-listed user settings document (JSON)
ALTER TABLE users ADD COLUMN mfa_secret TEXT; -- AES-256-GCM sealed TOTP secret; NULL = MFA off
ALTER TABLE users ADD COLUMN mfa_last_step INTEGER NOT NULL DEFAULT 0; -- last accepted TOTP time step (replay guard)
ALTER TABLE users ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;

-- tokens double as auth sessions
ALTER TABLE tokens ADD COLUMN created_at INTEGER;
ALTER TABLE tokens ADD COLUMN last_used INTEGER;
ALTER TABLE tokens ADD COLUMN os TEXT;
ALTER TABLE tokens ADD COLUMN platform TEXT;
CREATE INDEX tokens_user ON tokens(user_id);

-- per-guild profile
ALTER TABLE members ADD COLUMN avatar TEXT;
ALTER TABLE members ADD COLUMN banner TEXT;
ALTER TABLE members ADD COLUMN bio TEXT;

ALTER TABLE channels ADD COLUMN icon TEXT; -- group DM icon (owner_id holds the group owner)

ALTER TABLE roles ADD COLUMN managed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE roles ADD COLUMN bot_id TEXT; -- managed bot role: tags.bot_id

ALTER TABLE messages ADD COLUMN components TEXT NOT NULL DEFAULT '[]';
ALTER TABLE messages ADD COLUMN application_id TEXT;
ALTER TABLE messages ADD COLUMN interaction_metadata TEXT; -- JSON {id, type, name, user_id}
ALTER TABLE messages ADD COLUMN call TEXT; -- JSON {participants, ended_timestamp} of a type 3 call message

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
CREATE INDEX recent_mentions_created ON recent_mentions(created_at);

CREATE TABLE push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX push_subscriptions_user ON push_subscriptions(user_id);

CREATE TABLE mfa_backup_codes (
  user_id TEXT NOT NULL REFERENCES users(id),
  code_hash TEXT NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, code_hash)
);

-- id = the bot user's id, per v9 API specification
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
CREATE INDEX applications_owner ON applications(owner_id);

CREATE TABLE application_commands (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  guild_id TEXT REFERENCES guilds(id) ON DELETE CASCADE, -- NULL = global
  type INTEGER NOT NULL,
  name TEXT NOT NULL,
  data TEXT NOT NULL, -- JSON of the validated command fields
  version TEXT NOT NULL
);
CREATE UNIQUE INDEX application_commands_name ON application_commands(application_id, IFNULL(guild_id, ''), type, name);
