-- =============================================================================
-- SPIKE 2 — Mirror Publication : migration DRAFT (Option A)
-- DRAFT ONLY. NOT RUN. Not placed in the real migrations dir on purpose.
-- Baseline: main c5a4a94f7.
--
-- Design (see spike2-mirror-adr.md): the user-facing mirror sheet is ALWAYS the
-- current generation. Publish computes a keyed diff (create / update-preserving-
-- id / inactivate) and applies it to meta_records in ONE transaction, so readers
-- (SELECT ... FROM meta_records) see complete-old-or-complete-new. These tables
-- add binding state, a staging store, and sealed generation snapshots WITHOUT
-- touching meta_records / meta_links / any read path.
--
-- Every statement is idempotent (IF NOT EXISTS). meta_records / meta_links are
-- NOT altered here — no generation_id column is added (that is rejected Option C).
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid(), matches core schema

-- -----------------------------------------------------------------------------
-- 1) mirror_binding — one row per mirror sheet. Holds the publish state machine
--    cursor, the mutex, and the ACTIVE (published) generation pointer.
--    active_generation_id is observability/recovery/retention — atomic visibility
--    itself comes from the single upsert txn, not from flipping this pointer.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mirror_binding (
  -- deterministic sheet id from provisioning.getObjectSheetId(projectId,objectId)
  -- (packages/core-backend/src/multitable/provisioning.ts:138). One binding per mirror sheet.
  sheet_id              text PRIMARY KEY REFERENCES meta_sheets(id) ON DELETE CASCADE,
  project_id            text NOT NULL,
  object_id             text NOT NULL,

  -- business key: keyOf(row) = join of data[fieldId] for fieldId in key_field_ids.
  -- Used by diffGenerations to match next-gen rows to existing meta_records.id.
  key_field_ids         text[] NOT NULL DEFAULT '{}',

  -- publish state machine cursor (see spike2-mirror-prototype.ts publishReducer):
  -- idle | refreshing | staged | proposed | approved | applied | failed
  publish_status        text NOT NULL DEFAULT 'idle',

  -- ACTIVE published generation. NULL before first publish. This is what a plan
  -- binds to (acceptance #9) — NOT the staging id. FK added via ALTER after
  -- mirror_generation exists (see below) to avoid a forward reference.
  active_generation_id  uuid,

  -- concurrency mutex (acceptance #10). Non-null => a worker holds the binding.
  -- Paired at runtime with pg_advisory_xact_lock(hashtext(sheet_id)) for hard
  -- serialization of refresh/publish/propose/apply.
  lock_token            uuid,
  lock_holder           text,
  lock_acquired_at      timestamptz,

  last_error            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT mirror_binding_status_chk CHECK (
    publish_status IN ('idle','refreshing','staged','proposed','approved','applied','failed')
  )
);

-- -----------------------------------------------------------------------------
-- 2) mirror_generation — a SEALED snapshot of a candidate/published generation.
--    Rows created at 'publish' (staging -> sealed). Retained N deep for audit +
--    rollback + retention (acceptance #8). A plan proposes against one of these.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mirror_generation (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sheet_id          text NOT NULL REFERENCES meta_sheets(id) ON DELETE CASCADE,
  -- monotonic per sheet; human-facing generation number.
  seq               bigint NOT NULL,
  -- lifecycle: sealed (candidate) | published (was applied) | superseded | discarded
  status            text NOT NULL DEFAULT 'sealed',
  -- row count + content hash of the sealed snapshot for restart-recovery / integrity.
  row_count         integer NOT NULL DEFAULT 0,
  content_hash      text,
  sealed_from_staging_batch uuid,           -- provenance; asserts gen != staging (acceptance #9)
  created_by        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  published_at      timestamptz,

  CONSTRAINT mirror_generation_status_chk CHECK (
    status IN ('sealed','published','superseded','discarded')
  ),
  CONSTRAINT mirror_generation_seq_uq UNIQUE (sheet_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_mirror_generation_sheet_seq
  ON mirror_generation(sheet_id, seq DESC);

-- Now that mirror_generation exists, wire mirror_binding.active_generation_id FK.
-- (Postgres has no "ADD CONSTRAINT IF NOT EXISTS"; guard via catalog lookup so the
--  draft stays idempotent.)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mirror_binding_active_generation_id_fkey'
  ) THEN
    ALTER TABLE mirror_binding
      ADD CONSTRAINT mirror_binding_active_generation_id_fkey
      FOREIGN KEY (active_generation_id) REFERENCES mirror_generation(id) ON DELETE SET NULL;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 3) mirror_generation_row — the frozen row payloads of a sealed generation.
--    business_key is what diffGenerations matches on. resolved_record_id is the
--    meta_records.id this key maps to (filled at publish for updates; NULL for a
--    brand-new key until applied). This is how id-stability is persisted across
--    generations and how restart-recovery reconstructs the diff.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mirror_generation_row (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  generation_id      uuid NOT NULL REFERENCES mirror_generation(id) ON DELETE CASCADE,
  business_key       text NOT NULL,
  data               jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- the stable meta_records.id this row is/was published as (id preservation).
  resolved_record_id text,
  -- create | update | inactivate | unchanged  (mirrors diffGenerations buckets)
  diff_op            text,
  CONSTRAINT mirror_generation_row_key_uq UNIQUE (generation_id, business_key)
);

CREATE INDEX IF NOT EXISTS idx_mirror_generation_row_gen
  ON mirror_generation_row(generation_id);
CREATE INDEX IF NOT EXISTS idx_mirror_generation_row_record
  ON mirror_generation_row(resolved_record_id);

-- -----------------------------------------------------------------------------
-- 4) mirror_staging — the mutable landing zone for a refresh in progress. Filled
--    during 'refreshing'; on 'publish' it is sealed into a mirror_generation and
--    cleared. Never read by any user-facing path. A plan NEVER binds to a staging
--    batch (acceptance #9) — only to the sealed generation.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mirror_staging (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id      uuid NOT NULL,                 -- one refresh cycle
  sheet_id      text NOT NULL REFERENCES meta_sheets(id) ON DELETE CASCADE,
  business_key  text NOT NULL,
  data          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mirror_staging_key_uq UNIQUE (batch_id, business_key)  -- keyOf uniqueness guard
);

CREATE INDEX IF NOT EXISTS idx_mirror_staging_batch
  ON mirror_staging(batch_id);

-- -----------------------------------------------------------------------------
-- 5) mirror_publish_plan — the proposed/approved plan. Binds the SEALED published
--    generation id (NOT staging). Drives approve->apply and restart recovery.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mirror_publish_plan (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sheet_id        text NOT NULL REFERENCES meta_sheets(id) ON DELETE CASCADE,
  -- ACCEPTANCE #9: a plan binds a sealed generation, never a staging batch.
  generation_id   uuid NOT NULL REFERENCES mirror_generation(id) ON DELETE CASCADE,
  -- proposed | approved | applied | aborted
  state           text NOT NULL DEFAULT 'proposed',
  creates_count   integer NOT NULL DEFAULT 0,
  updates_count   integer NOT NULL DEFAULT 0,
  inactivates_count integer NOT NULL DEFAULT 0,
  proposed_by     text,
  approved_by     text,
  proposed_at     timestamptz NOT NULL DEFAULT now(),
  approved_at     timestamptz,
  applied_at      timestamptz,
  CONSTRAINT mirror_publish_plan_state_chk CHECK (
    state IN ('proposed','approved','applied','aborted')
  )
);

CREATE INDEX IF NOT EXISTS idx_mirror_publish_plan_sheet
  ON mirror_publish_plan(sheet_id, proposed_at DESC);

-- At most one non-terminal plan per sheet (serializes propose/approve/apply).
CREATE UNIQUE INDEX IF NOT EXISTS uq_mirror_publish_plan_active
  ON mirror_publish_plan(sheet_id)
  WHERE state IN ('proposed','approved');

-- -----------------------------------------------------------------------------
-- NOTE (soft inactivation): the apply step marks disappeared keys inactive
-- in-place so inbound meta_links.foreign_record_id strings (text, NO FK — see
-- schema zzzz20260404153000...ts:36) never dangle:
--
--   UPDATE meta_records
--      SET data = data || '{"__mirror_inactive": true}'::jsonb,
--          version = version + 1
--    WHERE id = ANY($inactivated_ids);
--
-- Hard cleanup of inactivated rows (acceptance #8) is done LATER via the normal
-- trash-backed record-service.deleteRecord path (record-service.ts:957 +
-- meta_records_trash), never a raw DELETE, to preserve recycle-bin/restore.
-- -----------------------------------------------------------------------------

-- =============================================================================
-- DOWN (draft): drop in dependency order. Left commented — this is a spike.
-- =============================================================================
-- DROP TABLE IF EXISTS mirror_publish_plan;
-- DROP TABLE IF EXISTS mirror_staging;
-- DROP TABLE IF EXISTS mirror_generation_row;
-- ALTER TABLE mirror_binding DROP CONSTRAINT IF EXISTS mirror_binding_active_generation_id_fkey;
-- DROP TABLE IF EXISTS mirror_generation;
-- DROP TABLE IF EXISTS mirror_binding;
