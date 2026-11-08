-- the built-in Cillcord Bot is an ordinary application row marked builtin (its token is never issued)
ALTER TABLE applications ADD COLUMN builtin INTEGER NOT NULL DEFAULT 0;

-- "Send later": sent by a timer at send_at with the author's permissions checked again then
CREATE TABLE scheduled_messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  body TEXT NOT NULL, -- JSON {content, flags?, message_reference?, allowed_mentions?}
  send_at INTEGER NOT NULL, -- unix ms
  created_at INTEGER NOT NULL
);
CREATE INDEX scheduled_messages_due ON scheduled_messages(send_at);
CREATE INDEX scheduled_messages_user ON scheduled_messages(user_id);

-- saved messages (user docs): bookmarks, and reminders when due_at is set; notified once the reminder fired
CREATE TABLE saved_messages (
  user_id TEXT NOT NULL REFERENCES users(id),
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  saved_at TEXT NOT NULL,
  due_at INTEGER, -- unix ms
  notified INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, message_id)
);
CREATE INDEX saved_messages_due ON saved_messages(due_at) WHERE due_at IS NOT NULL AND notified = 0;

-- /remind of the Cillcord Bot: delivered as a DM from the bot
CREATE TABLE bot_reminders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  channel_id TEXT, -- where /remind was run, for the link
  guild_id TEXT,
  content TEXT NOT NULL,
  remind_at INTEGER NOT NULL -- unix ms
);
CREATE INDEX bot_reminders_due ON bot_reminders(remind_at);

-- giveaway, scrim and lfg cards of the Cillcord Bot; due_at is the next timed step (giveaway end, scrim ping)
CREATE TABLE bot_cards (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, -- giveaway, scrim, lfg
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  data TEXT NOT NULL, -- JSON, per kind
  due_at INTEGER -- unix ms, NULL = nothing timed left
);
CREATE INDEX bot_cards_due ON bot_cards(due_at) WHERE due_at IS NOT NULL;
CREATE TABLE bot_card_members (
  message_id TEXT NOT NULL REFERENCES bot_cards(message_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  slot TEXT NOT NULL DEFAULT '', -- scrim: main or bench
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id)
);

-- server templates (guild-template.mdx); one per guild
CREATE TABLE guild_templates (
  code TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL UNIQUE REFERENCES guilds(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  creator_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  usage_count INTEGER NOT NULL DEFAULT 0,
  snapshot TEXT NOT NULL -- JSON serialized_source_guild
);
