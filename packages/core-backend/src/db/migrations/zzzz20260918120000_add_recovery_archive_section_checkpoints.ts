import { sql, type Kysely } from 'kysely'

// Canonical forward definitions retain the original bootstrap/restore branches.
// No runtime caller or flag is added by this migration.
const FUNCTIONS = [
  { name: 'meta_sheet_section_revisions_guard_row', old: `CREATE OR REPLACE FUNCTION public.meta_sheet_section_revisions_guard_row()
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
    $fn$`, next: `CREATE OR REPLACE FUNCTION public.meta_sheet_section_revisions_guard_row()
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
        IF NEW.section_kind = 'records' AND NEW.action NOT IN ('bootstrap_snapshot', 'checkpoint_snapshot') THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'section_causality_records_requires_bootstrap';
        END IF;
        IF NEW.action='checkpoint_snapshot' AND NOT EXISTS (
          SELECT 1 FROM public.meta_recovery_archive_snapshot_reservations reservation
          JOIN public.meta_recovery_archives archive ON archive.generation_id=reservation.generation_id
          WHERE reservation.sheet_id=NEW.sheet_id AND reservation.operation_id=NEW.operation_id
            AND reservation.endpoint_seq=NEW.seq AND reservation.section_kind=NEW.section_kind
            AND reservation.reservation_kind='section_checkpoint'
            AND archive.sheet_id=reservation.sheet_id AND archive.source_vector_hash=reservation.source_vector_hash
            AND archive.owner_kind=reservation.owner_kind AND archive.owner_id=reservation.owner_id
            AND archive.owner_fence=reservation.owner_fence
            AND archive.state='building' AND archive.build_status='active' AND archive.coverage_status='incomplete'
            AND archive.lease_expires_at>clock_timestamp() AND archive.expires_at>clock_timestamp()
        ) THEN
          RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='recovery_archive_checkpoint_reservation_required';
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
    $fn$` },
  { name: 'meta_record_history_operations_validate_endpoint', old: `CREATE OR REPLACE FUNCTION public.meta_record_history_operations_validate_endpoint()
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
      snapshot_member_count bigint;
      operation_member_count bigint;
    BEGIN
      IF NOT pg_catalog.pg_try_advisory_xact_lock(
        pg_catalog.hashtextextended(
          'mrho_membership_v1:'
            || pg_catalog.length(NEW.sheet_id)::text
            || ':'
            || NEW.sheet_id
            || ':'
            || NEW.operation_id::text,
          0
        )
      ) THEN
        RAISE EXCEPTION USING
          ERRCODE = '40001',
          MESSAGE = 'section_causality_membership_busy';
      END IF;

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
      SELECT COUNT(*)
        INTO snapshot_member_count
        FROM public.meta_record_history_snapshot_members
       WHERE sheet_id = NEW.sheet_id AND parent_operation_id = NEW.operation_id;
      SELECT COUNT(*)
        INTO operation_member_count
        FROM public.meta_record_history_operation_members
       WHERE sheet_id = NEW.sheet_id AND parent_operation_id = NEW.operation_id;

      IF NEW.event_contract_version = 1 THEN
        IF NEW.operation_kind IS DISTINCT FROM 'ordinary'
           OR NEW.component_count IS NOT NULL
           OR section_count <> 0
           OR snapshot_member_count <> 0
           OR operation_member_count <> 0 THEN
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
           OR actual_max IS DISTINCT FROM NEW.endpoint_seq
           OR snapshot_member_count <> 0
           OR operation_member_count <> 0 THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'section_causality_direct_event_mismatch';
        END IF;
        RETURN NEW;
      END IF;

      IF NEW.operation_kind = 'section_bootstrap' THEN
        IF record_count <> 0 OR marker_count <> 0 OR section_count <> 1
           OR NEW.event_count <> 1 OR actual_max IS DISTINCT FROM NEW.endpoint_seq
           OR snapshot_member_count <> 0
           OR operation_member_count <> 0 THEN
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
        IF EXISTS (
          SELECT 1
            FROM public.meta_record_history_operation_members member_row
           WHERE member_row.sheet_id = NEW.sheet_id
             AND member_row.parent_operation_id = NEW.operation_id
        ) THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'section_causality_snapshot_membership_invalid';
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
        IF EXISTS (
          SELECT 1
            FROM public.meta_record_history_snapshot_members member_row
           WHERE member_row.sheet_id = NEW.sheet_id
             AND member_row.parent_operation_id = NEW.operation_id
        ) THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'section_causality_aggregate_membership_invalid';
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
    $fn$`, next: `CREATE OR REPLACE FUNCTION public.meta_record_history_operations_validate_endpoint()
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
      snapshot_member_count bigint;
      operation_member_count bigint;
    BEGIN
      IF NOT pg_catalog.pg_try_advisory_xact_lock(
        pg_catalog.hashtextextended(
          'mrho_membership_v1:'
            || pg_catalog.length(NEW.sheet_id)::text
            || ':'
            || NEW.sheet_id
            || ':'
            || NEW.operation_id::text,
          0
        )
      ) THEN
        RAISE EXCEPTION USING
          ERRCODE = '40001',
          MESSAGE = 'section_causality_membership_busy';
      END IF;

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
      SELECT COUNT(*)
        INTO snapshot_member_count
        FROM public.meta_record_history_snapshot_members
       WHERE sheet_id = NEW.sheet_id AND parent_operation_id = NEW.operation_id;
      SELECT COUNT(*)
        INTO operation_member_count
        FROM public.meta_record_history_operation_members
       WHERE sheet_id = NEW.sheet_id AND parent_operation_id = NEW.operation_id;

      IF NEW.operation_kind IS DISTINCT FROM 'section_checkpoint' AND EXISTS (
        SELECT 1 FROM public.meta_sheet_section_revisions
        WHERE sheet_id=NEW.sheet_id AND operation_id=NEW.operation_id AND action='checkpoint_snapshot'
      ) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='recovery_archive_checkpoint_dedicated_seal_required';
      END IF;
      IF NEW.event_contract_version = 1 THEN
        IF NEW.operation_kind IS DISTINCT FROM 'ordinary'
           OR NEW.component_count IS NOT NULL
           OR section_count <> 0
           OR snapshot_member_count <> 0
           OR operation_member_count <> 0 THEN
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
           OR actual_max IS DISTINCT FROM NEW.endpoint_seq
           OR snapshot_member_count <> 0
           OR operation_member_count <> 0 THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'section_causality_direct_event_mismatch';
        END IF;
        RETURN NEW;
      END IF;

      IF NEW.operation_kind IN ('section_bootstrap', 'section_checkpoint') THEN
        IF record_count <> 0 OR marker_count <> 0 OR section_count <> 1
           OR NEW.event_count <> 1 OR actual_max IS DISTINCT FROM NEW.endpoint_seq
           OR snapshot_member_count <> 0
           OR operation_member_count <> 0 THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'section_causality_bootstrap_invalid';
        END IF;
        SELECT action INTO bootstrap_action
          FROM public.meta_sheet_section_revisions
         WHERE sheet_id = NEW.sheet_id AND operation_id = NEW.operation_id;
        IF bootstrap_action IS DISTINCT FROM (CASE WHEN NEW.operation_kind='section_checkpoint'
          THEN 'checkpoint_snapshot' ELSE 'bootstrap_snapshot' END) THEN
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
        IF EXISTS (
          SELECT 1
            FROM public.meta_record_history_operation_members member_row
           WHERE member_row.sheet_id = NEW.sheet_id
             AND member_row.parent_operation_id = NEW.operation_id
        ) THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'section_causality_snapshot_membership_invalid';
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
             AND member_row.source_head_kind NOT IN ('section_bootstrap', 'section_checkpoint')
        ) THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'section_causality_snapshot_source_unfinalized';
        END IF;
        IF (SELECT count(DISTINCT source_head_kind) FROM public.meta_record_history_snapshot_members
            WHERE sheet_id=NEW.sheet_id AND parent_operation_id=NEW.operation_id) <> 1 THEN
          RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='recovery_archive_checkpoint_mixed_members';
        END IF;
        IF EXISTS (SELECT 1 FROM public.meta_record_history_snapshot_members
                   WHERE sheet_id=NEW.sheet_id AND parent_operation_id=NEW.operation_id
                     AND source_head_kind='section_checkpoint')
           AND (SELECT count(*) FROM public.meta_recovery_archive_snapshot_reservations parent
             JOIN public.meta_recovery_archive_snapshot_reservations section
               ON section.generation_id=parent.generation_id AND section.reservation_kind='section_checkpoint'
             JOIN public.meta_record_history_snapshot_members member
               ON member.sheet_id=section.sheet_id AND member.parent_operation_id=parent.operation_id
              AND member.ordinal=section.ordinal AND member.section_kind=section.section_kind
              AND member.source_operation_id=section.operation_id AND member.source_head_seq=section.endpoint_seq
              AND member.source_head_kind=section.reservation_kind
             WHERE parent.sheet_id=NEW.sheet_id AND parent.operation_id=NEW.operation_id
               AND parent.endpoint_seq=NEW.endpoint_seq AND parent.reservation_kind='archive_snapshot') <> 9 THEN
          RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='recovery_archive_checkpoint_parent_reservation_mismatch';
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
               member_row.source_head_kind IN ('section_bootstrap', 'section_checkpoint')
               AND (
                 revision_row.id IS NULL
                 OR revision_row.action IS DISTINCT FROM (CASE WHEN member_row.source_head_kind='section_checkpoint'
                   THEN 'checkpoint_snapshot' ELSE 'bootstrap_snapshot' END)
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
        IF EXISTS (
          SELECT 1
            FROM public.meta_record_history_snapshot_members member_row
           WHERE member_row.sheet_id = NEW.sheet_id
             AND member_row.parent_operation_id = NEW.operation_id
        ) THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'section_causality_aggregate_membership_invalid';
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
    $fn$` },
  { name: 'meta_recovery_archive_snapshot_reservation_guard_row', old: `CREATE OR REPLACE FUNCTION public.meta_recovery_archive_snapshot_reservation_guard_row()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $$
    DECLARE
      parent_row record;
      expected_section text;
    BEGIN
      IF TG_OP IN ('UPDATE', 'DELETE') THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_snapshot_reservation_immutable';
      END IF;

      expected_section := (ARRAY[
        'schema', 'records', 'links', 'field_value_tombstones', 'link_tombstones',
        'auto_number', 'attachments_index', 'permission_evidence', 'views_config'
      ]::text[])[NEW.ordinal];

      IF NEW.generation_id IS NULL
         OR NEW.sheet_id IS NULL
         OR length(btrim(NEW.sheet_id)) = 0
         OR NEW.source_vector_hash IS NULL
         OR NEW.source_vector_hash !~ '^[0-9a-f]{64}$'
         OR NEW.owner_kind IS NULL
         OR length(btrim(NEW.owner_kind)) = 0
         OR NEW.owner_id IS NULL
         OR length(btrim(NEW.owner_id)) = 0
         OR NEW.owner_fence IS NULL
         OR NEW.owner_fence < 1
         OR NEW.operation_id IS NULL
         OR NEW.endpoint_seq IS NULL
         OR NEW.endpoint_seq < 1
         OR NEW.created_at IS NULL
         OR NOT (
           (
             NEW.reservation_kind = 'section_bootstrap' AND
             NEW.ordinal BETWEEN 1 AND 9 AND
             NEW.section_kind IS NOT DISTINCT FROM expected_section
           ) OR (
             NEW.reservation_kind = 'archive_snapshot' AND
             NEW.ordinal = 10 AND
             NEW.section_kind IS NULL
           )
         ) THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'recovery_archive_snapshot_reservation_shape_invalid';
      END IF;

      SELECT archive.sheet_id, archive.source_vector_hash, archive.owner_kind, archive.owner_id,
             archive.owner_fence, archive.state, archive.build_status, archive.coverage_status
        INTO parent_row
        FROM public.meta_recovery_archives archive
       WHERE archive.generation_id = NEW.generation_id
       FOR KEY SHARE;

      IF NOT FOUND
         OR parent_row.sheet_id IS DISTINCT FROM NEW.sheet_id
         OR parent_row.source_vector_hash IS DISTINCT FROM NEW.source_vector_hash
         OR parent_row.owner_kind IS DISTINCT FROM NEW.owner_kind
         OR parent_row.owner_id IS DISTINCT FROM NEW.owner_id
         OR parent_row.owner_fence IS DISTINCT FROM NEW.owner_fence
         OR parent_row.state IS DISTINCT FROM 'building'
         OR parent_row.build_status IS DISTINCT FROM 'active'
         OR parent_row.coverage_status IS DISTINCT FROM 'incomplete' THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_snapshot_reservation_parent_invalid';
      END IF;

      IF EXISTS (
        SELECT 1
          FROM public.meta_record_history_operations operation_row
         WHERE operation_row.sheet_id = NEW.sheet_id
           AND operation_row.operation_id = NEW.operation_id
      ) OR EXISTS (
        SELECT 1
          FROM public.meta_record_history_operations operation_row
         WHERE operation_row.sheet_id = NEW.sheet_id
           AND operation_row.endpoint_seq = NEW.endpoint_seq
      ) THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_snapshot_reservation_identity_conflict';
      END IF;

      RETURN NEW;
    END $$`, next: `CREATE OR REPLACE FUNCTION public.meta_recovery_archive_snapshot_reservation_guard_row()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $$
    DECLARE
      parent_row record;
      expected_section text;
    BEGIN
      IF TG_OP IN ('UPDATE', 'DELETE') THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_snapshot_reservation_immutable';
      END IF;

      expected_section := (ARRAY[
        'schema', 'records', 'links', 'field_value_tombstones', 'link_tombstones',
        'auto_number', 'attachments_index', 'permission_evidence', 'views_config'
      ]::text[])[NEW.ordinal];

      IF NEW.generation_id IS NULL
         OR NEW.sheet_id IS NULL
         OR length(btrim(NEW.sheet_id)) = 0
         OR NEW.source_vector_hash IS NULL
         OR NEW.source_vector_hash !~ '^[0-9a-f]{64}$'
         OR NEW.owner_kind IS NULL
         OR length(btrim(NEW.owner_kind)) = 0
         OR NEW.owner_id IS NULL
         OR length(btrim(NEW.owner_id)) = 0
         OR NEW.owner_fence IS NULL
         OR NEW.owner_fence < 1
         OR NEW.operation_id IS NULL
         OR NEW.endpoint_seq IS NULL
         OR NEW.endpoint_seq < 1
         OR NEW.created_at IS NULL
         OR NOT (
           (
             NEW.reservation_kind IN ('section_bootstrap', 'section_checkpoint') AND
             NEW.ordinal BETWEEN 1 AND 9 AND
             NEW.section_kind IS NOT DISTINCT FROM expected_section
           ) OR (
             NEW.reservation_kind = 'archive_snapshot' AND
             NEW.ordinal = 10 AND
             NEW.section_kind IS NULL
           )
         ) THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'recovery_archive_snapshot_reservation_shape_invalid';
      END IF;

      SELECT archive.sheet_id, archive.source_vector_hash, archive.owner_kind, archive.owner_id,
             archive.owner_fence, archive.state, archive.build_status, archive.coverage_status
        INTO parent_row
        FROM public.meta_recovery_archives archive
       WHERE archive.generation_id = NEW.generation_id
       FOR KEY SHARE;

      IF NOT FOUND
         OR parent_row.sheet_id IS DISTINCT FROM NEW.sheet_id
         OR parent_row.source_vector_hash IS DISTINCT FROM NEW.source_vector_hash
         OR parent_row.owner_kind IS DISTINCT FROM NEW.owner_kind
         OR parent_row.owner_id IS DISTINCT FROM NEW.owner_id
         OR parent_row.owner_fence IS DISTINCT FROM NEW.owner_fence
         OR parent_row.state IS DISTINCT FROM 'building'
         OR parent_row.build_status IS DISTINCT FROM 'active'
         OR parent_row.coverage_status IS DISTINCT FROM 'incomplete' THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_snapshot_reservation_parent_invalid';
      END IF;

      IF EXISTS (
        SELECT 1
          FROM public.meta_record_history_operations operation_row
         WHERE operation_row.sheet_id = NEW.sheet_id
           AND operation_row.operation_id = NEW.operation_id
      ) OR EXISTS (
        SELECT 1
          FROM public.meta_record_history_operations operation_row
         WHERE operation_row.sheet_id = NEW.sheet_id
           AND operation_row.endpoint_seq = NEW.endpoint_seq
      ) THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_snapshot_reservation_identity_conflict';
      END IF;

      IF NEW.reservation_kind = 'section_checkpoint' AND NOT EXISTS (
          SELECT 1 FROM public.meta_recovery_archive_section_bootstrap_markers marker
          JOIN public.meta_record_history_operations genesis
            ON genesis.sheet_id=marker.sheet_id AND genesis.operation_id=marker.snapshot_operation_id
          WHERE marker.sheet_id=NEW.sheet_id AND marker.generation_id<>NEW.generation_id
            AND genesis.operation_kind='archive_snapshot' AND genesis.event_contract_version=2
            AND genesis.event_count=0 AND genesis.component_count=9
            AND genesis.endpoint_seq<NEW.endpoint_seq
        ) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='recovery_archive_checkpoint_genesis_required';
      END IF;
      RETURN NEW;
    END $$` },
  { name: 'meta_recovery_archive_snapshot_reservation_guard_set', old: `CREATE OR REPLACE FUNCTION public.meta_recovery_archive_snapshot_reservation_guard_set()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $$
    DECLARE
      row_count integer;
      section_count integer;
      parent_count integer;
      max_section_seq bigint;
      parent_seq bigint;
    BEGIN
      SELECT count(*)::integer,
             count(*) FILTER (WHERE reservation_kind = 'section_bootstrap')::integer,
             count(*) FILTER (WHERE reservation_kind = 'archive_snapshot')::integer,
             max(endpoint_seq) FILTER (WHERE reservation_kind = 'section_bootstrap'),
             max(endpoint_seq) FILTER (WHERE reservation_kind = 'archive_snapshot')
        INTO row_count, section_count, parent_count, max_section_seq, parent_seq
        FROM public.meta_recovery_archive_snapshot_reservations
       WHERE generation_id = NEW.generation_id;

      IF row_count <> 10
         OR section_count <> 9
         OR parent_count <> 1
         OR max_section_seq IS NULL
         OR parent_seq IS NULL
         OR parent_seq <= max_section_seq THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'recovery_archive_snapshot_reservation_set_invalid';
      END IF;

      RETURN NULL;
    END $$`, next: `CREATE OR REPLACE FUNCTION public.meta_recovery_archive_snapshot_reservation_guard_set()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $$
    DECLARE
      row_count integer;
      section_count integer;
      parent_count integer;
      max_section_seq bigint;
      parent_seq bigint;
    BEGIN
      SELECT count(*)::integer,
             count(*) FILTER (WHERE reservation_kind IN ('section_bootstrap', 'section_checkpoint'))::integer,
             count(*) FILTER (WHERE reservation_kind = 'archive_snapshot')::integer,
             max(endpoint_seq) FILTER (WHERE reservation_kind IN ('section_bootstrap', 'section_checkpoint')),
             max(endpoint_seq) FILTER (WHERE reservation_kind = 'archive_snapshot')
        INTO row_count, section_count, parent_count, max_section_seq, parent_seq
        FROM public.meta_recovery_archive_snapshot_reservations
       WHERE generation_id = NEW.generation_id;

      IF (SELECT count(DISTINCT reservation_kind) FROM public.meta_recovery_archive_snapshot_reservations
          WHERE generation_id=NEW.generation_id AND ordinal BETWEEN 1 AND 9) <> 1
         OR row_count <> 10
         OR section_count <> 9
         OR parent_count <> 1
         OR max_section_seq IS NULL
         OR parent_seq IS NULL
         OR parent_seq <= max_section_seq THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'recovery_archive_snapshot_reservation_set_invalid';
      END IF;

      RETURN NULL;
    END $$` },
  { name: 'meta_recovery_archives_claim_anchor_guard_row', old: `CREATE OR REPLACE FUNCTION public.meta_recovery_archives_claim_anchor_guard_row()
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
      reservation_count integer;
      reservation_parent_match_count integer;
      reservation_authority_generation_id uuid;
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

        SELECT count(*)::integer
          INTO reservation_count
          FROM public.meta_recovery_archive_snapshot_reservations reservation
         WHERE reservation.generation_id = NEW.generation_id;

        IF reservation_count = 10 THEN
          reservation_authority_generation_id := NEW.generation_id;
        ELSIF reservation_count = 0 THEN
          SELECT reservation.generation_id
            INTO reservation_authority_generation_id
            FROM public.meta_recovery_archive_snapshot_reservations reservation
            JOIN public.meta_recovery_archives authority
              ON authority.generation_id = reservation.generation_id
           WHERE reservation.sheet_id = NEW.sheet_id
             AND reservation.source_vector_hash = NEW.source_vector_hash
             AND reservation.ordinal = 10
             AND reservation.reservation_kind = 'archive_snapshot'
             AND reservation.section_kind IS NULL
             AND reservation.operation_id = NEW.anchor_operation_id
             AND reservation.endpoint_seq = NEW.anchor_seq
             AND authority.generation_id <> NEW.generation_id
             AND authority.workspace_id = NEW.workspace_id
             AND authority.base_id = NEW.base_id
             AND authority.sheet_id = NEW.sheet_id
             AND authority.anchor_operation_id = NEW.anchor_operation_id
             AND authority.anchor_seq = NEW.anchor_seq
             AND authority.checkpoint_id = NEW.checkpoint_id
             AND authority.format_version = NEW.format_version
             AND authority.source_vector_hash = NEW.source_vector_hash
             AND authority.state IN ('verified', 'expired')
             AND authority.build_status = 'finalized'
             AND authority.coverage_status = 'complete';

          IF NOT FOUND THEN
            RAISE EXCEPTION USING
              ERRCODE = '23514',
              MESSAGE = 'recovery_archive_claim_anchor_parent_unsealed';
          END IF;
        ELSE
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'recovery_archive_claim_anchor_parent_unsealed';
        END IF;

        SELECT count(*)::integer,
               count(*) FILTER (
                 WHERE reservation.ordinal = 10
                   AND reservation.reservation_kind = 'archive_snapshot'
                   AND reservation.section_kind IS NULL
                   AND reservation.sheet_id = NEW.sheet_id
                   AND reservation.source_vector_hash = NEW.source_vector_hash
                   AND reservation.operation_id = NEW.anchor_operation_id
                   AND reservation.endpoint_seq = NEW.anchor_seq
               )::integer
          INTO reservation_count, reservation_parent_match_count
          FROM public.meta_recovery_archive_snapshot_reservations reservation
         WHERE reservation.generation_id = reservation_authority_generation_id;

        IF reservation_count <> 10 OR reservation_parent_match_count <> 1 THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'recovery_archive_claim_anchor_parent_unsealed';
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
            ON reservation.generation_id = reservation_authority_generation_id
           AND reservation.ordinal = member_row.ordinal
           AND reservation.sheet_id = NEW.sheet_id
           AND reservation.source_vector_hash = NEW.source_vector_hash
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
    $claim_anchor_row$;`, next: `CREATE OR REPLACE FUNCTION public.meta_recovery_archives_claim_anchor_guard_row()
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
      reservation_count integer;
      reservation_parent_match_count integer;
      reservation_authority_generation_id uuid;
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

        SELECT count(*)::integer
          INTO reservation_count
          FROM public.meta_recovery_archive_snapshot_reservations reservation
         WHERE reservation.generation_id = NEW.generation_id;

        IF reservation_count = 10 THEN
          reservation_authority_generation_id := NEW.generation_id;
        ELSIF reservation_count = 0 THEN
          SELECT reservation.generation_id
            INTO reservation_authority_generation_id
            FROM public.meta_recovery_archive_snapshot_reservations reservation
            JOIN public.meta_recovery_archives authority
              ON authority.generation_id = reservation.generation_id
           WHERE reservation.sheet_id = NEW.sheet_id
             AND reservation.source_vector_hash = NEW.source_vector_hash
             AND reservation.ordinal = 10
             AND reservation.reservation_kind = 'archive_snapshot'
             AND reservation.section_kind IS NULL
             AND reservation.operation_id = NEW.anchor_operation_id
             AND reservation.endpoint_seq = NEW.anchor_seq
             AND authority.generation_id <> NEW.generation_id
             AND authority.workspace_id = NEW.workspace_id
             AND authority.base_id = NEW.base_id
             AND authority.sheet_id = NEW.sheet_id
             AND authority.anchor_operation_id = NEW.anchor_operation_id
             AND authority.anchor_seq = NEW.anchor_seq
             AND authority.checkpoint_id = NEW.checkpoint_id
             AND authority.format_version = NEW.format_version
             AND authority.source_vector_hash = NEW.source_vector_hash
             AND authority.state IN ('verified', 'expired')
             AND authority.build_status = 'finalized'
             AND authority.coverage_status = 'complete';

          IF NOT FOUND THEN
            RAISE EXCEPTION USING
              ERRCODE = '23514',
              MESSAGE = 'recovery_archive_claim_anchor_parent_unsealed';
          END IF;
        ELSE
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'recovery_archive_claim_anchor_parent_unsealed';
        END IF;

        SELECT count(*)::integer,
               count(*) FILTER (
                 WHERE reservation.ordinal = 10
                   AND reservation.reservation_kind = 'archive_snapshot'
                   AND reservation.section_kind IS NULL
                   AND reservation.sheet_id = NEW.sheet_id
                   AND reservation.source_vector_hash = NEW.source_vector_hash
                   AND reservation.operation_id = NEW.anchor_operation_id
                   AND reservation.endpoint_seq = NEW.anchor_seq
               )::integer
          INTO reservation_count, reservation_parent_match_count
          FROM public.meta_recovery_archive_snapshot_reservations reservation
         WHERE reservation.generation_id = reservation_authority_generation_id;

        IF reservation_count <> 10 OR reservation_parent_match_count <> 1 THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'recovery_archive_claim_anchor_parent_unsealed';
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
                   AND reservation.reservation_kind IN ('section_bootstrap', 'section_checkpoint')
                   AND reservation.section_kind = member_row.section_kind
                   AND reservation.operation_id = member_row.source_operation_id
                   AND reservation.endpoint_seq = member_row.source_head_seq
                   AND member_row.source_head_kind = reservation.reservation_kind
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
            ON reservation.generation_id = reservation_authority_generation_id
           AND reservation.ordinal = member_row.ordinal
           AND reservation.sheet_id = NEW.sheet_id
           AND reservation.source_vector_hash = NEW.source_vector_hash
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
    $claim_anchor_row$;` },
] as const

const CONSTRAINTS = [
  { name: 'chk_mrho_operation_kind', table: 'meta_record_history_operations', old: `operation_kind IN (
          'ordinary',
          'section_bootstrap',
          'archive_snapshot',
          'restore_chunk',
          'restore_aggregate'
        )`, next: `operation_kind IN (
          'ordinary',
          'section_bootstrap', 'section_checkpoint',
          'archive_snapshot',
          'restore_chunk',
          'restore_aggregate'
        )` },
  { name: 'chk_mrho_event_contract', table: 'meta_record_history_operations', old: `(
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
        )`, next: `(
          event_contract_version = 1
          AND operation_kind = 'ordinary'
          AND component_count IS NULL
          AND event_count >= 1
        ) OR (
          event_contract_version = 2
          AND operation_kind IN ('ordinary', 'section_bootstrap', 'section_checkpoint', 'restore_chunk')
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
        )` },
  { name: 'chk_mssr_action', table: 'meta_sheet_section_revisions', old: `action IN ('bootstrap_snapshot', 'upsert', 'delete')`, next: `action IN ('bootstrap_snapshot', 'checkpoint_snapshot', 'upsert', 'delete')` },
  { name: 'chk_mssr_records_bootstrap', table: 'meta_sheet_section_revisions', old: `section_kind <> 'records' OR action = 'bootstrap_snapshot'`, next: `section_kind <> 'records' OR action IN ('bootstrap_snapshot', 'checkpoint_snapshot')` },
  { name: 'chk_mssr_payload_or_tombstone', table: 'meta_sheet_section_revisions', old: `(
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
        )`, next: `((
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
        )) OR (
 action='checkpoint_snapshot' AND payload IS NOT NULL AND tombstone IS NULL
 AND entity_key='section/' || section_kind AND jsonb_typeof(payload)='object'
 AND payload ? 'row_count' AND payload ? 'source_hash'
 AND jsonb_typeof(payload->'row_count')='string'
 AND jsonb_typeof(payload->'source_hash')='string'
 AND payload->>'row_count' ~ '^(0|[1-9][0-9]*)$'
 AND payload->>'source_hash' ~ '^[0-9a-f]{64}$'
 AND payload - 'row_count' - 'source_hash' = '{}'::jsonb
)` },
  { name: 'chk_mrhsm_source_head_kind', table: 'meta_record_history_snapshot_members', old: `source_head_kind IN ('section_bootstrap', 'ordinary', 'restore_chunk', 'restore_aggregate')`, next: `source_head_kind IN ('section_bootstrap', 'section_checkpoint', 'ordinary', 'restore_chunk', 'restore_aggregate')` },
  { name: 'chk_mrasr_shape', table: 'meta_recovery_archive_snapshot_reservations', old: `(
          reservation_kind = 'section_bootstrap' AND
          ordinal BETWEEN 1 AND 9 AND
          section_kind IN (
            'schema', 'records', 'links', 'field_value_tombstones', 'link_tombstones',
            'auto_number', 'attachments_index', 'permission_evidence', 'views_config'
          )
        ) OR (
          reservation_kind = 'archive_snapshot' AND
          ordinal = 10 AND
          section_kind IS NULL
        )`, next: `(
          reservation_kind IN ('section_bootstrap', 'section_checkpoint') AND
          ordinal BETWEEN 1 AND 9 AND
          section_kind IS NOT NULL AND section_kind IN (
            'schema', 'records', 'links', 'field_value_tombstones', 'link_tombstones',
            'auto_number', 'attachments_index', 'permission_evidence', 'views_config'
          )
        ) OR (
          reservation_kind = 'archive_snapshot' AND
          ordinal = 10 AND
          section_kind IS NULL
        )` },
] as const

const PREREQUISITES = [
  { name: 'meta_recovery_archive_section_bootstrap_marker_guard_row', definition: `CREATE FUNCTION public.meta_recovery_archive_section_bootstrap_marker_guard_row()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $$
    DECLARE
      parent_row record;
    BEGIN
      IF TG_OP IN ('UPDATE', 'DELETE') THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_section_bootstrap_marker_immutable';
      END IF;

      IF NEW.sheet_id IS NULL
         OR length(btrim(NEW.sheet_id)) = 0
         OR NEW.generation_id IS NULL
         OR NEW.snapshot_operation_id IS NULL
         OR NEW.source_vector_hash IS NULL
         OR NEW.source_vector_hash !~ '^[0-9a-f]{64}$'
         OR NEW.initialized_at IS NULL THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'recovery_archive_section_bootstrap_marker_shape_invalid';
      END IF;

      SELECT archive.sheet_id, archive.source_vector_hash, archive.state,
             archive.build_status, archive.coverage_status,
             reservation.operation_id
        INTO parent_row
        FROM public.meta_recovery_archives archive
        JOIN public.meta_recovery_archive_snapshot_reservations reservation
          ON reservation.generation_id = archive.generation_id
         AND reservation.reservation_kind = 'archive_snapshot'
       WHERE archive.generation_id = NEW.generation_id
       FOR KEY SHARE OF archive, reservation;

      IF NOT FOUND
         OR parent_row.sheet_id IS DISTINCT FROM NEW.sheet_id
         OR parent_row.source_vector_hash IS DISTINCT FROM NEW.source_vector_hash
         OR parent_row.state IS DISTINCT FROM 'building'
         OR parent_row.build_status IS DISTINCT FROM 'active'
         OR parent_row.coverage_status IS DISTINCT FROM 'incomplete'
         OR parent_row.operation_id IS DISTINCT FROM NEW.snapshot_operation_id THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_section_bootstrap_marker_parent_invalid';
      END IF;

      RETURN NEW;
    END $$` },
  { name: 'meta_recovery_archive_section_bootstrap_marker_guard_truncate', definition: `CREATE FUNCTION public.meta_recovery_archive_section_bootstrap_marker_guard_truncate()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM public.meta_recovery_archive_section_bootstrap_markers LIMIT 1
      ) THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'recovery_archive_section_bootstrap_marker_immutable';
      END IF;
      RETURN NULL;
    END $$` },
] as const

const TRIGGERS = [
  ['meta_recovery_archive_section_bootstrap_markers', 'trg_mrasbm_guard_row', 'meta_recovery_archive_section_bootstrap_marker_guard_row', 31, false],
  ['meta_recovery_archive_section_bootstrap_markers', 'trg_mrasbm_guard_truncate', 'meta_recovery_archive_section_bootstrap_marker_guard_truncate', 34, false],
  ['meta_sheet_section_revisions', 'trg_mssr_guard_row', 'meta_sheet_section_revisions_guard_row', 31, false],
  ['meta_record_history_operations', 'trg_mrho_validate_endpoint', 'meta_record_history_operations_validate_endpoint', 7, false],
  ['meta_recovery_archive_snapshot_reservations', 'trg_mrasr_guard_row', 'meta_recovery_archive_snapshot_reservation_guard_row', 31, false],
  ['meta_recovery_archive_snapshot_reservations', 'trg_mrasr_guard_set', 'meta_recovery_archive_snapshot_reservation_guard_set', 5, true],
  ['meta_recovery_archives', 'trg_meta_recovery_archives_claim_anchor_guard_row', 'meta_recovery_archives_claim_anchor_guard_row', 31, false],
] as const

function drift(): never {
  throw new Error('RECOVERY_ARCHIVE_CHECKPOINT_SCHEMA_DRIFT')
}

function body(definition: string): string {
  const delimiter = /\bAS\s+(\$[a-z_]*\$)/.exec(definition)?.[1]
  if (!delimiter) return drift()
  const pieces = definition.split(delimiter)
  if (pieces.length !== 3) return drift()
  return pieces[1]!.trim()
}

async function phase(db: Kysely<unknown>): Promise<'old' | 'next'> {
  let current: 'old' | 'next' | undefined
  for (const definition of [...FUNCTIONS, ...PREREQUISITES.map((entry) => ({ name: entry.name, old: entry.definition, next: entry.definition }))]) {
    const result = await sql<{
      prosrc: string; language: string; result: string; prosecdef: boolean; proconfig: string[] | null
    }>`SELECT p.prosrc, l.lanname AS language, p.prorettype::regtype::text AS result,
              p.prosecdef, p.proconfig
       FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
       JOIN pg_catalog.pg_language l ON l.oid=p.prolang
       WHERE n.nspname='public' AND p.proname=${definition.name} AND p.pronargs=0`.execute(db)
    const row = result.rows[0]
    if (result.rows.length !== 1 || !row || row.language !== 'plpgsql' || row.result !== 'trigger'
        || row.prosecdef || JSON.stringify(row.proconfig) !== JSON.stringify(['search_path=pg_catalog, public'])) drift()
    const found = row.prosrc.trim() === body(definition.old) ? 'old'
      : row.prosrc.trim() === body(definition.next) ? 'next' : drift()
    if (definition.old === definition.next) continue
    if (current !== undefined && current !== found) drift()
    current = found
  }
  return current ?? drift()
}

async function audit(db: Kysely<unknown>, expected: 'old' | 'next'): Promise<void> {
  for (const [table, trigger, fn, type, deferred] of TRIGGERS) {
    const rows = await sql<{ valid: boolean }>`
      SELECT (t.tgenabled='O' AND t.tgtype=${type} AND t.tgqual IS NULL
        AND t.tgattr::text='' AND t.tgdeferrable=${deferred} AND t.tginitdeferred=${deferred}
        AND p.proname=${fn} AND pn.nspname='public') AS valid
      FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
      JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace
      WHERE n.nspname='public' AND c.relname=${table} AND t.tgname=${trigger}
        AND NOT t.tgisinternal`.execute(db)
    if (rows.rows.length !== 1 || rows.rows[0]?.valid !== true) drift()
  }
  // Ask PostgreSQL to canonicalize the expected expression. Never normalize quoted
  // literals in CHECK bodies, and never repair a same-name weakened constraint.
  for (const [index, definition] of CONSTRAINTS.entries()) {
    const temp = 'tm_checkpoint_expected_' + index
    await sql.raw('CREATE TEMP TABLE ' + temp + ' (LIKE public.' + definition.table + ') ON COMMIT DROP').execute(db)
    try {
      await sql.raw('ALTER TABLE pg_temp.' + temp + ' ADD CONSTRAINT expected CHECK (' + definition[expected] + ')').execute(db)
      const result = await sql<{ valid: boolean }>`
        SELECT (actual.contype='c' AND actual.convalidated AND NOT actual.connoinherit
          AND pg_catalog.pg_get_constraintdef(actual.oid)=pg_catalog.pg_get_constraintdef(wanted.oid)) AS valid
        FROM pg_catalog.pg_constraint actual
        JOIN pg_catalog.pg_constraint wanted ON wanted.conrelid=pg_catalog.to_regclass(${'pg_temp.' + temp})
          AND wanted.conname='expected'
        WHERE actual.conrelid=pg_catalog.to_regclass(${'public.' + definition.table})
          AND actual.conname=${definition.name}`.execute(db)
      if (result.rows.length !== 1 || result.rows[0]?.valid !== true) drift()
    } finally {
      await sql.raw('DROP TABLE pg_temp.' + temp).execute(db)
    }
  }
}

async function install(db: Kysely<unknown>, target: 'old' | 'next'): Promise<void> {
  for (const definition of CONSTRAINTS) {
    await sql.raw('ALTER TABLE public.' + definition.table + ' DROP CONSTRAINT ' + definition.name
      + ', ADD CONSTRAINT ' + definition.name + ' CHECK (' + definition[target] + ')').execute(db)
  }
  for (const definition of FUNCTIONS) await sql.raw(definition[target]).execute(db)
}

async function lock(db: Kysely<unknown>): Promise<void> {
  await sql`LOCK TABLE public.meta_recovery_archives, public.meta_recovery_archive_snapshot_reservations,
    public.meta_recovery_archive_section_bootstrap_markers, public.meta_sheet_section_revisions,
    public.meta_record_history_operations, public.meta_record_history_snapshot_members
    IN ACCESS EXCLUSIVE MODE`.execute(db)
}

/** The migration runner supplies one transaction; direct callers must do the same. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await lock(db)
  const current = await phase(db)
  await audit(db, current)
  if (current === 'next') return
  await install(db, 'next')
  await audit(db, 'next')
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await lock(db)
  const current = await phase(db)
  await audit(db, current)
  if (current === 'old') return
  const result = await sql<{ in_use: boolean }>`SELECT
    EXISTS (SELECT 1 FROM public.meta_recovery_archive_snapshot_reservations WHERE reservation_kind='section_checkpoint')
    OR EXISTS (SELECT 1 FROM public.meta_sheet_section_revisions WHERE action='checkpoint_snapshot')
    OR EXISTS (SELECT 1 FROM public.meta_record_history_operations WHERE operation_kind='section_checkpoint')
    OR EXISTS (SELECT 1 FROM public.meta_record_history_snapshot_members WHERE source_head_kind='section_checkpoint')
    AS in_use`.execute(db)
  if (result.rows[0]?.in_use !== false) throw new Error('RECOVERY_ARCHIVE_CHECKPOINT_DOWN_IN_USE')
  await install(db, 'old')
  await audit(db, 'old')
}
