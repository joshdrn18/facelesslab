ALTER TABLE ai_usage_daily_counters
  ADD COLUMN member_requests INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_ai_usage_daily_member_requests
  ON ai_usage_daily_counters (utc_date, member_requests);
