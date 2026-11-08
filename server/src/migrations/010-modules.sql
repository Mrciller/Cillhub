-- v8 modules: instance-wide sandboxed modules with their own bot user and application (CONTRACT-v8).
-- The manifest (name, version, permissions, http_hosts, commands, settings, panels) is stored as approved; the package
-- files live under DATA_DIR/modules/<id>/. Settings, storage and logs are keyed by the module id, not by a foreign key,
-- so a removal with keep_data leaves settings and storage for a later install of the same id.
ALTER TABLE users ADD COLUMN module INTEGER NOT NULL DEFAULT 0;

CREATE TABLE modules (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL UNIQUE,
  manifest TEXT NOT NULL,
  source TEXT NOT NULL, -- {type, filename, git_url, git_ref, commit}
  enabled INTEGER NOT NULL DEFAULT 0,
  crashed INTEGER NOT NULL DEFAULT 0,
  status_reason TEXT,
  scope TEXT NOT NULL DEFAULT 'all',
  guild_ids TEXT NOT NULL DEFAULT '[]',
  per_server_settings INTEGER NOT NULL DEFAULT 0,
  installed_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- guild_id '' = the global value
CREATE TABLE module_settings (
  module_id TEXT NOT NULL,
  guild_id TEXT NOT NULL DEFAULT '',
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (module_id, guild_id, key)
);

CREATE TABLE module_storage (
  module_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  size INTEGER NOT NULL,
  PRIMARY KEY (module_id, key)
);

CREATE TABLE module_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  module_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL
);
CREATE INDEX module_logs_module ON module_logs(module_id, id);

CREATE TABLE module_schedules (
  module_id TEXT NOT NULL,
  name TEXT NOT NULL,
  next_at INTEGER NOT NULL,
  interval_ms INTEGER,
  PRIMARY KEY (module_id, name)
);

CREATE TABLE module_message_panels (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  module_id TEXT NOT NULL,
  panel_id TEXT NOT NULL
);
