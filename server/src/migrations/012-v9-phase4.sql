-- v9 Phase 4: WebAuthn / Passkeys, E2EE DMs (CONTRACT-v9 §9, §11)
CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT DEFAULT '[]',
  nickname TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS webauthn_credentials_user ON webauthn_credentials(user_id);

CREATE TABLE IF NOT EXISTS user_e2ee_keys (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE messages ADD COLUMN e2ee_envelope TEXT;
