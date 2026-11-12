-- automatic spam slow mode: a per-server switch (on by default) and, while a channel's automatic slow mode runs,
-- the slow mode it had before and when it comes back (unix ms)
ALTER TABLE guilds ADD COLUMN spam_slowmode INTEGER NOT NULL DEFAULT 1;
ALTER TABLE channels ADD COLUMN auto_slowmode_prev INTEGER;
ALTER TABLE channels ADD COLUMN auto_slowmode_until INTEGER;
CREATE INDEX channels_auto_slowmode ON channels(auto_slowmode_until) WHERE auto_slowmode_until IS NOT NULL;
