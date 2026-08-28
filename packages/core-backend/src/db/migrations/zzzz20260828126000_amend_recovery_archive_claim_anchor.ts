import { sql, type Kysely } from 'kysely'

/**
 * Phase D2 claim-anchor catalog amendment.
 *
 * Default-inert: no caller, flag, or route. Keeps generation anchor id/seq NOT NULL and
 * immutable, replaces the immediate sealed-operation FK/INSERT cycle with deferred
 * reservation-backed binding so a claim can persist a building generation plus its exact
 * ten-row reservation set before the ordinal-10 v2 archive_snapshot parent is sealed.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$
    DECLARE
      source_mismatch_count integer := 0;
      owned_object_count integer := 0;
      predecessor_trigger_count integer := 0;
      predecessor_function_count integer := 0;
      predecessor_fk_count integer := 0;
    BEGIN
      WITH expected(relation_name, column_name, type_name, is_not_null) AS (
        VALUES
          ('meta_recovery_archives', 'generation_id', 'uuid', true),
          ('meta_recovery_archives', 'sheet_id', 'text', true),
          ('meta_recovery_archives', 'anchor_operation_id', 'uuid', true),
          ('meta_recovery_archives', 'anchor_seq', 'bigint', true),
          ('meta_recovery_archives', 'source_vector_hash', 'text', true),
          ('meta_recovery_archives', 'owner_kind', 'text', true),
          ('meta_recovery_archives', 'owner_id', 'text', true),
          ('meta_recovery_archives', 'owner_fence', 'bigint', true),
          ('meta_recovery_archive_snapshot_reservations', 'generation_id', 'uuid', true),
          ('meta_recovery_archive_snapshot_reservations', 'sheet_id', 'text', true),
          ('meta_recovery_archive_snapshot_reservations', 'source_vector_hash', 'text', true),
          ('meta_recovery_archive_snapshot_reservations', 'owner_kind', 'text', true),
          ('meta_recovery_archive_snapshot_reservations', 'owner_id', 'text', true),
          ('meta_recovery_archive_snapshot_reservations', 'owner_fence', 'bigint', true),
          ('meta_recovery_archive_snapshot_reservations', 'ordinal', 'integer', true),
          ('meta_recovery_archive_snapshot_reservations', 'reservation_kind', 'text', true),
          ('meta_recovery_archive_snapshot_reservations', 'section_kind', 'text', false),
          ('meta_recovery_archive_snapshot_reservations', 'operation_id', 'uuid', true),
          ('meta_recovery_archive_snapshot_reservations', 'endpoint_seq', 'bigint', true),
          ('meta_record_history_operations', 'sheet_id', 'text', true),
          ('meta_record_history_operations', 'operation_id', 'uuid', true),
          ('meta_record_history_operations', 'endpoint_seq', 'bigint', true),
          ('meta_record_history_operations', 'event_count', 'integer', true),
          ('meta_record_history_operations', 'operation_kind', 'text', true),
          ('meta_record_history_operations', 'event_contract_version', 'integer', true),
          ('meta_record_history_operations', 'component_count', 'integer', false),
          ('meta_record_history_snapshot_members', 'sheet_id', 'text', true),
          ('meta_record_history_snapshot_members', 'parent_operation_id', 'uuid', true),
          ('meta_record_history_snapshot_members', 'ordinal', 'integer', true),
          ('meta_record_history_snapshot_members', 'section_kind', 'text', true),
          ('meta_record_history_snapshot_members', 'source_head_kind', 'text', true),
          ('meta_record_history_snapshot_members', 'source_operation_id', 'uuid', true),
          ('meta_record_history_snapshot_members', 'source_head_seq', 'bigint', true)
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
        INTO predecessor_function_count
        FROM pg_catalog.pg_proc procedure_row
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure_row.pronamespace
       WHERE namespace.nspname = 'public'
         AND procedure_row.proname = 'meta_recovery_archives_guard_row'
         AND pg_catalog.pg_get_function_identity_arguments(procedure_row.oid) = ''
         AND procedure_row.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
         AND procedure_row.provolatile = 'v'
         AND NOT procedure_row.prosecdef
         AND procedure_row.prokind = 'f'
         AND procedure_row.proconfig = ARRAY['search_path=pg_catalog, public']::text[]
         AND pg_catalog.md5(procedure_row.prosrc) = '3700d86df374ad924cc4b6af265d146a';

      SELECT count(*)::integer
        INTO predecessor_trigger_count
        FROM pg_catalog.pg_trigger trigger_row
        JOIN pg_catalog.pg_class relation ON relation.oid = trigger_row.tgrelid
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
        JOIN pg_catalog.pg_proc procedure_row ON procedure_row.oid = trigger_row.tgfoid
       WHERE namespace.nspname = 'public'
         AND relation.relname = 'meta_recovery_archives'
         AND trigger_row.tgname = 'trg_meta_recovery_archives_guard_row'
         AND NOT trigger_row.tgisinternal
         AND trigger_row.tgenabled = 'O'
         AND trigger_row.tgtype = 31
         AND trigger_row.tgconstraint = 0
         AND NOT trigger_row.tgdeferrable
         AND NOT trigger_row.tginitdeferred
         AND trigger_row.tgqual IS NULL
         AND procedure_row.proname = 'meta_recovery_archives_guard_row';

      SELECT count(*)::integer
        INTO predecessor_fk_count
        FROM pg_catalog.pg_constraint constraint_row
        JOIN pg_catalog.pg_class relation ON relation.oid = constraint_row.conrelid
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = 'public'
         AND relation.relname = 'meta_recovery_archives'
         AND constraint_row.conname = 'fk_meta_recovery_archives_anchor'
         AND constraint_row.contype = 'f'
         AND constraint_row.confrelid = 'public.meta_record_history_operations'::pg_catalog.regclass
         AND NOT constraint_row.condeferrable
         AND NOT constraint_row.condeferred
         AND constraint_row.convalidated
         AND constraint_row.confdeltype = 'r'
         AND constraint_row.confupdtype = 'a'
         AND pg_catalog.pg_get_constraintdef(constraint_row.oid, true) =
             'FOREIGN KEY (sheet_id, anchor_operation_id) REFERENCES meta_record_history_operations(sheet_id, operation_id) ON DELETE RESTRICT';

      IF source_mismatch_count <> 0
         OR predecessor_function_count <> 1
         OR predecessor_trigger_count <> 1
         OR predecessor_fk_count <> 1 THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_claim_anchor_source_schema_mismatch';
      END IF;

      SELECT (
        (SELECT count(*) FROM pg_catalog.pg_proc procedure_row
           JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure_row.pronamespace
          WHERE namespace.nspname = 'public'
            AND procedure_row.proname IN (
              'meta_recovery_archives_claim_anchor_guard_row',
              'meta_recovery_archives_claim_anchor_reservation_guard',
              'meta_recovery_archives_claim_anchor_operation_delete_guard'
            )) +
        (SELECT count(*) FROM pg_catalog.pg_trigger trigger_row
          WHERE NOT trigger_row.tgisinternal
            AND trigger_row.tgname IN (
              'trg_meta_recovery_archives_claim_anchor_guard_row',
              'trg_meta_recovery_archives_claim_anchor_reservation_guard',
              'trg_mrho_claim_anchor_delete_guard'
            ))
      )::integer INTO owned_object_count;

      IF owned_object_count <> 0 THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_claim_anchor_object_conflict';
      END IF;
    END $$;
  `.execute(db)

  await sql`
    ALTER TABLE public.meta_recovery_archives
      DROP CONSTRAINT fk_meta_recovery_archives_anchor
  `.execute(db)

  await sql`
    DROP TRIGGER trg_meta_recovery_archives_guard_row ON public.meta_recovery_archives
  `.execute(db)

  await sql`
    CREATE FUNCTION public.meta_recovery_archives_claim_anchor_guard_row()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $claim_anchor_row$
    DECLARE
      coverage_count bigint;
      snapshot_kind text;
      snapshot_version integer;
      snapshot_event_count bigint;
      snapshot_component_count integer;
      snapshot_endpoint_seq bigint;
      member_count integer;
      matched_count integer;
      reservation_match_count integer;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_delete_not_authorized';
      END IF;

      -- INSERT KEY SHARE only: an absent parent is the claim path. UPDATE does not lock
      -- here; building->verified already KEY SHAREs the parent in its validator below.
      IF TG_OP = 'INSERT' THEN
        PERFORM 1
          FROM public.meta_record_history_operations operation
         WHERE operation.sheet_id = NEW.sheet_id
           AND operation.operation_id = NEW.anchor_operation_id
         FOR KEY SHARE;
      END IF;

      IF TG_OP = 'UPDATE' AND (
        NEW.generation_id IS DISTINCT FROM OLD.generation_id OR
        NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR
        NEW.base_id IS DISTINCT FROM OLD.base_id OR
        NEW.sheet_id IS DISTINCT FROM OLD.sheet_id OR
        NEW.anchor_operation_id IS DISTINCT FROM OLD.anchor_operation_id OR
        NEW.anchor_seq IS DISTINCT FROM OLD.anchor_seq OR
        NEW.checkpoint_id IS DISTINCT FROM OLD.checkpoint_id OR
        NEW.format_version IS DISTINCT FROM OLD.format_version OR
        NEW.source_vector_hash IS DISTINCT FROM OLD.source_vector_hash OR
        NEW.key_id IS DISTINCT FROM OLD.key_id OR
        NEW.expires_at IS DISTINCT FROM OLD.expires_at OR
        NEW.created_at IS DISTINCT FROM OLD.created_at
      ) THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_identity_immutable';
      END IF;

      IF NEW.workspace_id IS NULL THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'recovery_archive_binding_invalid';
      END IF;

      IF NEW.generation_id IS NULL
         OR NEW.base_id IS NULL
         OR NEW.sheet_id IS NULL
         OR NEW.anchor_operation_id IS NULL
         OR NEW.anchor_seq IS NULL
         OR NEW.anchor_seq < 1
         OR NEW.checkpoint_id IS NULL
         OR NEW.format_version IS NULL
         OR NEW.format_version <> 1
         OR NEW.state IS NULL
         OR NEW.build_status IS NULL
         OR NEW.coverage_status IS NULL
         OR NEW.source_vector_hash IS NULL
         OR NEW.source_vector_hash !~ '^[0-9a-f]{64}$'
         OR NEW.key_id IS NULL
         OR length(btrim(NEW.key_id)) = 0
         OR (NEW.root_hash IS NOT NULL AND NEW.root_hash !~ '^[0-9a-f]{64}$')
         OR (
           NEW.coverage_section_hash IS NOT NULL AND
           NEW.coverage_section_hash !~ '^[0-9a-f]{64}$'
         )
         OR (NEW.coverage_row_count IS NOT NULL AND NEW.coverage_row_count < 0)
         OR (NEW.manifest_mac IS NOT NULL AND octet_length(NEW.manifest_mac) = 0)
         OR NEW.owner_kind IS NULL
         OR length(btrim(NEW.owner_kind)) = 0
         OR NEW.owner_id IS NULL
         OR length(btrim(NEW.owner_id)) = 0
         OR NEW.owner_fence IS NULL
         OR NEW.owner_fence < 1
         OR NEW.lease_expires_at IS NULL
         OR NEW.expires_at IS NULL
         OR NEW.created_at IS NULL
         OR NEW.updated_at IS NULL THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'recovery_archive_catalog_shape_invalid';
      END IF;

      IF TG_OP = 'INSERT' THEN
        IF NOT EXISTS (
          SELECT 1
            FROM public.meta_sheets sheet
            JOIN public.meta_bases base ON base.id = sheet.base_id
            JOIN public.meta_history_trust_checkpoints checkpoint
              ON checkpoint.id = NEW.checkpoint_id
             AND checkpoint.sheet_id = sheet.id
             AND checkpoint.state IN ('active', 'superseded')
             AND checkpoint.pruned_at IS NULL
             AND checkpoint.trusted_since_seq <= NEW.anchor_seq
           WHERE sheet.id = NEW.sheet_id
             AND sheet.base_id = NEW.base_id
             AND base.id = NEW.base_id
             AND base.workspace_id IS NOT NULL
             AND base.workspace_id = NEW.workspace_id
             AND sheet.system_kind IS NULL
        ) THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'recovery_archive_binding_invalid';
        END IF;

        IF NEW.state <> 'building'
           OR NEW.build_status <> 'active'
           OR NEW.coverage_status <> 'incomplete' THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'recovery_archive_initial_posture_invalid';
        END IF;

        IF NEW.superseded_by_generation_id IS NOT NULL THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'recovery_archive_supersession_invalid';
        END IF;

        RETURN NEW;
      END IF;

      IF NEW.state IS DISTINCT FROM OLD.state
         OR NEW.build_status IS DISTINCT FROM OLD.build_status
         OR NEW.coverage_status IS DISTINCT FROM OLD.coverage_status THEN
        IF NOT (
          (
            OLD.state = 'building' AND
            OLD.build_status = 'active' AND
            OLD.coverage_status = 'incomplete' AND
            NEW.state = 'verified' AND
            NEW.build_status = 'finalized' AND
            NEW.coverage_status = 'complete'
          ) OR (
            OLD.state = 'building' AND
            OLD.build_status = 'active' AND
            OLD.coverage_status = 'incomplete' AND
            NEW.state = 'building' AND
            NEW.build_status = 'abandoned' AND
            NEW.coverage_status = 'incomplete'
          ) OR (
            OLD.state = 'verified' AND
            OLD.build_status = 'finalized' AND
            OLD.coverage_status = 'complete' AND
            NEW.state = 'expired' AND
            NEW.build_status = 'finalized' AND
            NEW.coverage_status = 'complete'
          )
        ) THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'recovery_archive_transition_invalid';
        END IF;
      END IF;

      IF OLD.state IN ('verified', 'expired') AND (
        NEW.root_hash IS DISTINCT FROM OLD.root_hash OR
        NEW.coverage_section_hash IS DISTINCT FROM OLD.coverage_section_hash OR
        NEW.coverage_row_count IS DISTINCT FROM OLD.coverage_row_count OR
        NEW.manifest_mac IS DISTINCT FROM OLD.manifest_mac
      ) THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_payload_immutable';
      END IF;

      IF OLD.superseded_by_generation_id IS NOT NULL
         AND NEW.superseded_by_generation_id IS DISTINCT FROM OLD.superseded_by_generation_id THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_supersession_immutable';
      END IF;

      IF OLD.superseded_by_generation_id IS NULL
         AND NEW.superseded_by_generation_id IS NOT NULL THEN
        IF OLD.state NOT IN ('verified', 'expired') OR NOT EXISTS (
          SELECT 1
            FROM public.meta_recovery_archives replacement
           WHERE replacement.generation_id = NEW.superseded_by_generation_id
             AND replacement.generation_id <> NEW.generation_id
             AND replacement.workspace_id = NEW.workspace_id
             AND replacement.base_id = NEW.base_id
             AND replacement.sheet_id = NEW.sheet_id
             AND replacement.anchor_operation_id = NEW.anchor_operation_id
             AND replacement.anchor_seq = NEW.anchor_seq
             AND replacement.checkpoint_id = NEW.checkpoint_id
             AND replacement.format_version = NEW.format_version
             AND replacement.state = 'verified'
             AND replacement.build_status = 'finalized'
             AND replacement.coverage_status = 'complete'
             AND replacement.superseded_by_generation_id IS DISTINCT FROM NEW.generation_id
        ) THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'recovery_archive_supersession_invalid';
        END IF;
      END IF;

      IF OLD.state = 'building' AND NEW.state = 'verified' THEN
        IF NEW.root_hash IS NULL
           OR NEW.coverage_section_hash IS NULL
           OR NEW.coverage_row_count IS NULL
           OR NEW.manifest_mac IS NULL THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'recovery_archive_finalized_fields_missing';
        END IF;

        SELECT count(*)::bigint
          INTO coverage_count
          FROM public.meta_recovery_archive_coverage_items coverage
         WHERE coverage.generation_id = NEW.generation_id;

        IF NEW.coverage_row_count <> coverage_count THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'recovery_archive_coverage_count_mismatch';
        END IF;

        IF EXISTS (
          SELECT 1
            FROM public.meta_recovery_archive_attachment_refs attachment_ref
           WHERE attachment_ref.generation_id = NEW.generation_id
             AND attachment_ref.reference_class = 'source'
             AND attachment_ref.reference_state = 'building'
        ) THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'recovery_archive_attachment_posture_invalid';
        END IF;

        SELECT operation.operation_kind,
               operation.event_contract_version,
               operation.event_count,
               operation.component_count,
               operation.endpoint_seq
          INTO snapshot_kind,
               snapshot_version,
               snapshot_event_count,
               snapshot_component_count,
               snapshot_endpoint_seq
          FROM public.meta_record_history_operations operation
         WHERE operation.sheet_id = NEW.sheet_id
           AND operation.operation_id = NEW.anchor_operation_id
         FOR KEY SHARE;

        IF NOT FOUND
           OR snapshot_kind IS DISTINCT FROM 'archive_snapshot'
           OR snapshot_version IS DISTINCT FROM 2
           OR snapshot_event_count IS DISTINCT FROM 0
           OR snapshot_component_count IS DISTINCT FROM 9
           OR snapshot_endpoint_seq IS DISTINCT FROM NEW.anchor_seq THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'recovery_archive_claim_anchor_parent_unsealed';
        END IF;

        SELECT count(*)::integer,
               count(*) FILTER (
                 WHERE expected.section_kind IS NOT NULL
               )::integer,
               count(*) FILTER (
                 WHERE reservation.ordinal IS NOT NULL
                   AND reservation.reservation_kind = 'section_bootstrap'
                   AND reservation.section_kind = member_row.section_kind
                   AND reservation.operation_id = member_row.source_operation_id
                   AND reservation.endpoint_seq = member_row.source_head_seq
                   AND member_row.source_head_kind = 'section_bootstrap'
               )::integer
          INTO member_count, matched_count, reservation_match_count
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
          LEFT JOIN public.meta_recovery_archive_snapshot_reservations reservation
            ON reservation.generation_id = NEW.generation_id
           AND reservation.ordinal = member_row.ordinal
         WHERE member_row.sheet_id = NEW.sheet_id
           AND member_row.parent_operation_id = NEW.anchor_operation_id;

        IF member_count <> 9 OR matched_count <> 9 OR reservation_match_count <> 9 THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'recovery_archive_claim_anchor_parent_unsealed';
        END IF;
      END IF;

      NEW.updated_at := clock_timestamp();
      RETURN NEW;
    END
    $claim_anchor_row$;
  `.execute(db)

  await sql`
    CREATE FUNCTION public.meta_recovery_archives_claim_anchor_reservation_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $claim_anchor_reservation$
    BEGIN
      -- Reservation arm needs no operation lock (parent is still future). The
      -- compatibility arm KEY SHAREs sheet/op/seq so a parent that appears after
      -- BEFORE INSERT cannot be deleted out from under COMMIT.
      IF EXISTS (
        SELECT 1
          FROM public.meta_recovery_archive_snapshot_reservations reservation
         WHERE reservation.generation_id = NEW.generation_id
           AND reservation.sheet_id = NEW.sheet_id
           AND reservation.source_vector_hash = NEW.source_vector_hash
           AND reservation.owner_kind = NEW.owner_kind
           AND reservation.owner_id = NEW.owner_id
           AND reservation.owner_fence = NEW.owner_fence
           AND reservation.ordinal = 10
           AND reservation.reservation_kind = 'archive_snapshot'
           AND reservation.operation_id = NEW.anchor_operation_id
           AND reservation.endpoint_seq = NEW.anchor_seq
      ) THEN
        RETURN NULL;
      END IF;

      PERFORM 1
        FROM public.meta_record_history_operations operation
       WHERE operation.sheet_id = NEW.sheet_id
         AND operation.operation_id = NEW.anchor_operation_id
         AND operation.endpoint_seq = NEW.anchor_seq
       FOR KEY SHARE;

      IF FOUND THEN
        RETURN NULL;
      END IF;

      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'recovery_archive_binding_invalid';
    END
    $claim_anchor_reservation$;
  `.execute(db)

  await sql`
    CREATE FUNCTION public.meta_recovery_archives_claim_anchor_operation_delete_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $claim_anchor_delete$
    BEGIN
      -- DELETE already holds the operation row. Archive UPDATE can hold its row before
      -- validating the operation, so this reverse-order probe must never wait and close an
      -- operation<->archive cycle.
      BEGIN
        PERFORM 1
          FROM public.meta_recovery_archives archive
         WHERE archive.sheet_id = OLD.sheet_id
           AND archive.anchor_operation_id = OLD.operation_id
         FOR SHARE NOWAIT;
      EXCEPTION WHEN lock_not_available THEN
        RAISE EXCEPTION USING
          ERRCODE = '55P03',
          MESSAGE = 'recovery_archive_claim_anchor_busy';
      END;

      IF FOUND THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_anchor_operation_referenced';
      END IF;
      RETURN OLD;
    END
    $claim_anchor_delete$;
  `.execute(db)

  await sql`
    CREATE TRIGGER trg_meta_recovery_archives_claim_anchor_guard_row
    BEFORE INSERT OR UPDATE OR DELETE ON public.meta_recovery_archives
    FOR EACH ROW
    EXECUTE FUNCTION public.meta_recovery_archives_claim_anchor_guard_row()
  `.execute(db)

  await sql`
    CREATE CONSTRAINT TRIGGER trg_meta_recovery_archives_claim_anchor_reservation_guard
    AFTER INSERT OR UPDATE ON public.meta_recovery_archives
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION public.meta_recovery_archives_claim_anchor_reservation_guard()
  `.execute(db)

  await sql`
    CREATE TRIGGER trg_mrho_claim_anchor_delete_guard
    BEFORE DELETE ON public.meta_record_history_operations
    FOR EACH ROW
    EXECUTE FUNCTION public.meta_recovery_archives_claim_anchor_operation_delete_guard()
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$
    BEGIN
      BEGIN
        LOCK TABLE public.meta_recovery_archives, public.meta_record_history_operations
          IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXCEPTION WHEN lock_not_available THEN
        RAISE EXCEPTION USING
          ERRCODE = '55P03',
          MESSAGE = 'recovery_archive_claim_anchor_busy';
      END;

      IF pg_catalog.to_regclass('public.meta_recovery_archives') IS NOT NULL
         AND EXISTS (
           SELECT 1
             FROM public.meta_recovery_archives archive
             LEFT JOIN public.meta_record_history_operations operation
               ON operation.sheet_id = archive.sheet_id
              AND operation.operation_id = archive.anchor_operation_id
              AND operation.endpoint_seq = archive.anchor_seq
            WHERE operation.operation_id IS NULL
         ) THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_claim_anchor_incompatible';
      END IF;

      IF pg_catalog.to_regclass('public.meta_recovery_archives') IS NOT NULL THEN
        DROP TRIGGER IF EXISTS trg_meta_recovery_archives_claim_anchor_reservation_guard
          ON public.meta_recovery_archives;
        DROP TRIGGER IF EXISTS trg_meta_recovery_archives_claim_anchor_guard_row
          ON public.meta_recovery_archives;
        DROP TRIGGER IF EXISTS trg_meta_recovery_archives_guard_row
          ON public.meta_recovery_archives;
        CREATE TRIGGER trg_meta_recovery_archives_guard_row
        BEFORE INSERT OR UPDATE OR DELETE ON public.meta_recovery_archives
        FOR EACH ROW
        EXECUTE FUNCTION public.meta_recovery_archives_guard_row();
      END IF;

      IF pg_catalog.to_regclass('public.meta_record_history_operations') IS NOT NULL THEN
        DROP TRIGGER IF EXISTS trg_mrho_claim_anchor_delete_guard
          ON public.meta_record_history_operations;
      END IF;
    END $$;
  `.execute(db)

  await sql`DROP FUNCTION IF EXISTS public.meta_recovery_archives_claim_anchor_operation_delete_guard()`.execute(db)
  await sql`DROP FUNCTION IF EXISTS public.meta_recovery_archives_claim_anchor_reservation_guard()`.execute(db)
  await sql`DROP FUNCTION IF EXISTS public.meta_recovery_archives_claim_anchor_guard_row()`.execute(db)

  await sql`
    DO $$
    BEGIN
      IF pg_catalog.to_regclass('public.meta_recovery_archives') IS NOT NULL
         AND NOT EXISTS (
           SELECT 1
             FROM pg_catalog.pg_constraint constraint_row
            WHERE constraint_row.conrelid = 'public.meta_recovery_archives'::pg_catalog.regclass
              AND constraint_row.conname = 'fk_meta_recovery_archives_anchor'
         ) THEN
        ALTER TABLE public.meta_recovery_archives
          ADD CONSTRAINT fk_meta_recovery_archives_anchor
          FOREIGN KEY (sheet_id, anchor_operation_id)
          REFERENCES public.meta_record_history_operations(sheet_id, operation_id)
          ON DELETE RESTRICT
          NOT DEFERRABLE;
      END IF;
    END $$;
  `.execute(db)
}
