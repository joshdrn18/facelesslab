-- Add account-wide FacelessLab daily safety counters.
-- Applied to production D1 on 2026-11-20.
ALTER TABLE ai_usage_daily_counters ADD COLUMN faceless_requests INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_usage_daily_counters ADD COLUMN tts_characters INTEGER NOT NULL DEFAULT 0;
