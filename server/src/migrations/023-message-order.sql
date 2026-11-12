-- message history pages and "newest message" lookups range and sort by the numeric id within one channel;
-- deleting a message looks up its mentions
CREATE INDEX IF NOT EXISTS messages_channel_order ON messages(channel_id, CAST(id AS INTEGER));
CREATE INDEX IF NOT EXISTS recent_mentions_message ON recent_mentions(message_id);
