-- v11: Message edits history, forum solved status, polls quiz & anonymous, guild snippets, thread member flags

CREATE TABLE IF NOT EXISTS message_edits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  previous_content TEXT NOT NULL,
  edited_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS message_edits_msg ON message_edits(message_id);

ALTER TABLE channels ADD COLUMN solved_message_id TEXT DEFAULT NULL;

ALTER TABLE polls ADD COLUMN anonymous INTEGER NOT NULL DEFAULT 0;
ALTER TABLE polls ADD COLUMN allowed_roles TEXT NOT NULL DEFAULT '[]';
ALTER TABLE polls ADD COLUMN correct_answer_id INTEGER DEFAULT NULL;

CREATE TABLE IF NOT EXISTS guild_snippets (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE(guild_id, name)
);
CREATE INDEX IF NOT EXISTS guild_snippets_guild ON guild_snippets(guild_id);

-- thread_members.flags already exists from 003-v3.sql (DEFAULT 0)
