-- review M-1: new attachment URLs carry a signature; uploads from before keep answering at their old unsigned URL
ALTER TABLE attachments ADD COLUMN legacy_url INTEGER NOT NULL DEFAULT 0;
UPDATE attachments SET legacy_url = 1;
