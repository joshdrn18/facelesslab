ALTER TABLE projects ADD COLUMN parent_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE projects ADD COLUMN episode_number INTEGER NOT NULL DEFAULT 1;
ALTER TABLE projects ADD COLUMN continuity_json TEXT;
CREATE INDEX IF NOT EXISTS idx_projects_parent_episode ON projects(parent_project_id, episode_number);
