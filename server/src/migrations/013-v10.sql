-- v10: Soundboard packs, recurring messages, anti-raid, calendar tokens, whiteboard (CONTRACT-v10)
CREATE TABLE IF NOT EXISTS soundboard_packs (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  icon_emoji TEXT,
  sound_ids TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS soundboard_packs_guild ON soundboard_packs(guild_id);

CREATE TABLE IF NOT EXISTS recurring_messages (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id),
  content TEXT NOT NULL,
  interval_type TEXT NOT NULL DEFAULT 'daily',
  time_of_day TEXT NOT NULL DEFAULT '12:00',
  next_run INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS recurring_messages_channel ON recurring_messages(channel_id);

ALTER TABLE guilds ADD COLUMN anti_raid TEXT DEFAULT NULL;
ALTER TABLE users ADD COLUMN calendar_token TEXT DEFAULT NULL;

CREATE TABLE IF NOT EXISTS channel_whiteboard (
  channel_id TEXT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  strokes TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  updated_by TEXT REFERENCES users(id)
);
