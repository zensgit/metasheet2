import { sql, type Kysely } from 'kysely'

/**
 * Phase D2c: inert section-causality substrate.
 *
 * Adds seq-bearing section revisions, versions the sealed-operation ledger, and
 * introduces dedicated zero-direct-event membership tables. This migration does
 * not register a flag, add a runtime writer, or authorize archive capture,
 * prune handoff, restore, or object deletion.
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
          ('meta_record_history_operations', 'endpoint_seq', 'bigint', true),
          ('meta_record_history_operations', 'event_count', 'integer', true),
          ('meta_record_revisions', 'sheet_id', 'text', true),
          ('meta_record_revisions', 'operation_id', 'uuid', false),
          ('meta_record_revisions', 'seq', 'bigint', true),
          ('meta_record_version_markers', 'sheet_id', 'text', true),
          ('meta_record_version_markers', 'operation_id', 'uuid', false),
          ('meta_record_version_markers', 'seq', 'bigint', true)
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
          FROM pg_catalog.pg_class relation
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = 'public'
           AND relation.relname = 'meta_record_chain_seq'
           AND relation.relkind = 'S'
      );

      source_mismatch_count := source_mismatch_count + (
        SELECT CASE WHEN count(*) = 1 THEN 0 ELSE 1 END
          FROM pg_catalog.pg_constraint constraint_row
          JOIN pg_catalog.pg_class relation ON relation.oid = constraint_row.conrelid
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = 'public'
           AND relation.relname = 'meta_record_history_operations'
           AND constraint_row.conname = 'chk_mrho_event_count_positive'
           AND pg_catalog.pg_get_constraintdef(constraint_row.oid, true) = 'CHECK (event_count >= 1)'
      );

      source_mismatch_count := source_mismatch_count + (
        SELECT CASE WHEN count(*) = 1 THEN 0 ELSE 1 END
          FROM pg_catalog.pg_proc procedure_row
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure_row.pronamespace
         WHERE namespace.nspname = 'public'
           AND procedure_row.proname = 'meta_record_history_operations_validate_endpoint'
           AND pg_catalog.pg_get_function_identity_arguments(procedure_row.oid) = ''
           AND procedure_row.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
           AND pg_catalog.md5(procedure_row.prosrc) = '358f7ecffad2b3a6e7270448e1a1ff4f'
      );

      source_mismatch_count := source_mismatch_count + (
        SELECT CASE WHEN count(*) = 1 THEN 0 ELSE 1 END
          FROM pg_catalog.pg_proc procedure_row
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure_row.pronamespace
         WHERE namespace.nspname = 'public'
           AND procedure_row.proname = 'meta_record_history_operations_prune'
           AND pg_catalog.pg_get_function_identity_arguments(procedure_row.oid)
             = 'p_sheet_id text, p_operation_id uuid'
           AND pg_catalog.md5(procedure_row.prosrc) = '1fc85d4dfe0533bba039e9b5f3caf326'
      );

      source_mismatch_count := source_mismatch_count + (
        SELECT CASE WHEN count(*) = 1 THEN 0 ELSE 1 END
          FROM pg_catalog.pg_trigger trigger_row
          JOIN pg_catalog.pg_class relation ON relation.oid = trigger_row.tgrelid
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
          JOIN pg_catalog.pg_proc procedure_row ON procedure_row.oid = trigger_row.tgfoid
         WHERE namespace.nspname = 'public'
           AND relation.relname = 'meta_record_history_operations'
           AND trigger_row.tgname = 'trg_mrho_validate_endpoint'
           AND NOT trigger_row.tgisinternal
           AND procedure_row.proname = 'meta_record_history_operations_validate_endpoint'
      );

      IF source_mismatch_count <> 0 THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'section_causality_source_schema_mismatch';
      END IF;

      SELECT count(*)::integer
        INTO owned_object_count
        FROM (
          SELECT pg_catalog.to_regclass(name) AS object_oid
            FROM unnest(ARRAY[
              'public.meta_sheet_section_revisions',
              'public.meta_record_history_snapshot_members',
              'public.meta_record_history_operation_members',
              'public.idx_meta_sheet_section_revisions_operation',
              'public.idx_meta_sheet_section_revisions_sheet_seq',
              'public.idx_meta_record_history_snapshot_members_parent',
              'public.idx_meta_record_history_operation_members_parent'
            ]::text[]) AS names(name)
        ) owned_relations
       WHERE owned_relations.object_oid IS NOT NULL;

      owned_object_count := owned_object_count + (
        SELECT count(*)::integer
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'meta_record_history_operations'
           AND column_name IN ('operation_kind', 'event_contract_version', 'component_count')
      );

      owned_object_count := owned_object_count + (
        SELECT count(*)::integer
          FROM pg_catalog.pg_proc procedure_row
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure_row.pronamespace
         WHERE namespace.nspname = 'public'
           AND procedure_row.proname IN (
             'meta_sheet_section_revisions_guard_row',
             'meta_record_history_membership_guard_row'
           )
      );

      owned_object_count := owned_object_count + (
        SELECT count(*)::integer
          FROM pg_catalog.pg_trigger trigger_row
          JOIN pg_catalog.pg_class relation ON relation.oid = trigger_row.tgrelid
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = 'public'
           AND NOT trigger_row.tgisinternal
           AND trigger_row.tgname IN (
             'trg_mssr_reject_append_sealed',
             'trg_mssr_guard_row',
             'trg_mrhsm_guard_row',
             'trg_mrhom_guard_row'
           )
      );

      IF owned_object_count <> 0 THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'section_causality_object_conflict';
      END IF;
    END $$;
  `.execute(db)

  await sql`
    ALTER TABLE public.meta_record_history_operations
      ADD COLUMN operation_kind text NOT NULL DEFAULT 'ordinary',
      ADD COLUMN event_contract_version integer NOT NULL DEFAULT 1,
      ADD COLUMN component_count integer
  `.execute(db)

  await sql`
    ALTER TABLE public.meta_record_history_operations
      DROP CONSTRAINT chk_mrho_event_count_positive
  `.execute(db)

  await sql`
    ALTER TABLE public.meta_record_history_operations
      ADD CONSTRAINT chk_mrho_operation_kind CHECK (
        operation_kind IN (
          'ordinary',
          'section_bootstrap',
          'archive_snapshot',
          'restore_chunk',
          'restore_aggregate'
        )
      ),
      ADD CONSTRAINT chk_mrho_event_contract_version CHECK (
        event_contract_version IN (1, 2)
      ),
      ADD CONSTRAINT chk_mrho_event_contract CHECK (
        (
          event_contract_version = 1
          AND operation_kind = 'ordinary'
          AND component_count IS NULL
          AND event_count >= 1
        ) OR (
          event_contract_version = 2
          AND operation_kind IN ('ordinary', 'section_bootstrap', 'restore_chunk')
          AND component_count IS NULL
          AND event_count >= 1
        ) OR (
          event_contract_version = 2
          AND operation_kind = 'archive_snapshot'
          AND event_count = 0
          AND component_count = 9
        ) OR (
          event_contract_version = 2
          AND operation_kind = 'restore_aggregate'
          AND event_count >= 1
          AND component_count >= 1
        )
      )
  `.execute(db)

  await sql`
    CREATE TABLE public.meta_sheet_section_revisions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      sheet_id text NOT NULL,
      section_kind text NOT NULL,
      entity_key text NOT NULL,
      action text NOT NULL,
      payload jsonb,
      tombstone jsonb,
      seq bigint NOT NULL DEFAULT nextval('public.meta_record_chain_seq'),
      operation_id uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT chk_mssr_section_kind CHECK (
        section_kind IN (
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
      ),
      CONSTRAINT chk_mssr_action CHECK (
        action IN ('bootstrap_snapshot', 'upsert', 'delete')
      ),
      CONSTRAINT chk_mssr_records_bootstrap CHECK (
        section_kind <> 'records' OR action = 'bootstrap_snapshot'
      ),
      CONSTRAINT chk_mssr_entity_key CHECK (length(btrim(entity_key)) > 0),
      CONSTRAINT chk_mssr_payload_or_tombstone CHECK (
        (
          action = 'bootstrap_snapshot'
          AND payload IS NOT NULL
          AND tombstone IS NULL
          AND entity_key = 'section/' || section_kind
          AND payload ? 'row_count'
          AND payload ? 'source_hash'
          AND jsonb_typeof(payload->'row_count') = 'string'
          AND jsonb_typeof(payload->'source_hash') = 'string'
          AND payload->>'row_count' ~ '^(0|[1-9][0-9]*)$'
          AND payload->>'source_hash' ~ '^[0-9a-f]{64}$'
        ) OR (
          action = 'upsert'
          AND payload IS NOT NULL
          AND tombstone IS NULL
          AND jsonb_typeof(payload) = 'object'
        ) OR (
          action = 'delete'
          AND payload IS NULL
          AND tombstone IS NOT NULL
          AND jsonb_typeof(tombstone) = 'object'
        )
      ),
      CONSTRAINT chk_mssr_seq_positive CHECK (seq >= 1),
      CONSTRAINT uq_mssr_sheet_seq UNIQUE (sheet_id, seq),
      CONSTRAINT fk_mssr_operation
        FOREIGN KEY (sheet_id, operation_id)
        REFERENCES public.meta_record_history_operations (sheet_id, operation_id)
        DEFERRABLE INITIALLY DEFERRED
    )
  `.execute(db)

  await sql`
    CREATE INDEX idx_meta_sheet_section_revisions_operation
      ON public.meta_sheet_section_revisions (sheet_id, operation_id)
  `.execute(db)
  await sql`
    CREATE INDEX idx_meta_sheet_section_revisions_sheet_seq
      ON public.meta_sheet_section_revisions (sheet_id, seq)
  `.execute(db)

  await sql`
    CREATE TABLE public.meta_record_history_snapshot_members (
      sheet_id text NOT NULL,
      parent_operation_id uuid NOT NULL,
      ordinal integer NOT NULL,
      section_kind text NOT NULL,
      source_head_kind text NOT NULL,
      source_operation_id uuid NOT NULL,
      source_head_seq bigint NOT NULL,
      row_count bigint NOT NULL,
      source_hash text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT pk_meta_record_history_snapshot_members
        PRIMARY KEY (sheet_id, parent_operation_id, ordinal),
      CONSTRAINT uq_mrhsm_parent_section
        UNIQUE (sheet_id, parent_operation_id, section_kind),
      CONSTRAINT chk_mrhsm_ordinal_positive CHECK (ordinal >= 1),
      CONSTRAINT chk_mrhsm_section_kind CHECK (
        section_kind IN (
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
      ),
      CONSTRAINT chk_mrhsm_source_head_kind CHECK (
        source_head_kind IN ('section_bootstrap', 'ordinary', 'restore_chunk', 'restore_aggregate')
      ),
      CONSTRAINT chk_mrhsm_source_head_seq CHECK (source_head_seq >= 1),
      CONSTRAINT chk_mrhsm_row_count CHECK (row_count >= 0),
      CONSTRAINT chk_mrhsm_source_hash CHECK (source_hash ~ '^[0-9a-f]{64}$'),
      CONSTRAINT fk_mrhsm_parent
        FOREIGN KEY (sheet_id, parent_operation_id)
        REFERENCES public.meta_record_history_operations (sheet_id, operation_id)
        DEFERRABLE INITIALLY DEFERRED,
      CONSTRAINT fk_mrhsm_source
        FOREIGN KEY (sheet_id, source_operation_id)
        REFERENCES public.meta_record_history_operations (sheet_id, operation_id)
        DEFERRABLE INITIALLY DEFERRED
    )
  `.execute(db)
  await sql`
    CREATE INDEX idx_meta_record_history_snapshot_members_parent
      ON public.meta_record_history_snapshot_members (sheet_id, parent_operation_id)
  `.execute(db)

  await sql`
    CREATE TABLE public.meta_record_history_operation_members (
      sheet_id text NOT NULL,
      parent_operation_id uuid NOT NULL,
      ordinal integer NOT NULL,
      child_operation_id uuid NOT NULL,
      child_endpoint_seq bigint NOT NULL,
      child_event_count integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT pk_meta_record_history_operation_members
        PRIMARY KEY (sheet_id, parent_operation_id, ordinal),
      CONSTRAINT uq_mrhom_parent_child
        UNIQUE (sheet_id, parent_operation_id, child_operation_id),
      CONSTRAINT chk_mrhom_ordinal_positive CHECK (ordinal >= 1),
      CONSTRAINT chk_mrhom_child_endpoint_seq CHECK (child_endpoint_seq >= 1),
      CONSTRAINT chk_mrhom_child_event_count CHECK (child_event_count >= 1),
      CONSTRAINT chk_mrhom_not_self CHECK (child_operation_id <> parent_operation_id),
      CONSTRAINT fk_mrhom_parent
        FOREIGN KEY (sheet_id, parent_operation_id)
        REFERENCES public.meta_record_history_operations (sheet_id, operation_id)
        DEFERRABLE INITIALLY DEFERRED,
      CONSTRAINT fk_mrhom_child
        FOREIGN KEY (sheet_id, child_operation_id)
        REFERENCES public.meta_record_history_operations (sheet_id, operation_id)
        DEFERRABLE INITIALLY DEFERRED
    )
  `.execute(db)
  await sql`
    CREATE INDEX idx_meta_record_history_operation_members_parent
      ON public.meta_record_history_operation_members (sheet_id, parent_operation_id)
  `.execute(db)

  await sql`
    CREATE FUNCTION public.meta_sheet_section_revisions_guard_row()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $fn$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.section_kind NOT IN (
          'schema',
          'records',
          'links',
          'field_value_tombstones',
          'link_tombstones',
          'auto_number',
          'attachments_index',
          'permission_evidence',
          'views_config'
        ) THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'section_causality_section_kind_invalid';
        END IF;
        IF NEW.section_kind = 'records' AND NEW.action IS DISTINCT FROM 'bootstrap_snapshot' THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'section_causality_records_requires_bootstrap';
        END IF;
        RETURN NEW;
      END IF;
      IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'section_causality_section_revision_immutable';
      END IF;
      IF TG_OP = 'DELETE' THEN
        IF current_setting('metasheet.mrho_retention', true) IS DISTINCT FROM 'on' THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'section_causality_section_revision_immutable';
        END IF;
        RETURN OLD;
      END IF;
      RETURN NEW;
    END;
    $fn$
  `.execute(db)

  await sql`
    CREATE FUNCTION public.meta_record_history_membership_guard_row()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $fn$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NOT pg_catalog.pg_try_advisory_xact_lock(
          pg_catalog.hashtextextended(
            'mrho_membership_v1:'
              || pg_catalog.length(NEW.sheet_id)::text
              || ':'
              || NEW.sheet_id
              || ':'
              || NEW.parent_operation_id::text,
            0
          )
        ) THEN
          RAISE EXCEPTION USING
            ERRCODE = '40001',
            MESSAGE = 'section_causality_membership_busy';
        END IF;
        IF EXISTS (
          SELECT 1
            FROM public.meta_record_history_operations sealed
           WHERE sealed.sheet_id = NEW.sheet_id
             AND sealed.operation_id = NEW.parent_operation_id
        ) THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'section_causality_membership_sealed';
        END IF;
        RETURN NEW;
      END IF;
      IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'section_causality_membership_immutable';
      END IF;
      IF TG_OP = 'DELETE' THEN
        IF current_setting('metasheet.mrho_retention', true) IS DISTINCT FROM 'on' THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'section_causality_membership_immutable';
        END IF;
        RETURN OLD;
      END IF;
      RETURN NEW;
    END;
    $fn$
  `.execute(db)

  await sql`
    CREATE TRIGGER trg_mssr_reject_append_sealed
    BEFORE INSERT ON public.meta_sheet_section_revisions
    FOR EACH ROW EXECUTE FUNCTION public.meta_record_reject_append_to_sealed_operation()
  `.execute(db)
  await sql`
    CREATE TRIGGER trg_mssr_guard_row
    BEFORE INSERT OR UPDATE OR DELETE ON public.meta_sheet_section_revisions
    FOR EACH ROW EXECUTE FUNCTION public.meta_sheet_section_revisions_guard_row()
  `.execute(db)
  await sql`
    CREATE TRIGGER trg_mrhsm_guard_row
    BEFORE INSERT OR UPDATE OR DELETE ON public.meta_record_history_snapshot_members
    FOR EACH ROW EXECUTE FUNCTION public.meta_record_history_membership_guard_row()
  `.execute(db)
  await sql`
    CREATE TRIGGER trg_mrhom_guard_row
    BEFORE INSERT OR UPDATE OR DELETE ON public.meta_record_history_operation_members
    FOR EACH ROW EXECUTE FUNCTION public.meta_record_history_membership_guard_row()
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION public.meta_record_history_operations_validate_endpoint()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $fn$
    DECLARE
      record_count bigint;
      record_max bigint;
      marker_count bigint;
      marker_max bigint;
      section_count bigint;
      section_max bigint;
      actual_count bigint;
      actual_max bigint;
      bootstrap_action text;
      member_count bigint;
      matched_count bigint;
      mismatch_count bigint;
      child_sum bigint;
      child_max bigint;
      child_min_ordinal integer;
      child_max_ordinal integer;
    BEGIN
      SELECT COUNT(*), MAX(seq)
        INTO record_count, record_max
        FROM public.meta_record_revisions
       WHERE sheet_id = NEW.sheet_id AND operation_id = NEW.operation_id;
      SELECT COUNT(*), MAX(seq)
        INTO marker_count, marker_max
        FROM public.meta_record_version_markers
       WHERE sheet_id = NEW.sheet_id AND operation_id = NEW.operation_id;
      SELECT COUNT(*), MAX(seq)
        INTO section_count, section_max
        FROM public.meta_sheet_section_revisions
       WHERE sheet_id = NEW.sheet_id AND operation_id = NEW.operation_id;

      IF NEW.event_contract_version = 1 THEN
        IF NEW.operation_kind IS DISTINCT FROM 'ordinary'
           OR NEW.component_count IS NOT NULL
           OR section_count <> 0 THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'section_causality_legacy_contract_invalid';
        END IF;
        actual_count := record_count + marker_count;
        actual_max := GREATEST(record_max, marker_max);
        IF actual_count <> NEW.event_count THEN
          RAISE EXCEPTION 'sealed operation % event_count=% does not match % actual events',
            NEW.operation_id, NEW.event_count, actual_count USING ERRCODE = 'check_violation';
        END IF;
        IF actual_max IS DISTINCT FROM NEW.endpoint_seq THEN
          RAISE EXCEPTION 'sealed operation % endpoint_seq=% does not match actual MAX(seq)=%',
            NEW.operation_id, NEW.endpoint_seq, actual_max USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END IF;

      IF NEW.event_contract_version IS DISTINCT FROM 2 THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'section_causality_contract_version_invalid';
      END IF;

      actual_count := record_count + marker_count + section_count;
      actual_max := GREATEST(record_max, marker_max, section_max);

      IF NEW.operation_kind IN ('ordinary', 'restore_chunk') THEN
        IF NEW.event_count < 1 OR actual_count <> NEW.event_count
           OR actual_max IS DISTINCT FROM NEW.endpoint_seq THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'section_causality_direct_event_mismatch';
        END IF;
        RETURN NEW;
      END IF;

      IF NEW.operation_kind = 'section_bootstrap' THEN
        IF record_count <> 0 OR marker_count <> 0 OR section_count <> 1
           OR NEW.event_count <> 1 OR actual_max IS DISTINCT FROM NEW.endpoint_seq THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'section_causality_bootstrap_invalid';
        END IF;
        SELECT action INTO bootstrap_action
          FROM public.meta_sheet_section_revisions
         WHERE sheet_id = NEW.sheet_id AND operation_id = NEW.operation_id;
        IF bootstrap_action IS DISTINCT FROM 'bootstrap_snapshot' THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'section_causality_bootstrap_invalid';
        END IF;
        RETURN NEW;
      END IF;

      IF NEW.operation_kind = 'archive_snapshot' THEN
        IF record_count <> 0 OR marker_count <> 0 OR section_count <> 0
           OR NEW.event_count <> 0 OR NEW.component_count IS DISTINCT FROM 9 THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'section_causality_snapshot_direct_events_forbidden';
        END IF;
        SELECT COUNT(*),
               COUNT(*) FILTER (
                 WHERE expected.section_kind IS NOT NULL
               )
          INTO member_count, matched_count
          FROM public.meta_record_history_snapshot_members member_row
          LEFT JOIN (
            VALUES
              (1, 'schema'),
              (2, 'records'),
              (3, 'links'),
              (4, 'field_value_tombstones'),
              (5, 'link_tombstones'),
              (6, 'auto_number'),
              (7, 'attachments_index'),
              (8, 'permission_evidence'),
              (9, 'views_config')
          ) expected(ordinal, section_kind)
            ON expected.ordinal = member_row.ordinal
           AND expected.section_kind = member_row.section_kind
         WHERE member_row.sheet_id = NEW.sheet_id
           AND member_row.parent_operation_id = NEW.operation_id;
        IF member_count <> 9 OR matched_count <> 9 THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'section_causality_snapshot_membership_invalid';
        END IF;
        IF EXISTS (
          SELECT 1
            FROM public.meta_record_history_snapshot_members member_row
           WHERE member_row.sheet_id = NEW.sheet_id
             AND member_row.parent_operation_id = NEW.operation_id
             AND member_row.source_head_kind IS DISTINCT FROM 'section_bootstrap'
        ) THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'section_causality_snapshot_source_unfinalized';
        END IF;
        SELECT COUNT(*)
          INTO mismatch_count
          FROM public.meta_record_history_snapshot_members member_row
          LEFT JOIN public.meta_record_history_operations source_row
            ON source_row.sheet_id = member_row.sheet_id
           AND source_row.operation_id = member_row.source_operation_id
          LEFT JOIN public.meta_sheet_section_revisions revision_row
            ON revision_row.sheet_id = member_row.sheet_id
           AND revision_row.operation_id = member_row.source_operation_id
           AND revision_row.section_kind = member_row.section_kind
           AND revision_row.seq = member_row.source_head_seq
         WHERE member_row.sheet_id = NEW.sheet_id
           AND member_row.parent_operation_id = NEW.operation_id
           AND (
             member_row.source_operation_id IS NULL
             OR source_row.operation_id IS NULL
             OR source_row.operation_kind IS DISTINCT FROM member_row.source_head_kind
             OR member_row.source_head_seq >= NEW.endpoint_seq
             OR source_row.endpoint_seq IS DISTINCT FROM member_row.source_head_seq
             OR (
               member_row.source_head_kind = 'section_bootstrap'
               AND (
                 revision_row.id IS NULL
                 OR revision_row.action IS DISTINCT FROM 'bootstrap_snapshot'
                 OR revision_row.payload->>'source_hash' IS DISTINCT FROM member_row.source_hash
                 OR revision_row.payload->>'row_count' IS DISTINCT FROM member_row.row_count::text
               )
             )
           );
        IF mismatch_count <> 0 THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'section_causality_snapshot_membership_invalid';
        END IF;
        RETURN NEW;
      END IF;

      IF NEW.operation_kind = 'restore_aggregate' THEN
        IF record_count <> 0 OR marker_count <> 0 OR section_count <> 0 THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'section_causality_aggregate_direct_events_forbidden';
        END IF;
        SELECT COUNT(*),
               COALESCE(SUM(child_event_count), 0),
               MAX(child_endpoint_seq),
               MIN(ordinal),
               MAX(ordinal)
          INTO member_count, child_sum, child_max, child_min_ordinal, child_max_ordinal
          FROM public.meta_record_history_operation_members
         WHERE sheet_id = NEW.sheet_id
           AND parent_operation_id = NEW.operation_id;
        IF member_count <> NEW.component_count
           OR member_count < 1
           OR child_min_ordinal IS DISTINCT FROM 1
           OR child_max_ordinal IS DISTINCT FROM member_count
           OR child_sum IS DISTINCT FROM NEW.event_count
           OR child_max IS DISTINCT FROM NEW.endpoint_seq THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'section_causality_aggregate_membership_invalid';
        END IF;
        SELECT COUNT(*)
          INTO mismatch_count
          FROM public.meta_record_history_operation_members member_row
          LEFT JOIN public.meta_record_history_operations child_row
            ON child_row.sheet_id = member_row.sheet_id
           AND child_row.operation_id = member_row.child_operation_id
         WHERE member_row.sheet_id = NEW.sheet_id
           AND member_row.parent_operation_id = NEW.operation_id
           AND (
             child_row.operation_id IS NULL
             OR child_row.operation_kind IS DISTINCT FROM 'restore_chunk'
             OR child_row.event_contract_version IS DISTINCT FROM 2
             OR child_row.event_count IS DISTINCT FROM member_row.child_event_count
             OR child_row.endpoint_seq IS DISTINCT FROM member_row.child_endpoint_seq
           );
        IF mismatch_count <> 0 THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'section_causality_aggregate_membership_invalid';
        END IF;
        SELECT COUNT(*)
          INTO mismatch_count
          FROM generate_series(1, member_count::integer) expected_ordinal(ordinal)
          LEFT JOIN public.meta_record_history_operation_members member_row
            ON member_row.sheet_id = NEW.sheet_id
           AND member_row.parent_operation_id = NEW.operation_id
           AND member_row.ordinal = expected_ordinal.ordinal
         WHERE member_row.ordinal IS NULL;
        IF mismatch_count <> 0 THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'section_causality_aggregate_membership_invalid';
        END IF;
        RETURN NEW;
      END IF;

      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'section_causality_operation_kind_invalid';
    END;
    $fn$
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION public.meta_record_history_operations_prune(
      p_sheet_id text,
      p_operation_id uuid
    )
    RETURNS void
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $fn$
    BEGIN
      PERFORM set_config('metasheet.mrho_retention', 'on', true);
      DELETE FROM public.meta_sheet_section_revisions
        WHERE sheet_id = p_sheet_id AND operation_id = p_operation_id;
      DELETE FROM public.meta_record_history_snapshot_members
        WHERE sheet_id = p_sheet_id AND parent_operation_id = p_operation_id;
      DELETE FROM public.meta_record_history_operation_members
        WHERE sheet_id = p_sheet_id AND parent_operation_id = p_operation_id;
      DELETE FROM public.meta_record_revisions
        WHERE sheet_id = p_sheet_id AND operation_id = p_operation_id;
      DELETE FROM public.meta_record_version_markers
        WHERE sheet_id = p_sheet_id AND operation_id = p_operation_id;
      DELETE FROM public.meta_record_history_operations
        WHERE sheet_id = p_sheet_id AND operation_id = p_operation_id;
      PERFORM set_config('metasheet.mrho_retention', 'off', true);
    END;
    $fn$
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$
    DECLARE
      causality_nonempty boolean := false;
    BEGIN
      IF pg_catalog.to_regclass('public.meta_sheet_section_revisions') IS NOT NULL THEN
        SELECT EXISTS (SELECT 1 FROM public.meta_sheet_section_revisions LIMIT 1)
          INTO causality_nonempty;
      END IF;
      IF NOT causality_nonempty
         AND pg_catalog.to_regclass('public.meta_record_history_snapshot_members') IS NOT NULL THEN
        SELECT EXISTS (SELECT 1 FROM public.meta_record_history_snapshot_members LIMIT 1)
          INTO causality_nonempty;
      END IF;
      IF NOT causality_nonempty
         AND pg_catalog.to_regclass('public.meta_record_history_operation_members') IS NOT NULL THEN
        SELECT EXISTS (SELECT 1 FROM public.meta_record_history_operation_members LIMIT 1)
          INTO causality_nonempty;
      END IF;
      IF NOT causality_nonempty
         AND pg_catalog.to_regclass('public.meta_record_history_operations') IS NOT NULL
         AND EXISTS (
           SELECT 1
             FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'meta_record_history_operations'
              AND column_name = 'operation_kind'
         ) THEN
        SELECT EXISTS (
          SELECT 1
            FROM public.meta_record_history_operations
           WHERE operation_kind <> 'ordinary'
              OR event_contract_version <> 1
              OR component_count IS NOT NULL
           LIMIT 1
        ) INTO causality_nonempty;
      END IF;

      IF causality_nonempty THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'section_causality_catalog_nonempty';
      END IF;
    END $$;
  `.execute(db)

  await sql`
    DO $$
    BEGIN
      IF pg_catalog.to_regclass('public.meta_sheet_section_revisions') IS NOT NULL THEN
        DROP TRIGGER IF EXISTS trg_mssr_reject_append_sealed ON public.meta_sheet_section_revisions;
        DROP TRIGGER IF EXISTS trg_mssr_guard_row ON public.meta_sheet_section_revisions;
      END IF;
      IF pg_catalog.to_regclass('public.meta_record_history_snapshot_members') IS NOT NULL THEN
        DROP TRIGGER IF EXISTS trg_mrhsm_guard_row ON public.meta_record_history_snapshot_members;
      END IF;
      IF pg_catalog.to_regclass('public.meta_record_history_operation_members') IS NOT NULL THEN
        DROP TRIGGER IF EXISTS trg_mrhom_guard_row ON public.meta_record_history_operation_members;
      END IF;
    END $$;
  `.execute(db)

  await sql`DROP TABLE IF EXISTS public.meta_record_history_operation_members`.execute(db)
  await sql`DROP TABLE IF EXISTS public.meta_record_history_snapshot_members`.execute(db)
  await sql`DROP TABLE IF EXISTS public.meta_sheet_section_revisions`.execute(db)
  await sql`DROP FUNCTION IF EXISTS public.meta_record_history_membership_guard_row()`.execute(db)
  await sql`DROP FUNCTION IF EXISTS public.meta_sheet_section_revisions_guard_row()`.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION meta_record_history_operations_validate_endpoint()
    RETURNS trigger AS $fn$
    DECLARE
      actual_count bigint;
      actual_max bigint;
    BEGIN
      SELECT COUNT(*), MAX(seq) INTO actual_count, actual_max
      FROM (
        SELECT seq FROM meta_record_revisions
          WHERE sheet_id = NEW.sheet_id AND operation_id = NEW.operation_id
        UNION ALL
        SELECT seq FROM meta_record_version_markers
          WHERE sheet_id = NEW.sheet_id AND operation_id = NEW.operation_id
      ) e;
      IF actual_count <> NEW.event_count THEN
        RAISE EXCEPTION 'sealed operation % event_count=% does not match % actual events',
          NEW.operation_id, NEW.event_count, actual_count USING ERRCODE = 'check_violation';
      END IF;
      IF actual_max IS DISTINCT FROM NEW.endpoint_seq THEN
        RAISE EXCEPTION 'sealed operation % endpoint_seq=% does not match actual MAX(seq)=%',
          NEW.operation_id, NEW.endpoint_seq, actual_max USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql
  `.execute(db)
  await sql`ALTER FUNCTION public.meta_record_history_operations_validate_endpoint() RESET ALL`.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION meta_record_history_operations_prune(p_sheet_id text, p_operation_id uuid)
    RETURNS void AS $fn$
    BEGIN
      PERFORM set_config('metasheet.mrho_retention', 'on', true);
      DELETE FROM meta_record_revisions
        WHERE sheet_id = p_sheet_id AND operation_id = p_operation_id;
      DELETE FROM meta_record_version_markers
        WHERE sheet_id = p_sheet_id AND operation_id = p_operation_id;
      DELETE FROM meta_record_history_operations
        WHERE sheet_id = p_sheet_id AND operation_id = p_operation_id;
      PERFORM set_config('metasheet.mrho_retention', 'off', true);
    END;
    $fn$ LANGUAGE plpgsql
  `.execute(db)
  await sql`
    ALTER FUNCTION public.meta_record_history_operations_prune(text, uuid) RESET ALL
  `.execute(db)

  await sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'meta_record_history_operations'
           AND column_name = 'operation_kind'
      ) THEN
        ALTER TABLE public.meta_record_history_operations
          DROP CONSTRAINT IF EXISTS chk_mrho_event_contract,
          DROP CONSTRAINT IF EXISTS chk_mrho_event_contract_version,
          DROP CONSTRAINT IF EXISTS chk_mrho_operation_kind,
          DROP COLUMN component_count,
          DROP COLUMN event_contract_version,
          DROP COLUMN operation_kind;
      END IF;
      IF NOT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_constraint constraint_row
          JOIN pg_catalog.pg_class relation ON relation.oid = constraint_row.conrelid
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = 'public'
           AND relation.relname = 'meta_record_history_operations'
           AND constraint_row.conname = 'chk_mrho_event_count_positive'
      ) AND pg_catalog.to_regclass('public.meta_record_history_operations') IS NOT NULL THEN
        ALTER TABLE public.meta_record_history_operations
          ADD CONSTRAINT chk_mrho_event_count_positive CHECK (event_count >= 1);
      END IF;
    END $$;
  `.execute(db)
}
