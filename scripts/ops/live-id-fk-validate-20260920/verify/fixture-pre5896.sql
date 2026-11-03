-- ============================================================================
-- fixture-pre5896.sql — a synthetic, obviously-fake database in the state a
--   production database is in JUST BEFORE PR #5896's migration runs
-- ============================================================================
-- Loaded into a throwaway `h5_fixture_*` schema by verify/run-verify.mjs. Never
-- point this harness at a real database: every id, name and host below is
-- nonsense on purpose, and the harness DROPs the schema it created.
--
-- Column subset, not a copy. Only the columns this pack reads or writes are
-- reproduced, from:
--   packages/core-backend/src/db/migrations/20251206000001_create_data_sources_table.ts
--     (id, owner_id, is_active, deleted_at)
--   packages/core-backend/migrations/057_create_integration_core_tables.sql:20-35
--     (integration_external_systems core columns)
--   packages/core-backend/src/db/migrations/zzzz20260902120000_add_integration_connection_binding.ts
--     (data_sources.tenant_id/scope_kind, integration_external_systems.connection_id,
--      legacy_connection_fallback_eligible, and the id-targeted FK this fixture installs)
-- The FK installed here is the PRE-#5896 one (REFERENCES data_sources(id)) —
-- which is exactly why the dangling rows below can be planted at all.
-- ============================================================================

CREATE TABLE data_sources (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL,
  owner_id    TEXT NOT NULL,
  config      JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  tenant_id   TEXT,
  scope_kind  TEXT NOT NULL DEFAULT 'private',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ
);

CREATE TABLE integration_external_systems (
  id                                 TEXT PRIMARY KEY,
  tenant_id                          TEXT NOT NULL,
  workspace_id                       TEXT,
  project_id                         TEXT,
  name                               TEXT NOT NULL,
  kind                               TEXT NOT NULL,
  role                               TEXT NOT NULL CHECK (role IN ('source', 'target', 'bidirectional')),
  config                             JSONB NOT NULL DEFAULT '{}'::jsonb,
  credentials_encrypted              TEXT,
  capabilities                       JSONB NOT NULL DEFAULT '{}'::jsonb,
  status                             TEXT NOT NULL DEFAULT 'inactive',
  last_tested_at                     TIMESTAMPTZ,
  last_error                         TEXT,
  created_at                         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  connection_id                      TEXT,
  legacy_connection_fallback_eligible BOOLEAN NOT NULL DEFAULT FALSE
);

ALTER TABLE integration_external_systems
  ADD CONSTRAINT fk_integration_external_systems_connection_id
  FOREIGN KEY (connection_id) REFERENCES data_sources(id) ON DELETE RESTRICT;

CREATE INDEX idx_integration_external_systems_connection_id
  ON integration_external_systems (connection_id);

-- ── data sources ──────────────────────────────────────────────────────────
-- ds-live  : live, must never appear in any inventory
-- ds-dead-1: soft-deleted; the target of the canonical-shaped dangling binding
-- ds-dead-2: soft-deleted; the target of the legacy-shaped dangling binding
INSERT INTO data_sources (id, name, type, owner_id, is_active, deleted_at) VALUES
  ('ds-live',   'fixture live source',   'postgres', 'user-fixture-a', TRUE,  NULL),
  ('ds-dead-1', 'fixture dead source 1', 'postgres', 'user-fixture-a', FALSE, NOW() - INTERVAL '3 days'),
  ('ds-dead-2', 'fixture dead source 2', 'postgres', 'user-fixture-b', FALSE, NOW() - INTERVAL '1 day');

-- ── bindings ──────────────────────────────────────────────────────────────
-- es-ok       : healthy canonical binding on a LIVE source. Must stay out of
--               the inventory and must survive 02 untouched.
-- es-dangle-1 : CANONICAL shape (lib/external-systems.cjs:486, :548-553 delete
--               `config.dataSourceId` before INSERT) pointing at a soft-deleted
--               source. This is the row 02 must write a receipt for.
-- es-dangle-2 : LEGACY/cutover shape — pointer already in config, marker TRUE
--               (zzzz20260902120000 backfill). 02 must NOT rewrite its config.
INSERT INTO integration_external_systems
  (id, tenant_id, workspace_id, name, kind, role, config, connection_id,
   legacy_connection_fallback_eligible)
VALUES
  ('es-ok', 'tenant-fixture-1', NULL, 'fixture ok binding',
   'data-source:sql-readonly', 'source', '{"schema":"public"}'::jsonb, 'ds-live', FALSE),
  ('es-dangle-1', 'tenant-fixture-1', NULL, 'fixture dangling canonical',
   'data-source:sql-readonly', 'source', '{"schema":"public"}'::jsonb, 'ds-dead-1', FALSE),
  ('es-dangle-2', 'tenant-fixture-2', NULL, 'fixture dangling legacy',
   'data-source:sql-readonly', 'source',
   '{"schema":"public","dataSourceId":"ds-dead-2","dataSourceOwnerId":"user-fixture-b"}'::jsonb,
   'ds-dead-2', TRUE);
