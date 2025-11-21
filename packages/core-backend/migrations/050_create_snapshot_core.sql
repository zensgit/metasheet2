-- Migration: 050_create_snapshot_core.sql
-- Provides base snapshot & snapshot_items tables required for Sprint 2 validation.
-- Idempotent: uses IF NOT EXISTS guards.

CREATE TABLE IF NOT EXISTS snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  view_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  version INT NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  snapshot_type TEXT NOT NULL DEFAULT 'manual',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_locked BOOLEAN NOT NULL DEFAULT FALSE,
  parent_snapshot_id UUID REFERENCES snapshots(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NULL,
  tags TEXT[] NOT NULL DEFAULT '{}',
  protection_level TEXT NOT NULL DEFAULT 'normal',
  release_channel TEXT NULL,
  CONSTRAINT chk_protection_level CHECK (protection_level IN ('normal','protected','critical')),
  CONSTRAINT chk_release_channel CHECK (release_channel IS NULL OR release_channel IN ('stable','canary','beta','experimental'))
);

CREATE TABLE IF NOT EXISTS snapshot_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id UUID NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL,
  item_id TEXT NOT NULL,
  data JSONB NOT NULL,
  checksum TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes (idempotent)
CREATE INDEX IF NOT EXISTS idx_snapshots_view ON snapshots(view_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_created_by ON snapshots(created_by);
CREATE INDEX IF NOT EXISTS idx_snapshots_version ON snapshots(view_id, version);
CREATE INDEX IF NOT EXISTS idx_snapshot_items_snapshot ON snapshot_items(snapshot_id);
CREATE INDEX IF NOT EXISTS idx_snapshot_items_type ON snapshot_items(item_type);
CREATE INDEX IF NOT EXISTS idx_snapshot_items_composite ON snapshot_items(snapshot_id, item_type);
CREATE INDEX IF NOT EXISTS idx_snapshots_tags ON snapshots USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_snapshots_protection_level ON snapshots(protection_level);
CREATE INDEX IF NOT EXISTS idx_snapshots_release_channel ON snapshots(release_channel) WHERE release_channel IS NOT NULL;

