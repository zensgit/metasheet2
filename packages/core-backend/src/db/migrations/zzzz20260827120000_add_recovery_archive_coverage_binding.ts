import { sql, type Kysely } from 'kysely'

/**
 * Phase D2d2-PREP-A: additive coverage section/root binding substrate.
 *
 * Replaces only chk_meta_recovery_archive_coverage_bound_section so the nine
 * non-derived data sections plus manifest_root are legal targets, and adds a
 * kind-to-binding CHECK. coverage_index remains forbidden. This migration does
 * not register a flag, add a production caller, change manifest format, or
 * authorize prune.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$
    DECLARE
      source_mismatch_count integer;
      owned_object_count integer;
      incompatible_present boolean := false;
    BEGIN
      WITH expected(relation_name, column_name, type_name, is_not_null) AS (
        VALUES
          ('meta_recovery_archive_coverage_items', 'source_kind', 'text', true),
          ('meta_recovery_archive_coverage_items', 'bound_section', 'text', true)
      )
      SELECT count(*)::integer
        INTO source_mismatch_count
        FROM expected
        LEFT JOIN pg_catalog.pg_class relation
          ON relation.oid = pg_catalog.to_regclass('public.' || expected.relation_name)
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

      SELECT count(*)::integer
        INTO owned_object_count
        FROM pg_catalog.pg_constraint constraint_row
        JOIN pg_catalog.pg_class relation ON relation.oid = constraint_row.conrelid
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = 'public'
         AND relation.relname = 'meta_recovery_archive_coverage_items'
         AND constraint_row.conname = 'chk_meta_recovery_archive_coverage_kind_binding';

      IF owned_object_count <> 0 THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_coverage_binding_object_conflict';
      END IF;

      source_mismatch_count := source_mismatch_count + (
        SELECT CASE WHEN count(*) = 1 THEN 0 ELSE 1 END
          FROM pg_catalog.pg_constraint constraint_row
          JOIN pg_catalog.pg_class relation ON relation.oid = constraint_row.conrelid
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = 'public'
           AND relation.relname = 'meta_recovery_archive_coverage_items'
           AND constraint_row.conname = 'chk_meta_recovery_archive_coverage_source_kind'
           AND constraint_row.contype = 'c'
           AND constraint_row.convalidated
           AND pg_catalog.pg_get_constraintdef(constraint_row.oid, true)
             = $source_kind$CHECK (source_kind = ANY (ARRAY['record_revision'::text, 'marker'::text, 'section_revision'::text, 'config_revision'::text, 'field_tombstone'::text, 'link_tombstone'::text, 'checkpoint_baseline'::text, 'sealed_operation_endpoint'::text, 'snapshot_membership'::text, 'aggregate_membership'::text]))$source_kind$
      );

      source_mismatch_count := source_mismatch_count + (
        SELECT CASE WHEN count(*) = 1 THEN 0 ELSE 1 END
          FROM pg_catalog.pg_constraint constraint_row
          JOIN pg_catalog.pg_class relation ON relation.oid = constraint_row.conrelid
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = 'public'
           AND relation.relname = 'meta_recovery_archive_coverage_items'
           AND constraint_row.conname = 'chk_meta_recovery_archive_coverage_bound_section'
           AND constraint_row.contype = 'c'
           AND constraint_row.convalidated
           AND pg_catalog.pg_get_constraintdef(constraint_row.oid, true)
             = $old$CHECK (bound_section = ANY (ARRAY['schema'::text, 'records'::text, 'links'::text, 'field_value_tombstones'::text, 'link_tombstones'::text, 'auto_number'::text, 'attachments_index'::text, 'permission_evidence'::text, 'views_config'::text]))$old$
      );

      IF source_mismatch_count <> 0 THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_coverage_binding_source_schema_mismatch';
      END IF;

      SELECT EXISTS (
        SELECT 1
          FROM public.meta_recovery_archive_coverage_items coverage
         WHERE NOT (
           (
             coverage.source_kind IN ('record_revision', 'marker', 'checkpoint_baseline')
             AND coverage.bound_section = 'records'
           ) OR (
             coverage.source_kind = 'field_tombstone'
             AND coverage.bound_section = 'field_value_tombstones'
           ) OR (
             coverage.source_kind = 'link_tombstone'
             AND coverage.bound_section = 'link_tombstones'
          ) OR (
            coverage.source_kind IN ('sealed_operation_endpoint', 'aggregate_membership')
            AND coverage.bound_section = 'manifest_root'
           ) OR (
             coverage.source_kind = 'config_revision'
             AND coverage.bound_section IN ('schema', 'views_config')
           ) OR (
             coverage.source_kind IN ('section_revision', 'snapshot_membership')
             AND coverage.bound_section IN (
               'schema',
               'records',
               'links',
               'field_value_tombstones',
               'link_tombstones',
               'auto_number',
               'attachments_index',
               'permission_evidence',
               'views_config'
             )
           )
         )
         LIMIT 1
      ) INTO incompatible_present;

      IF incompatible_present THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_coverage_binding_incompatible';
      END IF;

      ALTER TABLE public.meta_recovery_archive_coverage_items
        DROP CONSTRAINT chk_meta_recovery_archive_coverage_bound_section,
        ADD CONSTRAINT chk_meta_recovery_archive_coverage_bound_section CHECK (
          bound_section IN (
            'schema',
            'records',
            'links',
            'field_value_tombstones',
            'link_tombstones',
            'auto_number',
            'attachments_index',
            'permission_evidence',
            'views_config',
            'manifest_root'
          )
        ),
        ADD CONSTRAINT chk_meta_recovery_archive_coverage_kind_binding CHECK (
          (
            source_kind IN ('record_revision', 'marker', 'checkpoint_baseline')
            AND bound_section = 'records'
          ) OR (
            source_kind = 'field_tombstone'
            AND bound_section = 'field_value_tombstones'
          ) OR (
            source_kind = 'link_tombstone'
            AND bound_section = 'link_tombstones'
          ) OR (
            source_kind IN ('sealed_operation_endpoint', 'aggregate_membership')
            AND bound_section = 'manifest_root'
          ) OR (
            source_kind = 'config_revision'
            AND bound_section IN ('schema', 'views_config')
          ) OR (
            source_kind IN ('section_revision', 'snapshot_membership')
            AND bound_section IN (
              'schema',
              'records',
              'links',
              'field_value_tombstones',
              'link_tombstones',
              'auto_number',
              'attachments_index',
              'permission_evidence',
              'views_config'
            )
          )
        );
    END $$;
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$
    DECLARE
      bound_ok integer;
      kind_ok integer;
      source_kind_ok integer;
      incompatible_present boolean := false;
    BEGIN
      IF pg_catalog.to_regclass('public.meta_recovery_archive_coverage_items') IS NULL THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_coverage_binding_source_schema_mismatch';
      END IF;

      SELECT count(*)::integer
        INTO bound_ok
        FROM pg_catalog.pg_constraint constraint_row
        JOIN pg_catalog.pg_class relation ON relation.oid = constraint_row.conrelid
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = 'public'
         AND relation.relname = 'meta_recovery_archive_coverage_items'
         AND constraint_row.conname = 'chk_meta_recovery_archive_coverage_bound_section'
         AND constraint_row.contype = 'c'
         AND constraint_row.convalidated
         AND pg_catalog.pg_get_constraintdef(constraint_row.oid, true)
           = $new_bound$CHECK (bound_section = ANY (ARRAY['schema'::text, 'records'::text, 'links'::text, 'field_value_tombstones'::text, 'link_tombstones'::text, 'auto_number'::text, 'attachments_index'::text, 'permission_evidence'::text, 'views_config'::text, 'manifest_root'::text]))$new_bound$;

      SELECT count(*)::integer
        INTO kind_ok
        FROM pg_catalog.pg_constraint constraint_row
        JOIN pg_catalog.pg_class relation ON relation.oid = constraint_row.conrelid
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = 'public'
         AND relation.relname = 'meta_recovery_archive_coverage_items'
         AND constraint_row.conname = 'chk_meta_recovery_archive_coverage_kind_binding'
         AND constraint_row.contype = 'c'
         AND constraint_row.convalidated
         AND pg_catalog.pg_get_constraintdef(constraint_row.oid, true)
           = $new_kind$CHECK ((source_kind = ANY (ARRAY['record_revision'::text, 'marker'::text, 'checkpoint_baseline'::text])) AND bound_section = 'records'::text OR source_kind = 'field_tombstone'::text AND bound_section = 'field_value_tombstones'::text OR source_kind = 'link_tombstone'::text AND bound_section = 'link_tombstones'::text OR (source_kind = ANY (ARRAY['sealed_operation_endpoint'::text, 'aggregate_membership'::text])) AND bound_section = 'manifest_root'::text OR source_kind = 'config_revision'::text AND (bound_section = ANY (ARRAY['schema'::text, 'views_config'::text])) OR (source_kind = ANY (ARRAY['section_revision'::text, 'snapshot_membership'::text])) AND (bound_section = ANY (ARRAY['schema'::text, 'records'::text, 'links'::text, 'field_value_tombstones'::text, 'link_tombstones'::text, 'auto_number'::text, 'attachments_index'::text, 'permission_evidence'::text, 'views_config'::text])))$new_kind$;

      SELECT count(*)::integer
        INTO source_kind_ok
        FROM pg_catalog.pg_constraint constraint_row
        JOIN pg_catalog.pg_class relation ON relation.oid = constraint_row.conrelid
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = 'public'
         AND relation.relname = 'meta_recovery_archive_coverage_items'
         AND constraint_row.conname = 'chk_meta_recovery_archive_coverage_source_kind'
         AND constraint_row.contype = 'c'
         AND constraint_row.convalidated
         AND pg_catalog.pg_get_constraintdef(constraint_row.oid, true)
           = $source_kind$CHECK (source_kind = ANY (ARRAY['record_revision'::text, 'marker'::text, 'section_revision'::text, 'config_revision'::text, 'field_tombstone'::text, 'link_tombstone'::text, 'checkpoint_baseline'::text, 'sealed_operation_endpoint'::text, 'snapshot_membership'::text, 'aggregate_membership'::text]))$source_kind$;

      IF bound_ok <> 1 OR kind_ok <> 1 OR source_kind_ok <> 1 THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_coverage_binding_source_schema_mismatch';
      END IF;

      SELECT EXISTS (
        SELECT 1
          FROM public.meta_recovery_archive_coverage_items coverage
         WHERE coverage.bound_section NOT IN (
           'schema',
           'records',
           'links',
           'field_value_tombstones',
           'link_tombstones',
           'auto_number',
           'attachments_index',
           'permission_evidence',
           'views_config'
         )
         LIMIT 1
      ) INTO incompatible_present;

      IF incompatible_present THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_coverage_binding_incompatible';
      END IF;

      ALTER TABLE public.meta_recovery_archive_coverage_items
        DROP CONSTRAINT chk_meta_recovery_archive_coverage_kind_binding,
        DROP CONSTRAINT chk_meta_recovery_archive_coverage_bound_section,
        ADD CONSTRAINT chk_meta_recovery_archive_coverage_bound_section CHECK (
          bound_section IN (
            'schema',
            'records',
            'links',
            'field_value_tombstones',
            'link_tombstones',
            'auto_number',
            'attachments_index',
            'permission_evidence',
            'views_config'
          )
        );
    END $$;
  `.execute(db)
}
