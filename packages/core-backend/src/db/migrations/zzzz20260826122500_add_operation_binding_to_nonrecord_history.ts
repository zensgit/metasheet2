import { sql, type Kysely } from 'kysely'

/**
 * Phase D2d1: nullable operation binding on non-record history evidence.
 *
 * Adds `operation_id` to config revisions and both tombstone tables, indexes
 * `(sheet_id, operation_id)`, DEFERRABLE INITIALLY DEFERRED composite FKs to
 * the sealed-operation ledger, attaches the existing append-after-seal
 * function to the three evidence tables, and installs a scoped row guard:
 * operation_id rebind/backfill is forbidden, tagged rows cannot change
 * sheet_id, unrelated updates remain legal, and tagged DELETE is refused
 * unless `metasheet.mrho_retention='on'`. Ordinary NULL rows remain
 * deletable without the GUC. This migration does not register a flag, add a
 * production writer, replace legacy prune, or authorize covered
 * whole-operation prune (D2d2).
 *
 * Deployment note: the column/constraint/trigger DDL and non-concurrent
 * indexes take locks on three existing history tables. Run this migration
 * before any Phase-D writer is enabled and budget a migration window; there
 * is intentionally no backfill.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$
    DECLARE
      source_mismatch_count integer;
      owned_object_count integer;
    BEGIN
      WITH expected(relation_name, column_name, type_name, is_not_null) AS (
        VALUES
          ('meta_record_history_operations', 'sheet_id', 'text', true),
          ('meta_record_history_operations', 'operation_id', 'uuid', true),
          ('meta_config_revisions', 'sheet_id', 'text', true),
          ('meta_config_revisions', 'id', 'uuid', true),
          ('meta_field_value_tombstones', 'sheet_id', 'text', true),
          ('meta_field_value_tombstones', 'id', 'uuid', true),
          ('meta_link_tombstones', 'sheet_id', 'text', true),
          ('meta_link_tombstones', 'id', 'uuid', true)
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

      source_mismatch_count := source_mismatch_count + (
        SELECT CASE WHEN count(*) = 1 THEN 0 ELSE 1 END
          FROM pg_catalog.pg_constraint constraint_row
          JOIN pg_catalog.pg_class relation ON relation.oid = constraint_row.conrelid
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = 'public'
           AND relation.relname = 'meta_record_history_operations'
           AND constraint_row.conname = 'pk_meta_record_history_operations'
           AND constraint_row.contype = 'p'
           AND pg_catalog.pg_get_constraintdef(constraint_row.oid, true)
             = 'PRIMARY KEY (sheet_id, operation_id)'
      );

      source_mismatch_count := source_mismatch_count + (
        SELECT CASE WHEN count(*) = 1 THEN 0 ELSE 1 END
          FROM pg_catalog.pg_proc procedure_row
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure_row.pronamespace
         WHERE namespace.nspname = 'public'
           AND procedure_row.proname = 'meta_record_reject_append_to_sealed_operation'
           AND pg_catalog.pg_get_function_identity_arguments(procedure_row.oid) = ''
           AND procedure_row.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
           AND procedure_row.proconfig IS NULL
           AND pg_catalog.md5(procedure_row.prosrc) = 'e1f23770a617dec540e712295c4b20b4'
      );

      source_mismatch_count := source_mismatch_count + (
        SELECT CASE WHEN count(*) = 2 THEN 0 ELSE 1 END
          FROM (
            VALUES
              ('meta_record_revisions', 'trg_mrr_reject_append_sealed'),
              ('meta_record_version_markers', 'trg_mrvm_reject_append_sealed')
          ) expected_trigger(relation_name, trigger_name)
          JOIN pg_catalog.pg_class relation
            ON relation.oid = pg_catalog.to_regclass('public.' || expected_trigger.relation_name)
           AND relation.relkind = 'r'
          JOIN pg_catalog.pg_namespace namespace
            ON namespace.oid = relation.relnamespace
           AND namespace.nspname = 'public'
          JOIN pg_catalog.pg_trigger trigger_row
            ON trigger_row.tgrelid = relation.oid
           AND trigger_row.tgname = expected_trigger.trigger_name
           AND NOT trigger_row.tgisinternal
          JOIN pg_catalog.pg_proc procedure_row
            ON procedure_row.oid = trigger_row.tgfoid
           AND procedure_row.proname = 'meta_record_reject_append_to_sealed_operation'
      );

      IF source_mismatch_count <> 0 THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'operation_binding_source_schema_mismatch';
      END IF;

      SELECT count(*)::integer
        INTO owned_object_count
        FROM (
          VALUES
            ('meta_config_revisions', 'operation_id'),
            ('meta_field_value_tombstones', 'operation_id'),
            ('meta_link_tombstones', 'operation_id')
        ) expected_column(relation_name, column_name)
        JOIN pg_catalog.pg_class relation
          ON relation.oid = pg_catalog.to_regclass('public.' || expected_column.relation_name)
         AND relation.relkind = 'r'
        JOIN pg_catalog.pg_namespace namespace
          ON namespace.oid = relation.relnamespace
         AND namespace.nspname = 'public'
        JOIN pg_catalog.pg_attribute attribute
          ON attribute.attrelid = relation.oid
         AND attribute.attname = expected_column.column_name
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped;

      owned_object_count := owned_object_count + (
        SELECT count(*)::integer
          FROM (
            VALUES
              ('meta_config_revisions', 'idx_meta_config_revisions_operation'),
              ('meta_field_value_tombstones', 'idx_meta_field_value_tombstones_operation'),
              ('meta_link_tombstones', 'idx_meta_link_tombstones_operation')
          ) expected_index(relation_name, index_name)
          JOIN pg_catalog.pg_class relation
            ON relation.oid = pg_catalog.to_regclass('public.' || expected_index.relation_name)
           AND relation.relkind = 'r'
          JOIN pg_catalog.pg_namespace namespace
            ON namespace.oid = relation.relnamespace
           AND namespace.nspname = 'public'
          JOIN pg_catalog.pg_index index_row
            ON index_row.indrelid = relation.oid
          JOIN pg_catalog.pg_class index_relation
            ON index_relation.oid = index_row.indexrelid
           AND index_relation.relname = expected_index.index_name
      );

      owned_object_count := owned_object_count + (
        SELECT count(*)::integer
          FROM (
            VALUES
              ('meta_config_revisions', 'fk_mcr_operation'),
              ('meta_field_value_tombstones', 'fk_mfvt_operation'),
              ('meta_link_tombstones', 'fk_mlt_operation')
          ) expected_fk(relation_name, constraint_name)
          JOIN pg_catalog.pg_class relation
            ON relation.oid = pg_catalog.to_regclass('public.' || expected_fk.relation_name)
           AND relation.relkind = 'r'
          JOIN pg_catalog.pg_namespace namespace
            ON namespace.oid = relation.relnamespace
           AND namespace.nspname = 'public'
          JOIN pg_catalog.pg_constraint constraint_row
            ON constraint_row.conrelid = relation.oid
           AND constraint_row.conname = expected_fk.constraint_name
      );

      owned_object_count := owned_object_count + (
        SELECT count(*)::integer
          FROM pg_catalog.pg_proc procedure_row
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure_row.pronamespace
         WHERE namespace.nspname = 'public'
           AND procedure_row.proname = 'meta_nonrecord_history_operation_binding_guard_row'
           AND pg_catalog.pg_get_function_identity_arguments(procedure_row.oid) = ''
           AND procedure_row.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
      );

      owned_object_count := owned_object_count + (
        SELECT count(*)::integer
          FROM (
            VALUES
              ('meta_config_revisions', 'trg_mcr_operation_binding_immutable'),
              ('meta_field_value_tombstones', 'trg_mfvt_operation_binding_immutable'),
              ('meta_link_tombstones', 'trg_mlt_operation_binding_immutable'),
              ('meta_config_revisions', 'trg_mcr_reject_append_sealed'),
              ('meta_field_value_tombstones', 'trg_mfvt_reject_append_sealed'),
              ('meta_link_tombstones', 'trg_mlt_reject_append_sealed')
          ) expected_trigger(relation_name, trigger_name)
          JOIN pg_catalog.pg_class relation
            ON relation.oid = pg_catalog.to_regclass('public.' || expected_trigger.relation_name)
           AND relation.relkind = 'r'
          JOIN pg_catalog.pg_namespace namespace
            ON namespace.oid = relation.relnamespace
           AND namespace.nspname = 'public'
          JOIN pg_catalog.pg_trigger trigger_row
            ON trigger_row.tgrelid = relation.oid
           AND trigger_row.tgname = expected_trigger.trigger_name
           AND NOT trigger_row.tgisinternal
      );

      IF owned_object_count <> 0 THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'operation_binding_object_conflict';
      END IF;
    END $$;
  `.execute(db)

  // The inherited trigger body uses an unqualified ledger table and renders
  // row identifiers in its exception. Pin its lookup and make the refusal
  // values-free before attaching it to three additional evidence tables.
  await sql`
    CREATE OR REPLACE FUNCTION public.meta_record_reject_append_to_sealed_operation()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $fn$
    BEGIN
      IF NEW.operation_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM meta_record_history_operations operation_row
        WHERE operation_row.sheet_id = NEW.sheet_id
          AND operation_row.operation_id = NEW.operation_id
      ) THEN
        RAISE EXCEPTION USING
          ERRCODE = 'check_violation',
          MESSAGE = 'cannot append event to sealed operation';
      END IF;
      RETURN NEW;
    END;
    $fn$
  `.execute(db)

  await sql`
    ALTER TABLE public.meta_config_revisions
      ADD COLUMN operation_id uuid
  `.execute(db)
  await sql`
    ALTER TABLE public.meta_field_value_tombstones
      ADD COLUMN operation_id uuid
  `.execute(db)
  await sql`
    ALTER TABLE public.meta_link_tombstones
      ADD COLUMN operation_id uuid
  `.execute(db)

  await sql`
    CREATE INDEX idx_meta_config_revisions_operation
      ON public.meta_config_revisions (sheet_id, operation_id)
  `.execute(db)
  await sql`
    CREATE INDEX idx_meta_field_value_tombstones_operation
      ON public.meta_field_value_tombstones (sheet_id, operation_id)
  `.execute(db)
  await sql`
    CREATE INDEX idx_meta_link_tombstones_operation
      ON public.meta_link_tombstones (sheet_id, operation_id)
  `.execute(db)

  await sql`
    ALTER TABLE public.meta_config_revisions
      ADD CONSTRAINT fk_mcr_operation
      FOREIGN KEY (sheet_id, operation_id)
      REFERENCES public.meta_record_history_operations (sheet_id, operation_id)
      DEFERRABLE INITIALLY DEFERRED
  `.execute(db)
  await sql`
    ALTER TABLE public.meta_field_value_tombstones
      ADD CONSTRAINT fk_mfvt_operation
      FOREIGN KEY (sheet_id, operation_id)
      REFERENCES public.meta_record_history_operations (sheet_id, operation_id)
      DEFERRABLE INITIALLY DEFERRED
  `.execute(db)
  await sql`
    ALTER TABLE public.meta_link_tombstones
      ADD CONSTRAINT fk_mlt_operation
      FOREIGN KEY (sheet_id, operation_id)
      REFERENCES public.meta_record_history_operations (sheet_id, operation_id)
      DEFERRABLE INITIALLY DEFERRED
  `.execute(db)

  await sql`
    CREATE FUNCTION public.meta_nonrecord_history_operation_binding_guard_row()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $fn$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        IF OLD.operation_id IS NOT NULL
           AND current_setting('metasheet.mrho_retention', true) IS DISTINCT FROM 'on' THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'operation_binding_tagged_delete_forbidden';
        END IF;
        RETURN OLD;
      END IF;
      IF NEW.operation_id IS DISTINCT FROM OLD.operation_id THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'operation_binding_immutable';
      END IF;
      IF OLD.operation_id IS NOT NULL
         AND NEW.sheet_id IS DISTINCT FROM OLD.sheet_id THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'operation_binding_immutable';
      END IF;
      RETURN NEW;
    END;
    $fn$
  `.execute(db)

  await sql`
    CREATE TRIGGER trg_mcr_operation_binding_immutable
    BEFORE UPDATE OR DELETE ON public.meta_config_revisions
    FOR EACH ROW
    EXECUTE FUNCTION public.meta_nonrecord_history_operation_binding_guard_row()
  `.execute(db)
  await sql`
    CREATE TRIGGER trg_mfvt_operation_binding_immutable
    BEFORE UPDATE OR DELETE ON public.meta_field_value_tombstones
    FOR EACH ROW
    EXECUTE FUNCTION public.meta_nonrecord_history_operation_binding_guard_row()
  `.execute(db)
  await sql`
    CREATE TRIGGER trg_mlt_operation_binding_immutable
    BEFORE UPDATE OR DELETE ON public.meta_link_tombstones
    FOR EACH ROW
    EXECUTE FUNCTION public.meta_nonrecord_history_operation_binding_guard_row()
  `.execute(db)

  await sql`
    CREATE TRIGGER trg_mcr_reject_append_sealed
    BEFORE INSERT ON public.meta_config_revisions
    FOR EACH ROW
    EXECUTE FUNCTION public.meta_record_reject_append_to_sealed_operation()
  `.execute(db)
  await sql`
    CREATE TRIGGER trg_mfvt_reject_append_sealed
    BEFORE INSERT ON public.meta_field_value_tombstones
    FOR EACH ROW
    EXECUTE FUNCTION public.meta_record_reject_append_to_sealed_operation()
  `.execute(db)
  await sql`
    CREATE TRIGGER trg_mlt_reject_append_sealed
    BEFORE INSERT ON public.meta_link_tombstones
    FOR EACH ROW
    EXECUTE FUNCTION public.meta_record_reject_append_to_sealed_operation()
  `.execute(db)

  await sql`
    DO $$
    DECLARE
      shape_mismatch_count integer;
    BEGIN
      SELECT count(*)::integer
        INTO shape_mismatch_count
        FROM (
          VALUES
            ('meta_config_revisions', 'fk_mcr_operation'),
            ('meta_field_value_tombstones', 'fk_mfvt_operation'),
            ('meta_link_tombstones', 'fk_mlt_operation')
        ) expected_fk(relation_name, constraint_name)
        LEFT JOIN pg_catalog.pg_class relation
          ON relation.oid = pg_catalog.to_regclass('public.' || expected_fk.relation_name)
         AND relation.relkind = 'r'
        LEFT JOIN pg_catalog.pg_namespace namespace
          ON namespace.oid = relation.relnamespace
         AND namespace.nspname = 'public'
        LEFT JOIN pg_catalog.pg_constraint constraint_row
          ON constraint_row.conrelid = relation.oid
         AND constraint_row.conname = expected_fk.constraint_name
         AND constraint_row.contype = 'f'
       WHERE constraint_row.oid IS NULL
          OR constraint_row.condeferrable IS DISTINCT FROM true
          OR constraint_row.condeferred IS DISTINCT FROM true
          OR constraint_row.confrelid
             IS DISTINCT FROM pg_catalog.to_regclass('public.meta_record_history_operations')
          OR pg_catalog.pg_get_constraintdef(constraint_row.oid, true)
             IS DISTINCT FROM
               'FOREIGN KEY (sheet_id, operation_id) REFERENCES meta_record_history_operations(sheet_id, operation_id) DEFERRABLE INITIALLY DEFERRED';

      shape_mismatch_count := shape_mismatch_count + (
        SELECT CASE WHEN count(*) = 1 THEN 0 ELSE 1 END
          FROM pg_catalog.pg_proc procedure_row
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure_row.pronamespace
         WHERE namespace.nspname = 'public'
           AND procedure_row.proname = 'meta_record_reject_append_to_sealed_operation'
           AND pg_catalog.pg_get_function_identity_arguments(procedure_row.oid) = ''
           AND procedure_row.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
           AND procedure_row.proconfig = ARRAY['search_path=pg_catalog, public']::text[]
           AND pg_catalog.md5(procedure_row.prosrc) = 'a2887e7aaa24f726e44ff3562f921feb'
      );

      shape_mismatch_count := shape_mismatch_count + (
        SELECT count(*)::integer
          FROM (
            VALUES
              ('meta_config_revisions', 'idx_meta_config_revisions_operation'),
              ('meta_field_value_tombstones', 'idx_meta_field_value_tombstones_operation'),
              ('meta_link_tombstones', 'idx_meta_link_tombstones_operation')
          ) expected_index(relation_name, index_name)
          LEFT JOIN pg_catalog.pg_class relation
            ON relation.oid = pg_catalog.to_regclass('public.' || expected_index.relation_name)
           AND relation.relkind = 'r'
          LEFT JOIN pg_catalog.pg_class index_relation
            ON index_relation.oid = pg_catalog.to_regclass('public.' || expected_index.index_name)
           AND index_relation.relkind = 'i'
          LEFT JOIN pg_catalog.pg_index index_row
            ON index_row.indexrelid = index_relation.oid
           AND index_row.indrelid = relation.oid
         WHERE index_row.indexrelid IS NULL
            OR index_row.indisunique
            OR index_row.indpred IS NOT NULL
            OR (
              SELECT array_agg(attribute.attname ORDER BY ordinality)
                FROM pg_catalog.unnest(index_row.indkey) WITH ORDINALITY AS keys(attnum, ordinality)
                JOIN pg_catalog.pg_attribute attribute
                  ON attribute.attrelid = index_row.indrelid
                 AND attribute.attnum = keys.attnum
            ) IS DISTINCT FROM ARRAY['sheet_id', 'operation_id']::name[]
      );

      shape_mismatch_count := shape_mismatch_count + (
        SELECT count(*)::integer
          FROM (
            VALUES
              ('meta_config_revisions', 'trg_mcr_operation_binding_immutable',
               'meta_nonrecord_history_operation_binding_guard_row', 'BEFORE DELETE OR UPDATE'),
              ('meta_field_value_tombstones', 'trg_mfvt_operation_binding_immutable',
               'meta_nonrecord_history_operation_binding_guard_row', 'BEFORE DELETE OR UPDATE'),
              ('meta_link_tombstones', 'trg_mlt_operation_binding_immutable',
               'meta_nonrecord_history_operation_binding_guard_row', 'BEFORE DELETE OR UPDATE'),
              ('meta_config_revisions', 'trg_mcr_reject_append_sealed',
               'meta_record_reject_append_to_sealed_operation', 'BEFORE INSERT'),
              ('meta_field_value_tombstones', 'trg_mfvt_reject_append_sealed',
               'meta_record_reject_append_to_sealed_operation', 'BEFORE INSERT'),
              ('meta_link_tombstones', 'trg_mlt_reject_append_sealed',
               'meta_record_reject_append_to_sealed_operation', 'BEFORE INSERT')
          ) expected_trigger(relation_name, trigger_name, function_name, timing)
          LEFT JOIN pg_catalog.pg_class relation
            ON relation.oid = pg_catalog.to_regclass('public.' || expected_trigger.relation_name)
           AND relation.relkind = 'r'
          LEFT JOIN pg_catalog.pg_trigger trigger_row
            ON trigger_row.tgrelid = relation.oid
           AND trigger_row.tgname = expected_trigger.trigger_name
           AND NOT trigger_row.tgisinternal
          LEFT JOIN pg_catalog.pg_proc procedure_row
            ON procedure_row.oid = trigger_row.tgfoid
         WHERE trigger_row.oid IS NULL
            OR procedure_row.proname IS DISTINCT FROM expected_trigger.function_name
            OR pg_catalog.pg_get_triggerdef(trigger_row.oid, true)
               NOT LIKE '%' || expected_trigger.timing || '%'
      );

      IF shape_mismatch_count <> 0 THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'operation_binding_fk_shape_mismatch';
      END IF;
    END $$;
  `.execute(db)

}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$
    DECLARE
      binding_nonempty boolean := false;
    BEGIN
      IF pg_catalog.to_regclass('public.meta_config_revisions') IS NOT NULL
         AND EXISTS (
           SELECT 1
             FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'meta_config_revisions'
              AND column_name = 'operation_id'
         ) THEN
        SELECT EXISTS (
          SELECT 1 FROM public.meta_config_revisions WHERE operation_id IS NOT NULL LIMIT 1
        ) INTO binding_nonempty;
      END IF;

      IF NOT binding_nonempty
         AND pg_catalog.to_regclass('public.meta_field_value_tombstones') IS NOT NULL
         AND EXISTS (
           SELECT 1
             FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'meta_field_value_tombstones'
              AND column_name = 'operation_id'
         ) THEN
        SELECT EXISTS (
          SELECT 1 FROM public.meta_field_value_tombstones WHERE operation_id IS NOT NULL LIMIT 1
        ) INTO binding_nonempty;
      END IF;

      IF NOT binding_nonempty
         AND pg_catalog.to_regclass('public.meta_link_tombstones') IS NOT NULL
         AND EXISTS (
           SELECT 1
             FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'meta_link_tombstones'
              AND column_name = 'operation_id'
         ) THEN
        SELECT EXISTS (
          SELECT 1 FROM public.meta_link_tombstones WHERE operation_id IS NOT NULL LIMIT 1
        ) INTO binding_nonempty;
      END IF;

      IF binding_nonempty THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'operation_binding_nonempty';
      END IF;
    END $$;
  `.execute(db)

  await sql`
    DO $$
    BEGIN
      IF pg_catalog.to_regclass('public.meta_config_revisions') IS NOT NULL THEN
        DROP TRIGGER IF EXISTS trg_mcr_reject_append_sealed ON public.meta_config_revisions;
        DROP TRIGGER IF EXISTS trg_mcr_operation_binding_immutable ON public.meta_config_revisions;
      END IF;
      IF pg_catalog.to_regclass('public.meta_field_value_tombstones') IS NOT NULL THEN
        DROP TRIGGER IF EXISTS trg_mfvt_reject_append_sealed ON public.meta_field_value_tombstones;
        DROP TRIGGER IF EXISTS trg_mfvt_operation_binding_immutable ON public.meta_field_value_tombstones;
      END IF;
      IF pg_catalog.to_regclass('public.meta_link_tombstones') IS NOT NULL THEN
        DROP TRIGGER IF EXISTS trg_mlt_reject_append_sealed ON public.meta_link_tombstones;
        DROP TRIGGER IF EXISTS trg_mlt_operation_binding_immutable ON public.meta_link_tombstones;
      END IF;
    END $$;
  `.execute(db)

  await sql`DROP FUNCTION IF EXISTS public.meta_nonrecord_history_operation_binding_guard_row()`.execute(db)

  await sql`
    DO $$
    BEGIN
      IF pg_catalog.to_regclass('public.meta_config_revisions') IS NOT NULL THEN
        ALTER TABLE public.meta_config_revisions DROP CONSTRAINT IF EXISTS fk_mcr_operation;
      END IF;
      IF pg_catalog.to_regclass('public.meta_field_value_tombstones') IS NOT NULL THEN
        ALTER TABLE public.meta_field_value_tombstones DROP CONSTRAINT IF EXISTS fk_mfvt_operation;
      END IF;
      IF pg_catalog.to_regclass('public.meta_link_tombstones') IS NOT NULL THEN
        ALTER TABLE public.meta_link_tombstones DROP CONSTRAINT IF EXISTS fk_mlt_operation;
      END IF;
    END $$;
  `.execute(db)

  await sql`DROP INDEX IF EXISTS public.idx_meta_config_revisions_operation`.execute(db)
  await sql`DROP INDEX IF EXISTS public.idx_meta_field_value_tombstones_operation`.execute(db)
  await sql`DROP INDEX IF EXISTS public.idx_meta_link_tombstones_operation`.execute(db)

  await sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'meta_config_revisions'
           AND column_name = 'operation_id'
      ) THEN
        ALTER TABLE public.meta_config_revisions DROP COLUMN operation_id;
      END IF;
      IF EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'meta_field_value_tombstones'
           AND column_name = 'operation_id'
      ) THEN
        ALTER TABLE public.meta_field_value_tombstones DROP COLUMN operation_id;
      END IF;
      IF EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'meta_link_tombstones'
           AND column_name = 'operation_id'
      ) THEN
        ALTER TABLE public.meta_link_tombstones DROP COLUMN operation_id;
      END IF;
    END $$;
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION public.meta_record_reject_append_to_sealed_operation()
    RETURNS trigger AS $fn$
    BEGIN
      IF NEW.operation_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM meta_record_history_operations o
        WHERE o.sheet_id = NEW.sheet_id AND o.operation_id = NEW.operation_id
      ) THEN
        RAISE EXCEPTION 'cannot append event to sealed operation % on sheet %', NEW.operation_id, NEW.sheet_id
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql
  `.execute(db)

  await sql`
    ALTER FUNCTION public.meta_record_reject_append_to_sealed_operation()
      RESET search_path
  `.execute(db)
}
