import { sql, type Kysely } from 'kysely'

/**
 * Phase D2e / D-H1: add durable archive ownership to the one canonical sheet writer block.
 *
 * This is schema-only substrate. It adds no caller and enables no flag. The migration is
 * intentionally fail-loud: a partial prior install, a drifted parent state constraint, or a
 * nonempty owner tuple on down is not treated as an idempotent success.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$
    DECLARE
      source_mismatch_count integer;
      owned_object_count integer;
      state_check_def text;
    BEGIN
      WITH expected(column_name, type_name, is_not_null) AS (
        VALUES
          ('id', 'text', true),
          ('recovery_writer_state', 'text', false)
      )
      SELECT count(*)::integer
        INTO source_mismatch_count
        FROM expected
        LEFT JOIN pg_catalog.pg_class relation
          ON relation.oid = pg_catalog.to_regclass('public.meta_sheets')
         AND relation.relkind = 'r'
        LEFT JOIN pg_catalog.pg_namespace namespace
          ON namespace.oid = relation.relnamespace
         AND namespace.nspname = 'public'
        LEFT JOIN pg_catalog.pg_attribute attribute
          ON attribute.attrelid = relation.oid
         AND attribute.attname = expected.column_name
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
       WHERE namespace.oid IS NULL
          OR attribute.attnum IS NULL
          OR pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) <> expected.type_name
          OR attribute.attnotnull <> expected.is_not_null;

      SELECT regexp_replace(
               btrim(pg_catalog.pg_get_constraintdef(constraint_row.oid, true)),
               '[[:space:]]+',
               ' ',
               'g'
             )
        INTO state_check_def
        FROM pg_catalog.pg_constraint constraint_row
        JOIN pg_catalog.pg_class relation ON relation.oid = constraint_row.conrelid
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = 'public'
         AND relation.relname = 'meta_sheets'
         AND constraint_row.conname = 'chk_meta_sheets_recovery_writer_state'
         AND constraint_row.contype = 'c'
         AND constraint_row.convalidated;

      IF state_check_def IS DISTINCT FROM
         'CHECK (recovery_writer_state IS NULL OR (recovery_writer_state = ANY (ARRAY[''fencing''::text, ''applying''::text, ''paused_retryable''::text])))'
      THEN
        source_mismatch_count := source_mismatch_count + 1;
      END IF;

      SELECT count(*)::integer
        INTO owned_object_count
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'meta_sheets'
         AND column_name IN (
           'recovery_writer_owner_kind',
           'recovery_writer_owner_id',
           'recovery_writer_owner_fence',
           'recovery_writer_lease_until',
           'recovery_writer_updated_at'
         );

      owned_object_count := owned_object_count + (
        SELECT count(*)::integer
          FROM pg_catalog.pg_constraint constraint_row
          JOIN pg_catalog.pg_class relation ON relation.oid = constraint_row.conrelid
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = 'public'
           AND relation.relname = 'meta_sheets'
           AND constraint_row.conname IN (
             'chk_meta_sheets_recovery_writer_owner_kind',
             'chk_meta_sheets_recovery_writer_owner_tuple',
             'chk_meta_sheets_recovery_writer_fence'
           )
      );

      IF owned_object_count <> 0 THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'archive_writer_block_object_conflict';
      END IF;

      IF source_mismatch_count <> 0 THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'archive_writer_block_source_schema_mismatch';
      END IF;
    END $$;
  `.execute(db)

  await sql`
    ALTER TABLE public.meta_sheets
      ADD COLUMN recovery_writer_owner_kind text,
      ADD COLUMN recovery_writer_owner_id text,
      ADD COLUMN recovery_writer_owner_fence bigint,
      ADD COLUMN recovery_writer_lease_until timestamptz,
      ADD COLUMN recovery_writer_updated_at timestamptz
  `.execute(db)

  await sql`
    ALTER TABLE public.meta_sheets
      DROP CONSTRAINT chk_meta_sheets_recovery_writer_state,
      ADD CONSTRAINT chk_meta_sheets_recovery_writer_state
        CHECK (
          recovery_writer_state IS NULL
          OR recovery_writer_state IN ('fencing', 'applying', 'paused_retryable', 'archiving')
        ),
      ADD CONSTRAINT chk_meta_sheets_recovery_writer_owner_kind
        CHECK (
          recovery_writer_owner_kind IS NULL
          OR recovery_writer_owner_kind IN ('archive_generation', 'restore_job')
        ),
      ADD CONSTRAINT chk_meta_sheets_recovery_writer_owner_tuple
        CHECK (
          (
            recovery_writer_state IS DISTINCT FROM 'archiving'
            AND recovery_writer_owner_kind IS NULL
            AND recovery_writer_owner_id IS NULL
            AND recovery_writer_lease_until IS NULL
            AND recovery_writer_updated_at IS NULL
          ) OR (
            recovery_writer_state IS NOT DISTINCT FROM 'archiving'
            AND recovery_writer_owner_kind IS NOT NULL
            AND recovery_writer_owner_id IS NOT NULL
            AND length(btrim(recovery_writer_owner_id)) > 0
            AND recovery_writer_owner_fence IS NOT NULL
            AND recovery_writer_owner_fence >= 1
            AND recovery_writer_lease_until IS NOT NULL
            AND recovery_writer_updated_at IS NOT NULL
          )
        ),
      ADD CONSTRAINT chk_meta_sheets_recovery_writer_fence
        CHECK (
          recovery_writer_owner_fence IS NULL OR recovery_writer_owner_fence >= 1
        )
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$
    DECLARE
      schema_mismatch_count integer;
      ownership_present boolean;
    BEGIN
      WITH expected(column_name, type_name, is_not_null) AS (
        VALUES
          ('recovery_writer_owner_kind', 'text', false),
          ('recovery_writer_owner_id', 'text', false),
          ('recovery_writer_owner_fence', 'bigint', false),
          ('recovery_writer_lease_until', 'timestamp with time zone', false),
          ('recovery_writer_updated_at', 'timestamp with time zone', false)
      )
      SELECT count(*)::integer
        INTO schema_mismatch_count
        FROM expected
        LEFT JOIN pg_catalog.pg_class relation
          ON relation.oid = pg_catalog.to_regclass('public.meta_sheets')
         AND relation.relkind = 'r'
        LEFT JOIN pg_catalog.pg_namespace namespace
          ON namespace.oid = relation.relnamespace
         AND namespace.nspname = 'public'
        LEFT JOIN pg_catalog.pg_attribute attribute
          ON attribute.attrelid = relation.oid
         AND attribute.attname = expected.column_name
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
       WHERE namespace.oid IS NULL
          OR attribute.attnum IS NULL
          OR pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) <> expected.type_name
          OR attribute.attnotnull <> expected.is_not_null;

      IF schema_mismatch_count <> 0 THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'archive_writer_block_down_schema_mismatch';
      END IF;

      SELECT EXISTS (
        SELECT 1
          FROM public.meta_sheets
         WHERE recovery_writer_state = 'archiving'
            OR recovery_writer_owner_kind IS NOT NULL
            OR recovery_writer_owner_id IS NOT NULL
            OR recovery_writer_owner_fence IS NOT NULL
            OR recovery_writer_lease_until IS NOT NULL
            OR recovery_writer_updated_at IS NOT NULL
      ) INTO ownership_present;

      IF ownership_present THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'archive_writer_block_down_nonempty';
      END IF;
    END $$;
  `.execute(db)

  await sql`
    ALTER TABLE public.meta_sheets
      DROP CONSTRAINT chk_meta_sheets_recovery_writer_owner_tuple,
      DROP CONSTRAINT chk_meta_sheets_recovery_writer_owner_kind,
      DROP CONSTRAINT chk_meta_sheets_recovery_writer_fence,
      DROP CONSTRAINT chk_meta_sheets_recovery_writer_state,
      DROP COLUMN recovery_writer_updated_at,
      DROP COLUMN recovery_writer_lease_until,
      DROP COLUMN recovery_writer_owner_fence,
      DROP COLUMN recovery_writer_owner_id,
      DROP COLUMN recovery_writer_owner_kind,
      ADD CONSTRAINT chk_meta_sheets_recovery_writer_state
        CHECK (
          recovery_writer_state IS NULL
          OR recovery_writer_state IN ('fencing', 'applying', 'paused_retryable')
        )
  `.execute(db)
}
