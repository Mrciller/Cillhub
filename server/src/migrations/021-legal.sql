-- 7.10.3 legal: imprint, privacy notice and terms with versions; terms acceptance on the account; public notices of
-- illegal content (DSA Art. 16), removals kept for 6 months (TCO Art. 6), statements of reasons and appeals (DSA Art. 17, 20)

-- every save of a document is a new row; the current one is the newest row per doc
CREATE TABLE legal_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc TEXT NOT NULL, -- imprint | privacy | terms
  en TEXT NOT NULL DEFAULT '',
  de TEXT NOT NULL DEFAULT '',
  hash TEXT NOT NULL, -- sha256 of both texts
  reaccept INTEGER NOT NULL DEFAULT 0, -- existing users must accept this version on their next visit
  created_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX legal_documents_doc ON legal_documents(doc, id);

ALTER TABLE users ADD COLUMN terms_version INTEGER; -- legal_documents.id of the terms (or privacy notice) accepted
ALTER TABLE users ADD COLUMN terms_accepted_at INTEGER;
ALTER TABLE users ADD COLUMN legal_pending INTEGER NOT NULL DEFAULT 0; -- made without the sign-up checks (hub sign-in on a node)

-- reports, rebuilt so a notice can come from outside (no reporter account, maybe no message): source user | public | removal
CREATE TABLE reports_new (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'user',
  reporter_id TEXT,
  message_id TEXT,
  channel_id TEXT,
  guild_id TEXT,
  author_id TEXT,
  reason TEXT NOT NULL, -- user: a report reason; public: a notice category; removal: the decision category
  note TEXT,
  snapshot TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', -- open | resolved
  actions TEXT NOT NULL DEFAULT '[]',
  target_url TEXT, -- public notices: what the notice is about
  reporter_name TEXT,
  reporter_email TEXT,
  code_hash TEXT UNIQUE, -- public notices: sha256 of the reference code the notifier got
  decision TEXT, -- public notices: the answer to the notifier
  resolved_at INTEGER,
  preserve_until INTEGER, -- removals: the preserved copy is deleted after this
  UNIQUE (reporter_id, message_id)
);
INSERT INTO reports_new (id, reporter_id, message_id, channel_id, guild_id, author_id, reason, note, snapshot, created_at, status, actions)
  SELECT id, reporter_id, message_id, channel_id, guild_id, author_id, reason, note, snapshot, created_at, status, actions FROM reports;
DROP TABLE reports;
ALTER TABLE reports_new RENAME TO reports;
CREATE INDEX reports_status ON reports(status, created_at);
CREATE INDEX reports_preserve ON reports(preserve_until) WHERE preserve_until IS NOT NULL;

-- statements of reasons for instance-admin actions, with at most one appeal each
CREATE TABLE moderation_decisions (
  id TEXT PRIMARY KEY,
  user_id TEXT, -- the account affected (NULL: not known here, e.g. a node's server)
  admin_id TEXT,
  action TEXT NOT NULL,
  category TEXT NOT NULL,
  ground TEXT NOT NULL, -- terms | illegal
  reason TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '{}', -- JSON {guild_id, channel_id, message_id, name}
  report_id TEXT,
  created_at INTEGER NOT NULL,
  appeal_code_hash TEXT UNIQUE,
  appeal TEXT,
  appeal_at INTEGER,
  appeal_status TEXT, -- NULL | open | upheld | reversed
  appeal_decision TEXT,
  appeal_decided_at INTEGER,
  appeal_admin_id TEXT
);
CREATE INDEX moderation_decisions_user ON moderation_decisions(user_id, created_at);
CREATE INDEX moderation_decisions_appeal ON moderation_decisions(appeal_status, appeal_at);
