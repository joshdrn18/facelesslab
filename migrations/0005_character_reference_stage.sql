-- Allow the dedicated character portrait workflow to use the generations ledger.
-- Rebuild the table because SQLite cannot alter an existing CHECK constraint.
CREATE TABLE generations_new (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stage TEXT NOT NULL DEFAULT 'script'
    CHECK (stage IN ('script', 'voice', 'visuals', 'subtitles', 'render', 'character_reference')),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
  input_json TEXT,
  output_json TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT INTO generations_new
  (id, project_id, user_id, stage, status, input_json, output_json, error_message, created_at, updated_at)
SELECT
  id, project_id, user_id, stage, status, input_json, output_json, error_message, created_at, updated_at
FROM generations;

DROP TABLE generations;
ALTER TABLE generations_new RENAME TO generations;

CREATE INDEX IF NOT EXISTS idx_generations_project
  ON generations(project_id, created_at);
