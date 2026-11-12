-- encrypted DMs: one P-256 account key per user (raw public key, base64url) and its backup sealed with the recovery key;
-- the free-form key blobs of the unused v9 draft go, as do messages that used its retired type 100
DELETE FROM user_e2ee_keys;
ALTER TABLE user_e2ee_keys ADD COLUMN backup TEXT;
UPDATE messages SET e2ee_envelope = NULL, type = 0 WHERE type = 100 OR e2ee_envelope IS NOT NULL;
-- 0 = not encrypted; once above 0 it only ever goes up
ALTER TABLE channels ADD COLUMN e2ee_epoch INTEGER NOT NULL DEFAULT 0;
-- the channel key of each epoch, wrapped for each member
CREATE TABLE dm_keys (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  epoch INTEGER NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wrapped TEXT NOT NULL,
  PRIMARY KEY (channel_id, epoch, user_id)
);
CREATE INDEX dm_keys_user ON dm_keys(user_id);
