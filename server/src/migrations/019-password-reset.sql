-- password reset by email: only the SHA-256 of the token from the mail is stored; one link per user, 30 minutes
CREATE TABLE password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX password_resets_user ON password_resets(user_id);
