-- 056_create_attendance_rule_template_versions.sql
-- Store versioned snapshots of attendance rule template libraries

CREATE TABLE IF NOT EXISTS attendance_rule_template_versions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  templates JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by TEXT,
  source_version_id TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS attendance_rule_template_versions_org_version_idx
  ON attendance_rule_template_versions(org_id, version);

CREATE INDEX IF NOT EXISTS attendance_rule_template_versions_org_idx
  ON attendance_rule_template_versions(org_id);
