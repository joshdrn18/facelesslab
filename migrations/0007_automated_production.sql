CREATE TABLE IF NOT EXISTS production_schedules (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connection_id TEXT REFERENCES social_connections(id) ON DELETE SET NULL,
  topic TEXT NOT NULL,
  style TEXT NOT NULL DEFAULT 'storytelling',
  duration_seconds INTEGER NOT NULL DEFAULT 45 CHECK (duration_seconds IN (30,45,60)),
  platform TEXT NOT NULL DEFAULT 'youtube' CHECK (platform IN ('youtube','tiktok')),
  privacy TEXT NOT NULL DEFAULT 'private' CHECK (privacy IN ('private','unlisted','public')),
  production_at INTEGER NOT NULL,
  publish_at INTEGER NOT NULL,
  review_required INTEGER NOT NULL DEFAULT 1 CHECK (review_required IN (0,1)),
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','starting','script_queued','producing','rendering','awaiting_review','publish_queued','published','failed','cancelled')),
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  publish_job_id TEXT REFERENCES publish_jobs(id) ON DELETE SET NULL,
  backup_id TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_production_schedules_due
  ON production_schedules(status, production_at);
CREATE INDEX IF NOT EXISTS idx_production_schedules_user
  ON production_schedules(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_production_schedules_publish
  ON production_schedules(status, publish_at);