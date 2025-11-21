-- Migration: 051_create_minimal_views.sql
-- Minimal views + view_states tables required for SnapshotService.
-- Idempotent definitions (IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS views (
  id TEXT PRIMARY KEY, -- loosen to text to allow human-friendly IDs like 'v-demo'
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'board',
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS view_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  view_id UUID NOT NULL REFERENCES views(id) ON DELETE CASCADE,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_views_type ON views(type);
CREATE INDEX IF NOT EXISTS idx_views_created_by ON views(created_by);
CREATE INDEX IF NOT EXISTS idx_view_states_view ON view_states(view_id);
