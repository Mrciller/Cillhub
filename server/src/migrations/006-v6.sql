-- v6: instance administration and customization

-- instance admins are granted only by src/admin-cli.js; disabled accounts cannot log in; system = the "Cillcord System" account
ALTER TABLE users ADD COLUMN instance_admin INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN require_password_change INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN system INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN last_seen INTEGER; -- unix ms, written with the token's last use (at most once a minute)
-- JSON: display_name_styles, avatar_decoration_data, collectibles, theme_colors, profile_effect, widgets, primary_guild_id
ALTER TABLE users ADD COLUMN customization TEXT NOT NULL DEFAULT '{}';
ALTER TABLE members ADD COLUMN display_name_styles TEXT; -- JSON, per-server override

ALTER TABLE roles ADD COLUMN secondary_color INTEGER;
ALTER TABLE roles ADD COLUMN tertiary_color INTEGER;
ALTER TABLE roles ADD COLUMN icon TEXT;
ALTER TABLE roles ADD COLUMN unicode_emoji TEXT;

ALTER TABLE guilds ADD COLUMN banner TEXT;
ALTER TABLE guilds ADD COLUMN splash TEXT;
-- JSON: brand_color_primary, tag, badge, badge_color_primary, badge_color_secondary, badge_hash
ALTER TABLE guilds ADD COLUMN profile TEXT NOT NULL DEFAULT '{}';
ALTER TABLE guilds ADD COLUMN entrance_sounds INTEGER NOT NULL DEFAULT 1;
ALTER TABLE guilds ADD COLUMN greeting_templates TEXT NOT NULL DEFAULT '[]';
ALTER TABLE guilds ADD COLUMN invites_disabled INTEGER NOT NULL DEFAULT 0; -- set by an instance admin only

ALTER TABLE channels ADD COLUMN icon_emoji TEXT; -- JSON {id, name}
ALTER TABLE channels ADD COLUMN theme_color INTEGER;

-- avatar decorations a server uploads (MANAGE_GUILD_EXPRESSIONS); members can wear them anywhere
CREATE TABLE guild_decorations (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  asset TEXT NOT NULL UNIQUE, -- file hash, served at /avatar-decoration-presets/<asset>.png
  user_id TEXT
);
CREATE INDEX guild_decorations_guild ON guild_decorations(guild_id);

-- short sounds a user uploads (notification sounds, entrance sound)
CREATE TABLE user_sounds (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  volume REAL NOT NULL DEFAULT 1
);
CREATE INDEX user_sounds_user ON user_sounds(user_id);

-- instance settings (key -> JSON value)
CREATE TABLE instance_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE registration_codes (
  code TEXT PRIMARY KEY,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER, -- unix ms, NULL = never
  max_uses INTEGER NOT NULL DEFAULT 1, -- 0 = unlimited
  uses INTEGER NOT NULL DEFAULT 0,
  note TEXT
);

-- message reports; the message is copied at report time so the report survives an edit or deletion
CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  reporter_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  guild_id TEXT,
  author_id TEXT,
  reason TEXT NOT NULL,
  note TEXT,
  snapshot TEXT NOT NULL, -- JSON {content, attachments, embeds, timestamp}
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', -- open | resolved
  actions TEXT NOT NULL DEFAULT '[]', -- JSON [{action, admin_id, at, note}]
  UNIQUE (reporter_id, message_id)
);
CREATE INDEX reports_status ON reports(status, created_at);

-- the admin audit log is append-only: the triggers refuse every UPDATE and DELETE
CREATE TABLE admin_audit_log (
  id TEXT PRIMARY KEY,
  admin_id TEXT, -- NULL for the CLI
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  details TEXT, -- JSON
  ip_hash TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX admin_audit_created ON admin_audit_log(created_at);
CREATE TRIGGER admin_audit_no_update BEFORE UPDATE ON admin_audit_log BEGIN SELECT RAISE(ABORT, 'admin audit log is append-only'); END;
CREATE TRIGGER admin_audit_no_delete BEFORE DELETE ON admin_audit_log BEGIN SELECT RAISE(ABORT, 'admin audit log is append-only'); END;

-- voice minutes per UTC day, for the admin overview
CREATE TABLE voice_usage (
  day TEXT PRIMARY KEY, -- YYYY-MM-DD
  seconds INTEGER NOT NULL DEFAULT 0
);
