CREATE TABLE IF NOT EXISTS social_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('youtube','tiktok')),
  platform_user_id TEXT NOT NULL,
  display_name TEXT,
  access_token_enc TEXT NOT NULL,
  refresh_token_enc TEXT,
  access_token_expires_at INTEGER,
  refresh_token_expires_at INTEGER,
  scopes TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','revoked','error')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(user_id, platform, platform_user_id)
);
CREATE INDEX IF NOT EXISTS idx_social_connections_user ON social_connections(user_id, platform);
CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('youtube','tiktok')),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_oauth_states_expiry ON oauth_states(expires_at);
CREATE TABLE IF NOT EXISTS publish_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  backup_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('youtube','tiktok')),
  connection_id TEXT REFERENCES social_connections(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT,
  hashtags TEXT,
  privacy TEXT NOT NULL DEFAULT 'private',
  scheduled_at INTEGER,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','queued','uploading','processing','published','failed','cancelled')),
  provider_post_id TEXT,
  provider_url TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_publish_jobs_user ON publish_jobs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_publish_jobs_due ON publish_jobs(status, scheduled_at);
