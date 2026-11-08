-- per-server voice server (owner's request, 2026-11-04): NULL = the instance default; 'livekit' or 'cillvoice' otherwise.
-- Only new calls use it; a call that is running keeps its backend until everyone has left.
ALTER TABLE guilds ADD COLUMN voice_backend TEXT;
