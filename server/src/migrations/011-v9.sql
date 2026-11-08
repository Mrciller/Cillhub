-- v9 features: ephemeral message TTL, voice quality mode, channel canvas, onboarding, analytics (CONTRACT-v9).
ALTER TABLE channels ADD COLUMN message_ttl INTEGER DEFAULT 0;
ALTER TABLE channels ADD COLUMN quality_mode TEXT NOT NULL DEFAULT 'speech';

CREATE TABLE IF NOT EXISTS channel_canvas (
  channel_id TEXT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  content TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  updated_by TEXT REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS guild_onboarding (
  guild_id TEXT PRIMARY KEY REFERENCES guilds(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0,
  prompts TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS guild_analytics_daily (
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  messages_sent INTEGER NOT NULL DEFAULT 0,
  voice_minutes INTEGER NOT NULL DEFAULT 0,
  joins INTEGER NOT NULL DEFAULT 0,
  leaves INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, date)
);
