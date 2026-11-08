-- v7: self-hosting, the hub network and the server directory

-- node side: accounts that sign in with the hub (home = 'hub'); never a hub password, only the hub's user id
ALTER TABLE users ADD COLUMN home TEXT; -- NULL = local account, 'hub' = linked hub account
ALTER TABLE users ADD COLUMN hub_user_id TEXT;
ALTER TABLE users ADD COLUMN hub_avatar TEXT; -- the hub avatar URL last copied, so unchanged avatars are not fetched again
CREATE UNIQUE INDEX users_hub_user ON users(hub_user_id) WHERE hub_user_id IS NOT NULL;

-- hub side: one-time link codes (only a hash is stored; valid 24 h)
CREATE TABLE fed_link_codes (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  node_id TEXT,
  note TEXT
);

-- hub side: linked nodes (status active | suspended | banned | unlinked)
CREATE TABLE fed_nodes (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  version TEXT,
  mode TEXT NOT NULL DEFAULT 'connected',
  sign_in TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  status_reason TEXT,
  linked_at INTEGER NOT NULL,
  last_seen INTEGER,
  public_servers_count INTEGER NOT NULL DEFAULT 0,
  member_count INTEGER NOT NULL DEFAULT 0,
  created_by TEXT -- who made the link code
);

-- hub side: which hub users have an account on which node (USER_UPDATE pushes, NOTIFY)
CREATE TABLE fed_node_accounts (
  node_id TEXT NOT NULL REFERENCES fed_nodes(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_login INTEGER NOT NULL,
  PRIMARY KEY (node_id, user_id)
);

-- server directory. On the hub: node_id '' = a hub server, else the node's server (synced by its heartbeat).
-- On a node: its own listings (node_id ''), sent to the hub.
CREATE TABLE directory_entries (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL DEFAULT '',
  guild_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon_url TEXT, -- node servers: absolute URL on the node, shown through the media proxy
  banner_url TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  category TEXT NOT NULL,
  language TEXT,
  member_count INTEGER NOT NULL DEFAULT 0,
  invite_code TEXT NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0,
  hidden_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (node_id, guild_id)
);
CREATE INDEX directory_category ON directory_entries(category, member_count);

CREATE TABLE directory_reports (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES directory_entries(id) ON DELETE CASCADE,
  reporter_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'open', -- open | resolved
  action TEXT,
  resolved_by TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  UNIQUE (entry_id, reporter_id)
);
