-- spike3-registry-migration.draft.sql
-- SPIKE 3 — External key registry (DESIGN SPIKE, NOT RUN).
--
-- Status: DRAFT for review only. This file lives under
-- docs/development/spikes/p0d-20260820/ — NOT under
-- packages/core-backend/migrations/ — and MUST NOT be picked up by any
-- migration runner. Do not renumber/move it into the real migrations
-- directory without a follow-up ADR review pass.
--
-- Baseline read (must re-verify against HEAD before ever promoting this):
--   packages/core-backend/migrations/057_create_integration_core_tables.sql:1-14
--     tenant scoping convention (tenant_id NOT NULL, workspace_id nullable,
--     external-system-specific dimensions live in config JSONB, not columns).
--   packages/core-backend/migrations/057_create_integration_core_tables.sql:35-42
--     the COALESCE(workspace_id, '') expression-index trap for NULL !=
--     NULL under Postgres UNIQUE semantics (PG14, no NULLS NOT DISTINCT yet).
--   packages/core-backend/migrations/073_create_sealed_export_stock_prep_runtime_authority.sql:14-53
--     the more recent variant of the same trap: a STORED generated
--     `workspace_scope_key` column instead of repeating COALESCE(...) in
--     every index, plus the "one ACTIVE row per scope" partial-unique-index
--     pattern this migration reuses directly (binding_id PK convention,
--     `status`/state-scoped partial unique index, `_id PRIMARY KEY` naming).
--   packages/core-backend/src/db/migrations/zzz20251231_create_meta_schema.ts:44-51
--     meta_records.id is TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text —
--     meta_record_external_keys.record_id below follows that column's type.
--   packages/core-backend/src/attendance/w4c0-fingerprints.ts:37-82
--     canonicalAttendanceJsonV1 — precedent for "hash the canonical form,
--     store the version tag next to the hash" in this codebase.
--
-- Idempotent: every statement is IF NOT EXISTS / guarded, safe to re-run.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Bindings — one row per (tenant, workspace, external_system, object) that
--    is enrolled in key-registry tracking, and the meta_sheet it resolves
--    matched records into. This is the "scope" the ADR's UNIQUE indexes are
--    anchored to; it mirrors integration_sealed_export_stock_prep_bindings'
--    binding_id + workspace_scope_key + "one ACTIVE per scope" shape
--    (073_create_sealed_export_stock_prep_runtime_authority.sql:14-53),
--    trimmed to what a general-purpose key registry needs.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS integration_external_key_bindings (
  binding_id            TEXT PRIMARY KEY,
  tenant_id             TEXT NOT NULL,
  workspace_id          TEXT,
  workspace_scope_key   TEXT GENERATED ALWAYS AS (COALESCE(workspace_id, '')) STORED,
  external_system_id    TEXT NOT NULL REFERENCES integration_external_systems(id) ON DELETE RESTRICT,
  object_key            TEXT NOT NULL,                    -- source object name (物料/BOM/表名/endpoint) — same role as integration_pipelines.source_object (057:60)
  sheet_id              TEXT NOT NULL,                     -- meta_sheets.id (cross-schema; see zzz20251231_create_meta_schema.ts:8-17) — target of the matched records
  -- The CURRENT active normalization generation for this binding. Nullable
  -- until the first generation is built+activated (a fresh binding starts
  -- with no keys and no generation yet). NOT a foreign key at the column
  -- level to avoid a circular FK with table 2 below at CREATE TABLE time;
  -- enforced by the deferred FK added after table 2 exists (see bottom).
  active_registry_generation_id TEXT,
  status                 TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One ACTIVE binding per (tenant, workspace, system, object) — same pattern
-- as uniq_integration_sealed_export_stock_prep_active_binding (073:44-53).
CREATE UNIQUE INDEX IF NOT EXISTS
  uniq_integration_external_key_bindings_active_scope
  ON integration_external_key_bindings (tenant_id, workspace_scope_key, external_system_id, object_key)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_integration_external_key_bindings_scope
  ON integration_external_key_bindings (tenant_id, workspace_scope_key);
CREATE INDEX IF NOT EXISTS idx_integration_external_key_bindings_sheet
  ON integration_external_key_bindings (sheet_id);

-- ---------------------------------------------------------------------------
-- 2. Registry generations — one row per normalization-rule epoch for a
--    binding. Exactly one generation per binding may be 'active' at a time;
--    the partial unique index below is what makes the generation SWITCH
--    atomic (a single UPDATE flips old.status 'active'->'frozen' and
--    new.status 'building'->'active' inside one transaction; if two writers
--    race, the index turns the loser into a 23505 instead of a silent
--    double-active state).
--
--    Lifecycle: building -> active -> frozen -> retired.
--      building: rebuild in progress under a new normalization_version; not
--                yet queryable by the app, not yet uniqueness-authoritative.
--      active:   the ONE generation `meta_record_external_keys` lookups and
--                new upserts are scoped against for this binding.
--      frozen:   was active, has been superseded by a newer generation.
--                Rows under a frozen generation are kept (audit/rollback),
--                but no new upserts target it. Plans/pipelines bound to a
--                frozen generation_id are STALE (ADR "Consequences").
--      retired:  frozen long enough / explicitly archived; same read-only
--                posture as frozen, kept only for the distinction of "we
--                are done watching this one for rollback purposes."
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS integration_external_key_registry_generations (
  registry_generation_id   TEXT PRIMARY KEY,
  binding_id                TEXT NOT NULL REFERENCES integration_external_key_bindings(binding_id) ON DELETE CASCADE,
  generation_no              INTEGER NOT NULL,             -- 1, 2, 3, ... monotonic per binding_id
  normalization_version       TEXT NOT NULL,                -- e.g. 'v1', 'v2' — see spike3-registry-prototype.ts normalizeKey()
  status                      TEXT NOT NULL DEFAULT 'building' CHECK (status IN ('building', 'active', 'frozen', 'retired')),
  built_from_generation_id    TEXT REFERENCES integration_external_key_registry_generations(registry_generation_id),
  -- Migration report produced by detectCollapse() BEFORE the switch — see
  -- spike3-registry-prototype.ts detectCollapse(). Coarse-grained counts +
  -- the conflict groups that blocked (or were manually resolved before) the
  -- switch. Never raw business-key values beyond what's needed to act on the
  -- report (mirrors the values-light posture of integration_read_source_
  -- config_audit.detail — 062_create_integration_read_source_configs.sql:64).
  migration_report            JSONB NOT NULL DEFAULT '{}'::jsonb,
  activated_at                 TIMESTAMPTZ,
  frozen_at                     TIMESTAMPTZ,
  retired_at                     TIMESTAMPTZ,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_integration_external_key_registry_generations_no
    UNIQUE (binding_id, generation_no)
);

-- Exactly one ACTIVE generation per binding at any instant — this IS the
-- atomicity mechanism for "switch active registry generation" (ADR
-- §Decision, upgrade flow step 5). Anything reading "the" active generation
-- for a binding does `SELECT ... WHERE binding_id = ? AND status = 'active'`
-- and is guaranteed at most one row.
CREATE UNIQUE INDEX IF NOT EXISTS
  uniq_integration_external_key_registry_generations_active
  ON integration_external_key_registry_generations (binding_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_integration_external_key_registry_generations_binding
  ON integration_external_key_registry_generations (binding_id);
CREATE INDEX IF NOT EXISTS idx_integration_external_key_registry_generations_status
  ON integration_external_key_registry_generations (status);

-- Deferred FK from table 1 -> table 2, added now that table 2 exists.
-- NOT VALID + VALIDATE split intentionally omitted here (spike scope; both
-- tables start empty in any real rollout of this migration, so a plain FK
-- add is cheap — flag as an open question for the real migration if a
-- backfill scenario changes that assumption).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_integration_external_key_bindings_active_generation'
  ) THEN
    ALTER TABLE integration_external_key_bindings
      ADD CONSTRAINT fk_integration_external_key_bindings_active_generation
      FOREIGN KEY (active_registry_generation_id)
      REFERENCES integration_external_key_registry_generations(registry_generation_id)
      ON DELETE SET NULL;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. meta_record_external_keys — the registry itself.
--
--    Design decisions (see spike3-registry-adr.md for full rationale):
--
--    a) Hash-collision safety: UNIQUE(registry_generation_id,
--       normalized_key_hash, canonical_key) — NOT UNIQUE(...,
--       normalized_key_hash) alone. Two DIFFERENT canonical_key values that
--       happen to share a sha256 digest are both allowed to exist as active
--       rows simultaneously; the app-layer lookup path is always "index scan
--       on (generation_id, hash) to find CANDIDATE rows, then full string
--       compare on canonical_key to pick the real match" — see
--       classifyUpsert() in spike3-registry-prototype.ts, which implements
--       exactly this contract in-memory. The DB index exists to make that
--       candidate scan cheap, not to be the sole uniqueness proof.
--
--    b) Generation-scoped uniqueness, not binding-scoped: both partial
--       unique indexes below key on registry_generation_id (which already
--       implies binding_id via the FK chain to table 2), NOT on binding_id
--       directly. This is what lets an in-flight normalization-version
--       upgrade build a full NEW generation's worth of rows (state can even
--       be 'active' within the NEW generation) without colliding against
--       the OLD generation's still-'active' rows for the same binding — the
--       old and new generation's rows are simply in different uniqueness
--       scopes until the atomic switch (table 2) flips which one the app
--       queries as "the" active generation.
--
--    c) One active record <-> one active key (bijective) per generation:
--       UNIQUE(registry_generation_id, canonical_key) [subsumed by (a)'s
--       compound index] enforces "one external key never points to two
--       active records" for a fixed canonical string; UNIQUE(
--       registry_generation_id, record_id) WHERE state='active' enforces
--       the OTHER direction — one record never holds two simultaneously
--       active external keys within the same generation. Multiple
--       *historical* (state != 'active') rows per record are expected and
--       fine (superseded_by_id chains them — see column comment).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meta_record_external_keys (
  id                      TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id               TEXT NOT NULL,                    -- denormalized from binding for direct scoping/RLS-readiness; MUST equal bindings.tenant_id (app-enforced, see ADR open questions)
  workspace_id            TEXT,
  workspace_scope_key     TEXT GENERATED ALWAYS AS (COALESCE(workspace_id, '')) STORED,
  binding_id               TEXT NOT NULL REFERENCES integration_external_key_bindings(binding_id) ON DELETE CASCADE,
  registry_generation_id    TEXT NOT NULL REFERENCES integration_external_key_registry_generations(registry_generation_id) ON DELETE CASCADE,
  record_id                 TEXT NOT NULL REFERENCES meta_records(id) ON DELETE CASCADE,
  raw_key                    TEXT NOT NULL,                  -- exact source-system value as ingested, pre-normalization (needed to re-run detectCollapse() at the NEXT upgrade)
  canonical_key               TEXT NOT NULL,                 -- normalizeKey(raw_key, normalization_version) output — NOT NULL per spike requirement
  normalized_key_hash          TEXT NOT NULL,                -- sha256(canonical_key) hex — NOT NULL per spike requirement; see hashCanonicalKey() in prototype
  normalization_version         TEXT NOT NULL,                -- NOT NULL per spike requirement; MUST equal the owning generation's normalization_version (CHECK below is a cheap same-row guard; the authoritative guarantee is "this row was only ever written by the rebuild job for that generation")
  state                          TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'superseded', 'collapsed', 'conflict', 'retired')),
  -- Single-hop history breadcrumb for a manual renumber (ADR: v1 rejects
  -- auto-renumber). When an operator manually retires an old key and mints a
  -- new one for the SAME record, the old row's state becomes 'superseded'
  -- and superseded_by_id points at the new row. NOT a general alias/history
  -- graph (P1) — see ADR §"Alias/history decision".
  superseded_by_id                TEXT REFERENCES meta_record_external_keys(id),
  created_at                        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- (a) + (c), first direction: within one generation, an exact canonical key
-- occupies at most one ACTIVE row — "one external key never points to two
-- active records". Hash collisions between DIFFERENT canonical_key values
-- are explicitly NOT blocked by this index (that's the point — see design
-- decision (a) above).
CREATE UNIQUE INDEX IF NOT EXISTS
  uniq_meta_record_external_keys_active_canonical
  ON meta_record_external_keys (registry_generation_id, normalized_key_hash, canonical_key)
  WHERE state = 'active';

-- (c), second direction: within one generation, a record holds at most one
-- ACTIVE external key — "one active record <-> one active key".
CREATE UNIQUE INDEX IF NOT EXISTS
  uniq_meta_record_external_keys_active_record
  ON meta_record_external_keys (registry_generation_id, record_id)
  WHERE state = 'active';

CREATE INDEX IF NOT EXISTS idx_meta_record_external_keys_binding
  ON meta_record_external_keys (binding_id, registry_generation_id);
CREATE INDEX IF NOT EXISTS idx_meta_record_external_keys_record
  ON meta_record_external_keys (record_id);
CREATE INDEX IF NOT EXISTS idx_meta_record_external_keys_scope
  ON meta_record_external_keys (tenant_id, workspace_scope_key);
-- Supports the "does this row's normalization_version match its generation's?"
-- consistency audit query without a join-heavy scan.
CREATE INDEX IF NOT EXISTS idx_meta_record_external_keys_generation_version
  ON meta_record_external_keys (registry_generation_id, normalization_version);

-- Cheap same-row sanity check (catches an obviously wrong write; does NOT by
-- itself guarantee cross-table consistency with the generation's declared
-- normalization_version — see ADR open questions on whether a trigger should
-- enforce that join-level invariant for a real implementation).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_meta_record_external_keys_version_nonblank'
  ) THEN
    ALTER TABLE meta_record_external_keys
      ADD CONSTRAINT chk_meta_record_external_keys_version_nonblank
      CHECK (normalization_version <> '');
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- updated_at triggers (reuse the integration_set_updated_at() function
-- already defined by 057_create_integration_core_tables.sql; this migration
-- assumes 057 has already run, matching every later integration_* migration
-- in this repo — see 062/064's own trigger blocks for the same assumption).
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_integration_external_key_bindings_updated_at') THEN
    CREATE TRIGGER trg_integration_external_key_bindings_updated_at
      BEFORE UPDATE ON integration_external_key_bindings
      FOR EACH ROW EXECUTE FUNCTION integration_set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_integration_external_key_registry_generations_updated_at') THEN
    CREATE TRIGGER trg_integration_external_key_registry_generations_updated_at
      BEFORE UPDATE ON integration_external_key_registry_generations
      FOR EACH ROW EXECUTE FUNCTION integration_set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_meta_record_external_keys_updated_at') THEN
    CREATE TRIGGER trg_meta_record_external_keys_updated_at
      BEFORE UPDATE ON meta_record_external_keys
      FOR EACH ROW EXECUTE FUNCTION integration_set_updated_at();
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Deliberately NOT included in this draft (see ADR "Alias/history decision"
-- and "Open questions"):
--   * meta_record_external_key_aliases / *_history — a full multi-hop,
--     multi-simultaneous-alias schema for source-side auto-renumber. v1
--     rejects auto-renumber; superseded_by_id above is the entire history
--     mechanism for v1's manual-only renumber flow.
--   * Row-level security policies — tenant_id/workspace scoping here is the
--     same convention-only (app-enforced) posture as every table in
--     057/062/064; no RLS exists anywhere else in the integration_* schema
--     for this migration to be consistent with.
-- ---------------------------------------------------------------------------
