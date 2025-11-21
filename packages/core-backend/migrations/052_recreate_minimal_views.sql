-- Migration: 052_recreate_minimal_views.sql
-- Purpose: Recreate minimal views + view_states tables after prior drop, using TEXT PK for views.
-- Includes seed demo view 'v-demo' to enable snapshot validation flows locally.
-- Idempotent guards ensure safe re-run; seed insert uses ON CONFLICT DO NOTHING.

CREATE TABLE IF NOT EXISTS views (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'board',
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS view_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  view_id TEXT NOT NULL REFERENCES views(id) ON DELETE CASCADE,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_views_type ON views(type);
CREATE INDEX IF NOT EXISTS idx_views_created_by ON views(created_by);
CREATE INDEX IF NOT EXISTS idx_view_states_view ON view_states(view_id);

-- Seed demo view for local validation (v-demo)
INSERT INTO views (id, name, type, created_by)
VALUES ('v-demo', 'Demo Validation View', 'board', 'system')
ON CONFLICT (id) DO NOTHING;

