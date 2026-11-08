-- v12: Message requests inbox, community server onboarding channels, vanity URLs

CREATE TABLE IF NOT EXISTS dm_requests (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'accepted', 'declined'
  created_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, recipient_id)
);
CREATE INDEX IF NOT EXISTS dm_requests_recipient ON dm_requests(recipient_id);

ALTER TABLE guild_onboarding ADD COLUMN default_channel_ids TEXT NOT NULL DEFAULT '[]';

ALTER TABLE guilds ADD COLUMN vanity_code TEXT DEFAULT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS guilds_vanity_code ON guilds(vanity_code) WHERE vanity_code IS NOT NULL;
