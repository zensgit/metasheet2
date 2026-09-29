-- ============================================================================
-- migration-up.sql — the SQL of
--   packages/core-backend/src/db/migrations/zzzz20260926140000_sealed_export_binding_live_external_system_fk.ts
-- up(), statement for statement, for the synthetic verify harness.
-- ============================================================================
-- The harness speaks only psql (no Kysely, no npm install), so it cannot call
-- up() itself. This file is its stand-in, and it may NOT drift:
-- sealed-export-binding-live-fk-validate-pack.test.mjs slices every sql`…`
-- template out of up(), substitutes the constraint-name constant, and fails if
-- any of them is not reproduced here verbatim (whitespace-normalised). A second
-- test proves that check bites by feeding it a copy without NOT VALID.
-- up()'s checkTableExists() early returns are not reproduced: the harness only
-- applies this file to a schema that has both tables.
-- ============================================================================

  ALTER TABLE integration_sealed_export_stock_prep_bindings
      ADD COLUMN IF NOT EXISTS live_external_system_id TEXT
      GENERATED ALWAYS AS (CASE WHEN status = 'ACTIVE' THEN external_system_id END) STORED
  ;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_attribute
        WHERE attrelid = 'integration_sealed_export_stock_prep_bindings'::regclass
          AND attname = 'live_external_system_id'
          AND attgenerated = 's'
          AND NOT attisdropped
      ) THEN
        RAISE EXCEPTION 'integration_sealed_export_stock_prep_bindings.live_external_system_id exists but is not a stored generated column'
          USING ERRCODE = '55000';
      END IF;
    END $$
  ;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'fk_sealed_export_stock_prep_binding_live_external_system'
          AND conrelid = 'integration_sealed_export_stock_prep_bindings'::regclass
      ) THEN
        ALTER TABLE integration_sealed_export_stock_prep_bindings
          ADD CONSTRAINT fk_sealed_export_stock_prep_binding_live_external_system
          FOREIGN KEY (live_external_system_id)
          REFERENCES integration_external_systems(id)
          ON DELETE RESTRICT
          NOT VALID;
      END IF;
    END $$
  ;
