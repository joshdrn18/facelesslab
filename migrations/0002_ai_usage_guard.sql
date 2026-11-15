CREATE TABLE IF NOT EXISTS ai_usage_settings (
  id TEXT PRIMARY KEY CHECK (id = 'global'),
  daily_request_limit INTEGER NOT NULL DEFAULT 40,
  warning_percent INTEGER NOT NULL DEFAULT 80,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT OR IGNORE INTO ai_usage_settings (id, daily_request_limit, warning_percent)
VALUES ('global', 40, 80);

CREATE TABLE IF NOT EXISTS ai_inference_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  generation_id TEXT REFERENCES generations(id) ON DELETE SET NULL,
  stage TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'completed', 'failed')),
  duration_ms INTEGER,
  input_characters INTEGER,
  input_bytes INTEGER,
  output_bytes INTEGER,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  neurons REAL,
  error_message TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_ai_inference_events_created
  ON ai_inference_events (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_inference_events_user_created
  ON ai_inference_events (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_inference_events_generation
  ON ai_inference_events (generation_id, created_at);

CREATE INDEX IF NOT EXISTS idx_ai_inference_events_model_created
  ON ai_inference_events (model, created_at DESC);
