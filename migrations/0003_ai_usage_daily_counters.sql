CREATE TABLE IF NOT EXISTS ai_usage_daily_counters (
  utc_date TEXT PRIMARY KEY,
  analytics_requests INTEGER NOT NULL DEFAULT 0,
  pending_requests INTEGER NOT NULL DEFAULT 0,
  analytics_neurons REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_daily_counters_updated
  ON ai_usage_daily_counters (updated_at DESC);
