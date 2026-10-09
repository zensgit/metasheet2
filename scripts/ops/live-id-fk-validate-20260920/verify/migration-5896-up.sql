-- ============================================================================
-- migration-5896-up.sql — the four statements of PR #5896's `up()`, verbatim
-- ============================================================================
-- Transcribed from
--   packages/core-backend/src/db/migrations/zzzz20260920120000_data_source_live_id_binding_lock.ts
-- with the two `${sql.lit/raw(LIVE_FK|LEGACY_FK)}` interpolations expanded to
-- the constants declared at :77-78 of that file. Nothing else is changed.
--
-- WHY A TRANSCRIPTION AND NOT `pnpm migrate`. The repo's migrate entrypoint
-- pulls in the backend's whole runtime config (DB pool, Redis, env) and would
-- run every other migration; this pack only needs the schema shape #5896
-- produces. verify/live-id-fk-validate-pack.test.mjs re-extracts the sql`…`
-- template bodies from that .ts at test time and asserts, after whitespace
-- normalisation, that each one is present here — so this file cannot silently
-- drift from the migration it claims to reproduce.
--
-- The `checkTableExists` guards of the original are omitted: the fixture always
-- creates both tables, and the test that compares the two files ignores them.
-- ============================================================================

ALTER TABLE data_sources
  ADD COLUMN IF NOT EXISTS live_id TEXT
  GENERATED ALWAYS AS (CASE WHEN deleted_at IS NULL THEN id END) STORED;

CREATE UNIQUE INDEX IF NOT EXISTS uq_data_sources_live_id
  ON data_sources (live_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_integration_external_systems_live_connection_id'
      AND conrelid = 'integration_external_systems'::regclass
  ) THEN
    ALTER TABLE integration_external_systems
      ADD CONSTRAINT fk_integration_external_systems_live_connection_id
      FOREIGN KEY (connection_id) REFERENCES data_sources(live_id)
      ON DELETE RESTRICT
      NOT VALID;
  END IF;
END $$;

ALTER TABLE integration_external_systems
  DROP CONSTRAINT IF EXISTS fk_integration_external_systems_connection_id;
