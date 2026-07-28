/**
 * W4C-0 (#4556) — contracts and durable storage: schema/migrations + SQL functions (Stage A).
 *
 * Authority: docs/development/attendance-issue-4556-w4-segment-calculation-design-lock-20260724.md
 * (RATIFIED, sections 7.1/7.1a/7.2/7.3/7.4/7.5/7.9/9/11/12.1) plus the RATIFIED identity-proof
 * amendment docs/development/attendance-issue-4556-w4c0-identity-proof-amendment-20260725.md
 * (closed source matrix, durable reconstruction fields, SQL UUIDv5 boundary verification).
 *
 * Creates (no caller cutover; existing runtime behavior unchanged):
 *  - attendance_result_operation_batches / attendance_result_operations (durable batch/item
 *    operation registries, section 7.1) with closed enums, per-source-kind proof-shape
 *    constraints, derived-ID equality via the canonical SQL UUIDv5 function, the
 *    claimed->completed|canceled transition guard, DELETE/TRUNCATE refusal, and the
 *    DEFERRABLE INITIALLY DEFERRED commit-time rejection of persisted `claimed` rows;
 *  - attendance_result_event_outbox (section 7.1a) with immutable identity/payload and the
 *    guarded pending->delivered delivery state machine;
 *  - attendance_request_calculation_snapshots (section 7.2, append-only) plus the referenced
 *    UNIQUE (id, org_id) key on attendance_requests;
 *  - attendance_record_calculations / attendance_record_segments (sections 7.3/7.4, append-only)
 *    plus the referenced UNIQUE (id, org_id) key on attendance_records, lineage version-order
 *    trigger, and deferred parent-and-child segment-count constraint triggers;
 *  - attendance_records parent pointer/owner/visibility/reason columns + constraint trigger
 *    (section 7.5) and the canonical current-record view (section 7.6 schema surface only);
 *  - attendance_import_rollback_closures (section 7.9 append-only witness);
 *  - attendance_calculation_rollout_state / attendance_calculation_rollout_events (section 9)
 *    with the closed legal-transition guard;
 *  - attendance_import_jobs W4 V1 frozen identity/posture/proof-vector columns under the
 *    null-all-or-V1-complete shape constraint, closed execution_reason_code pairing, partial
 *    unique reservation backstop, and frozen-field immutability trigger (section 7.1 P07).
 *
 * House rules honored: zzzz naming (touches zzzz-created attendance tables), idempotent up(),
 * down() = success only on empty W4 surfaces / populated => fail-closed BEFORE any DDL
 * (section 11), no backtick characters inside SQL text, values-free trigger errors
 * (op/table/constraint names only — never row values).
 */
import type { Kysely } from 'kysely'
import { sql } from 'kysely'

// ---------------------------------------------------------------------------
// Closed enum sets (lock sections 4.1, 4.2, 6, 7, 9, 10.1 + amendment 1.1).
// ---------------------------------------------------------------------------

const COMMAND_ENTRYPOINTS = [
  'live_punch',
  'request_create',
  'request_pending_edit',
  'request_decision',
  'request_cancel',
  'import_batch',
  'integration_batch',
  'scheduled',
  'manual_edit',
  'recompute',
  'import_rollback',
  'ops_retirement',
] as const

const CALCULATION_ENTRYPOINTS = [
  'live',
  'legacy_import',
  'integration_sync',
  'correction',
  'approved_leave',
  'approved_overtime',
  'outdoor_approval',
  'manual_override',
  'recompute',
  'scheduled',
  'approval_reversal',
  'import_rollback',
  'ops_retirement',
] as const

const ITEM_SOURCE_KINDS = [
  'direct_live_punch',
  'direct_request_create',
  'direct_request_pending_edit',
  'direct_request_decision',
  'direct_request_cancel',
  'direct_manual_edit',
  'direct_recompute',
  'direct_import_rollback',
  'direct_ops_retirement',
  'verified_delivery',
  'import_item',
  'integration_item',
  'scheduled',
] as const

const BATCH_SOURCE_KINDS = ['import_batch', 'integration_batch'] as const

const ACTOR_POSTURES = [
  'self',
  'platform_admin',
  'attendance_admin',
  'delegated_import',
  'scheduler',
  'approval_system',
  'operator',
] as const

const CAPABILITIES = [
  'punch',
  'import',
  'scheduled',
  'approval_apply',
  'manual_edit',
  'recompute',
  'rollback',
  'retirement',
] as const

const WRITE_POSTURES = ['legacy_projection_only', 'shadow', 'authoritative'] as const

const OPERATION_STATES = ['claimed', 'completed', 'canceled'] as const

const OUTCOMES = ['baseline', 'completed', 'review_required', 'reversed'] as const

const REVIEW_REASONS = [
  'ambiguous_segment_match',
  'duplicate_check_in',
  'duplicate_check_out',
  'dst_gap_local_time',
  'dst_fold_shared_boundary_ambiguous',
  'invalid_timezone',
  'invalid_segment_order',
  'invalid_evidence_order',
  'overlapping_actual_intervals',
  'evidence_outside_attribution_window',
  'missing_frozen_context',
  'legacy_attribution_not_upgradeable',
  'frozen_evidence_unavailable',
  'context_resolution_ambiguous',
  'context_mismatch',
  'input_schema_invalid',
  'legacy_time_ingress_not_authoritative',
  'approved_fact_conflict',
  'manual_override_invalid',
  'import_metric_conflict',
] as const

const OUTCOME_REASONS = [
  'calculated',
  'shadow_only',
  'legacy_projection_baseline',
  ...REVIEW_REASONS,
  'import_rollback_reversal',
  'operator_retirement',
] as const

const MERGE_POLICIES = ['append', 'merge', 'override', 'reversal', 'retire'] as const

const CALCULATION_TIERS = ['legacy_shadow', 'segment_authoritative'] as const

const PROJECTION_EFFECTS = ['none', 'set_active', 'set_retired'] as const

const SEGMENT_STATUSES = [
  'normal',
  'late',
  'early_leave',
  'late_early',
  'missing_check_in',
  'missing_check_out',
  'missing_both',
] as const

const SEGMENT_REASONS = [
  'within_window',
  'late_check_in',
  'early_check_out',
  'missing_check_in',
  'missing_check_out',
  'missing_both',
  'approved_correction_applied',
  'approved_leave_overlay',
  'approved_overtime_overlay',
  'dst_fold_start_earlier',
  'dst_fold_end_later',
] as const

const SHADOW_DIFF_CODES = [
  'equal',
  'expected_break_exclusion',
  'status_changed',
  'work_minutes_mismatch',
  'late_minutes_mismatch',
  'early_leave_minutes_mismatch',
  'missing_boundary_mismatch',
  'work_date_mismatch',
  'context_mismatch',
  'input_mismatch',
  'review_required',
  'legacy_uncomparable',
] as const

// Matches the existing attendance_records_status_check daily union (the compatibility
// projection is what legacy writers persist into attendance_records; 'off' days are not
// persisted rows at the pinned baseline).
const DAILY_STATUSES = ['normal', 'late', 'early_leave', 'late_early', 'partial', 'absent', 'adjusted'] as const

const ROLLOUT_STATES = ['legacy', 'shadow', 'eligible', 'authoritative', 'suspended'] as const

const VISIBILITY_REASONS = ['active', 'review_placeholder', 'import_rollback', 'operator_retirement'] as const

const EXECUTION_REASON_CODES = ['SEGMENT_CALCULATION_SUSPENDED', 'ATTENDANCE_ASYNC_JOB_POSTURE_CONFLICT'] as const

// Section 7.1a closed event-kind allowlist: the W4-covered source operations (P01-P28 command
// paths) that currently reach emitEvent. Stage C's generated reachable-inventory must reconcile
// this list before the slice PR is finalized (see HANDOFF-W4C0.md).
const OUTBOX_EVENT_KINDS = [
  'attendance.punched',
  'attendance.requested',
  'attendance.request.updated',
  'attendance.request.cancelled',
  'attendance.resolved',
  'attendance.outdoorPunch.requested',
] as const

// Amendment section 1.3 / lock section 4.1: the three literal namespace UUIDs.
const ATTENDANCE_IMPORT_ITEM_NAMESPACE_V1 = '6f67fdaa-e2aa-48b3-b76c-c4aab9723173'
const ATTENDANCE_INTEGRATION_ITEM_NAMESPACE_V1 = '46501375-c273-459f-a5af-f926859f6411'
const ATTENDANCE_SCHEDULED_OPERATION_NAMESPACE_V1 = 'e4363171-f53f-47d7-a074-607ef3fad391'

function sqlList(values: readonly string[]): string {
  return values.map((v) => "'" + v + "'").join(', ')
}

// ---------------------------------------------------------------------------
// up()
// ---------------------------------------------------------------------------

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  // -------------------------------------------------------------------------
  // 1. Canonical SQL functions (amendment 1.3: one immutable PostgreSQL UUIDv5
  //    function via pgcrypto digest sha1; namespace UUID bytes + ASCII/NUL name
  //    bytes; version 5 + RFC 4122 variant bits).
  // -------------------------------------------------------------------------
  await sql`
    CREATE OR REPLACE FUNCTION attendance_w4_uuidv5(ns uuid, name_bytes bytea)
    RETURNS uuid
    LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
    AS $fn$
    DECLARE
      h bytea;
    BEGIN
      h := substring(digest(uuid_send(ns) || name_bytes, 'sha1') from 1 for 16);
      h := set_byte(h, 6, (get_byte(h, 6) & 15) | 80);
      h := set_byte(h, 8, (get_byte(h, 8) & 63) | 128);
      RETURN encode(h, 'hex')::uuid;
    END;
    $fn$
  `.execute(db)

  // Immutable canonical YYYY-MM-DD text for a date (to_char is only STABLE; this
  // lpad/extract construction is locale-independent and IMMUTABLE).
  await sql`
    CREATE OR REPLACE FUNCTION attendance_w4_canonical_date_text(d date)
    RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $fn$
      SELECT lpad((extract(year from d))::int::text, 4, '0') || '-' ||
             lpad((extract(month from d))::int::text, 2, '0') || '-' ||
             lpad((extract(day from d))::int::text, 2, '0')
    $fn$
  `.execute(db)

  // Name-byte builders (lock section 4.1: canonical lowercase UUID text, base-10
  // unsigned ordinal, lowercase sha256 hex, NUL separators).
  await sql`
    CREATE OR REPLACE FUNCTION attendance_w4_item_name_bytes(root uuid, ordinal integer, semantic_fp text)
    RETURNS bytea
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $fn$
      SELECT convert_to(root::text, 'UTF8') || decode('00', 'hex') ||
             convert_to(ordinal::text, 'UTF8') || decode('00', 'hex') ||
             convert_to(semantic_fp, 'UTF8')
    $fn$
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION attendance_w4_scheduled_name_bytes(run_id uuid, user_id uuid, work_date date)
    RETURNS bytea
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $fn$
      SELECT convert_to(run_id::text, 'UTF8') || decode('00', 'hex') ||
             convert_to(user_id::text, 'UTF8') || decode('00', 'hex') ||
             convert_to(attendance_w4_canonical_date_text(work_date), 'UTF8')
    $fn$
  `.execute(db)

  // Segment reason arrays: non-empty, closed values, bytewise-ascending sorted, unique
  // (lock section 6.1 — closed at the DB layer too).
  await sql`
    CREATE OR REPLACE FUNCTION attendance_w4_segment_reasons_valid(arr jsonb)
    RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
    AS $fn$
    DECLARE
      n integer;
      i integer;
      cur text;
      prev text := NULL;
    BEGIN
      IF jsonb_typeof(arr) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
      n := jsonb_array_length(arr);
      IF n < 1 THEN RETURN false; END IF;
      FOR i IN 0..(n - 1) LOOP
        IF jsonb_typeof(arr -> i) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
        cur := arr ->> i;
        IF cur NOT IN (${sql.raw(sqlList(SEGMENT_REASONS))}) THEN RETURN false; END IF;
        IF prev IS NOT NULL AND NOT ((cur COLLATE "C") > (prev COLLATE "C")) THEN RETURN false; END IF;
        prev := cur;
      END LOOP;
      RETURN true;
    END;
    $fn$
  `.execute(db)

  // P07 job identity proof vector (amendment 1.3): ordered exact-key entries
  // { ordinal, semanticFingerprint, derivedOperationId, commandFingerprint }, ordinal equal
  // to position, fingerprints 64 lowercase hex, derived operation ID re-verified through the
  // canonical SQL UUIDv5 function under the source-kind namespace.
  await sql`
    CREATE OR REPLACE FUNCTION attendance_w4_job_proof_vector_valid(
      source_kind text,
      root uuid,
      vector jsonb,
      item_count integer
    )
    RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
    AS $fn$
    DECLARE
      ns uuid;
      n integer;
      i integer;
      entry jsonb;
      key_count integer;
      semantic_fp text;
      command_fp text;
      derived text;
    BEGIN
      IF source_kind IS NULL OR root IS NULL OR vector IS NULL OR item_count IS NULL THEN RETURN false; END IF;
      IF source_kind = 'import_batch' THEN
        ns := ${sql.lit(ATTENDANCE_IMPORT_ITEM_NAMESPACE_V1)}::uuid;
      ELSIF source_kind = 'integration_batch' THEN
        ns := ${sql.lit(ATTENDANCE_INTEGRATION_ITEM_NAMESPACE_V1)}::uuid;
      ELSE
        RETURN false;
      END IF;
      IF jsonb_typeof(vector) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
      n := jsonb_array_length(vector);
      IF n <> item_count OR n < 1 THEN RETURN false; END IF;
      FOR i IN 0..(n - 1) LOOP
        entry := vector -> i;
        IF jsonb_typeof(entry) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
        SELECT count(*) INTO key_count FROM jsonb_object_keys(entry) AS t(k);
        IF key_count <> 4 THEN RETURN false; END IF;
        IF NOT (entry ?& ARRAY['ordinal', 'semanticFingerprint', 'derivedOperationId', 'commandFingerprint']) THEN
          RETURN false;
        END IF;
        IF jsonb_typeof(entry -> 'ordinal') IS DISTINCT FROM 'number' THEN RETURN false; END IF;
        IF (entry ->> 'ordinal') IS DISTINCT FROM i::text THEN RETURN false; END IF;
        IF jsonb_typeof(entry -> 'semanticFingerprint') IS DISTINCT FROM 'string' THEN RETURN false; END IF;
        IF jsonb_typeof(entry -> 'derivedOperationId') IS DISTINCT FROM 'string' THEN RETURN false; END IF;
        IF jsonb_typeof(entry -> 'commandFingerprint') IS DISTINCT FROM 'string' THEN RETURN false; END IF;
        semantic_fp := entry ->> 'semanticFingerprint';
        command_fp := entry ->> 'commandFingerprint';
        derived := entry ->> 'derivedOperationId';
        IF semantic_fp !~ '^[0-9a-f]{64}$' THEN RETURN false; END IF;
        IF command_fp !~ '^[0-9a-f]{64}$' THEN RETURN false; END IF;
        IF derived IS DISTINCT FROM attendance_w4_uuidv5(ns, attendance_w4_item_name_bytes(root, i, semantic_fp))::text THEN
          RETURN false;
        END IF;
      END LOOP;
      RETURN true;
    END;
    $fn$
  `.execute(db)

  // Shared values-free deny function (append-only / immutable surfaces).
  await sql`
    CREATE OR REPLACE FUNCTION attendance_w4_deny_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    BEGIN
      RAISE EXCEPTION 'W4C0_IMMUTABLE: % is not permitted on %', TG_OP, TG_TABLE_NAME
        USING ERRCODE = 'raise_exception';
    END;
    $fn$
  `.execute(db)

  // -------------------------------------------------------------------------
  // 2. Referenced unique keys on existing parents (sections 7.2/7.3).
  // -------------------------------------------------------------------------
  await sql`
    DO $do$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_attendance_records_id_org') THEN
        ALTER TABLE attendance_records ADD CONSTRAINT uq_attendance_records_id_org UNIQUE (id, org_id);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_attendance_requests_id_org') THEN
        ALTER TABLE attendance_requests ADD CONSTRAINT uq_attendance_requests_id_org UNIQUE (id, org_id);
      END IF;
    END
    $do$
  `.execute(db)

  // -------------------------------------------------------------------------
  // 3. Durable operation registries (section 7.1 + amendment 1.1/1.3).
  // -------------------------------------------------------------------------
  await sql`
    CREATE TABLE IF NOT EXISTS attendance_result_operation_batches (
      org_id text NOT NULL,
      entrypoint text NOT NULL,
      batch_command_id uuid NOT NULL,
      identity_source_kind text NOT NULL,
      source_root_id uuid NOT NULL,
      source_ref text NOT NULL,
      actor_id text NOT NULL,
      actor_posture text NOT NULL,
      token_subject_user_id text,
      capability text NOT NULL,
      subject_scope jsonb NOT NULL,
      accepted_write_posture text NOT NULL,
      command_fingerprint text NOT NULL,
      item_count integer NOT NULL,
      item_sequence_fingerprint text NOT NULL,
      item_set_fingerprint text NOT NULL,
      state text NOT NULL,
      response_snapshot jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      version integer NOT NULL DEFAULT 1,
      CONSTRAINT pk_attendance_result_operation_batches PRIMARY KEY (org_id, entrypoint, batch_command_id),
      CONSTRAINT chk_arob_entrypoint CHECK (entrypoint IN (${sql.raw(sqlList(BATCH_SOURCE_KINDS))})),
      CONSTRAINT chk_arob_source_kind CHECK (identity_source_kind IN (${sql.raw(sqlList(BATCH_SOURCE_KINDS))})),
      CONSTRAINT chk_arob_entrypoint_source_pair CHECK (entrypoint = identity_source_kind),
      CONSTRAINT chk_arob_root_is_command CHECK (batch_command_id = source_root_id),
      CONSTRAINT chk_arob_actor_posture CHECK (actor_posture IN (${sql.raw(sqlList(ACTOR_POSTURES))})),
      CONSTRAINT chk_arob_capability CHECK (capability IN (${sql.raw(sqlList(CAPABILITIES))})),
      CONSTRAINT chk_arob_write_posture CHECK (accepted_write_posture IN (${sql.raw(sqlList(WRITE_POSTURES))})),
      CONSTRAINT chk_arob_command_fp CHECK (command_fingerprint ~ '^[0-9a-f]{64}$'),
      CONSTRAINT chk_arob_item_count CHECK (item_count >= 1),
      CONSTRAINT chk_arob_seq_fp CHECK (item_sequence_fingerprint ~ '^[0-9a-f]{64}$'),
      CONSTRAINT chk_arob_set_fp CHECK (item_set_fingerprint ~ '^[0-9a-f]{64}$'),
      CONSTRAINT chk_arob_state CHECK (state IN (${sql.raw(sqlList(OPERATION_STATES))})),
      CONSTRAINT chk_arob_completed_response CHECK (state <> 'completed' OR response_snapshot IS NOT NULL),
      CONSTRAINT chk_arob_claimed_no_response CHECK (state <> 'claimed' OR response_snapshot IS NULL),
      CONSTRAINT chk_arob_version CHECK (version >= 1)
    )
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS attendance_result_operations (
      org_id text NOT NULL,
      entrypoint text NOT NULL,
      operation_id uuid NOT NULL,
      batch_command_id uuid,
      input_ordinal integer,
      identity_source_kind text NOT NULL,
      source_root_id uuid,
      proof_semantic_fingerprint text,
      proof_user_id uuid,
      proof_work_date date,
      source_ref text NOT NULL,
      actor_id text NOT NULL,
      actor_posture text NOT NULL,
      token_subject_user_id text,
      capability text NOT NULL,
      subject_scope jsonb NOT NULL,
      command_fingerprint text NOT NULL,
      accepted_write_posture text NOT NULL,
      state text NOT NULL,
      resolved_record_id uuid,
      resolved_calculation_id uuid,
      resolved_request_id uuid,
      result_semantic_fingerprint text,
      result_provenance_fingerprint text,
      normalized_business_input_snapshot jsonb,
      response_snapshot jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      version integer NOT NULL DEFAULT 1,
      CONSTRAINT pk_attendance_result_operations PRIMARY KEY (org_id, entrypoint, operation_id),
      CONSTRAINT fk_aro_batch FOREIGN KEY (org_id, entrypoint, batch_command_id)
        REFERENCES attendance_result_operation_batches (org_id, entrypoint, batch_command_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT chk_aro_entrypoint CHECK (entrypoint IN (${sql.raw(sqlList(COMMAND_ENTRYPOINTS))})),
      CONSTRAINT chk_aro_source_kind CHECK (identity_source_kind IN (${sql.raw(sqlList(ITEM_SOURCE_KINDS))})),
      CONSTRAINT chk_aro_actor_posture CHECK (actor_posture IN (${sql.raw(sqlList(ACTOR_POSTURES))})),
      CONSTRAINT chk_aro_capability CHECK (capability IN (${sql.raw(sqlList(CAPABILITIES))})),
      CONSTRAINT chk_aro_write_posture CHECK (accepted_write_posture IN (${sql.raw(sqlList(WRITE_POSTURES))})),
      CONSTRAINT chk_aro_state CHECK (state IN (${sql.raw(sqlList(OPERATION_STATES))})),
      CONSTRAINT chk_aro_command_fp CHECK (command_fingerprint ~ '^[0-9a-f]{64}$'),
      CONSTRAINT chk_aro_proof_semantic_fp CHECK (proof_semantic_fingerprint IS NULL OR proof_semantic_fingerprint ~ '^[0-9a-f]{64}$'),
      CONSTRAINT chk_aro_result_semantic_fp CHECK (result_semantic_fingerprint IS NULL OR result_semantic_fingerprint ~ '^[0-9a-f]{64}$'),
      CONSTRAINT chk_aro_result_provenance_fp CHECK (result_provenance_fingerprint IS NULL OR result_provenance_fingerprint ~ '^[0-9a-f]{64}$'),
      CONSTRAINT chk_aro_input_ordinal CHECK (input_ordinal IS NULL OR input_ordinal >= 0),
      -- Amendment 1.1 closed source matrix: entrypoint <-> identity_source_kind pairing.
      CONSTRAINT chk_aro_entrypoint_source_pair CHECK (
        (identity_source_kind = 'direct_live_punch' AND entrypoint = 'live_punch') OR
        (identity_source_kind = 'direct_request_create' AND entrypoint = 'request_create') OR
        (identity_source_kind = 'direct_request_pending_edit' AND entrypoint = 'request_pending_edit') OR
        (identity_source_kind = 'direct_request_decision' AND entrypoint = 'request_decision') OR
        (identity_source_kind = 'direct_request_cancel' AND entrypoint = 'request_cancel') OR
        (identity_source_kind = 'direct_manual_edit' AND entrypoint = 'manual_edit') OR
        (identity_source_kind = 'direct_recompute' AND entrypoint = 'recompute') OR
        (identity_source_kind = 'direct_import_rollback' AND entrypoint = 'import_rollback') OR
        (identity_source_kind = 'direct_ops_retirement' AND entrypoint = 'ops_retirement') OR
        (identity_source_kind = 'verified_delivery' AND entrypoint = 'request_decision') OR
        (identity_source_kind = 'import_item' AND entrypoint = 'import_batch') OR
        (identity_source_kind = 'integration_item' AND entrypoint = 'integration_batch') OR
        (identity_source_kind = 'scheduled' AND entrypoint = 'scheduled')
      ),
      -- Amendment 1.3: exactly the scalar proof fields for the selected source kind;
      -- partial or extra proof fields are rejected.
      CONSTRAINT chk_aro_proof_shape CHECK (
        (identity_source_kind LIKE 'direct_%' AND source_root_id IS NULL AND input_ordinal IS NULL
          AND proof_semantic_fingerprint IS NULL AND proof_user_id IS NULL AND proof_work_date IS NULL
          AND batch_command_id IS NULL) OR
        (identity_source_kind = 'verified_delivery' AND source_root_id IS NOT NULL AND source_root_id = operation_id
          AND input_ordinal IS NULL AND proof_semantic_fingerprint IS NULL AND proof_user_id IS NULL
          AND proof_work_date IS NULL AND batch_command_id IS NULL) OR
        (identity_source_kind IN ('import_item', 'integration_item') AND source_root_id IS NOT NULL
          AND input_ordinal IS NOT NULL AND proof_semantic_fingerprint IS NOT NULL
          AND proof_user_id IS NULL AND proof_work_date IS NULL
          AND batch_command_id IS NOT NULL AND batch_command_id = source_root_id) OR
        (identity_source_kind = 'scheduled' AND source_root_id IS NOT NULL AND proof_user_id IS NOT NULL
          AND proof_work_date IS NOT NULL AND input_ordinal IS NULL AND proof_semantic_fingerprint IS NULL
          AND batch_command_id IS NULL)
      ),
      -- Amendment 1.3: derived-ID equality through the canonical SQL UUIDv5 function.
      CONSTRAINT chk_aro_derived_identity CHECK (
        CASE identity_source_kind
          WHEN 'import_item' THEN operation_id = attendance_w4_uuidv5(
            ${sql.lit(ATTENDANCE_IMPORT_ITEM_NAMESPACE_V1)}::uuid,
            attendance_w4_item_name_bytes(source_root_id, input_ordinal, proof_semantic_fingerprint))
          WHEN 'integration_item' THEN operation_id = attendance_w4_uuidv5(
            ${sql.lit(ATTENDANCE_INTEGRATION_ITEM_NAMESPACE_V1)}::uuid,
            attendance_w4_item_name_bytes(source_root_id, input_ordinal, proof_semantic_fingerprint))
          WHEN 'scheduled' THEN operation_id = attendance_w4_uuidv5(
            ${sql.lit(ATTENDANCE_SCHEDULED_OPERATION_NAMESPACE_V1)}::uuid,
            attendance_w4_scheduled_name_bytes(source_root_id, proof_user_id, proof_work_date))
          ELSE true
        END
      ),
      -- Section 7.1: only import/integration items persist the normalized business
      -- input snapshot; it is mandatory once such an item completes.
      CONSTRAINT chk_aro_business_snapshot_scope CHECK (
        identity_source_kind IN ('import_item', 'integration_item') OR normalized_business_input_snapshot IS NULL
      ),
      CONSTRAINT chk_aro_business_snapshot_completed CHECK (
        NOT (identity_source_kind IN ('import_item', 'integration_item') AND state = 'completed')
        OR normalized_business_input_snapshot IS NOT NULL
      ),
      CONSTRAINT chk_aro_completed_response CHECK (state <> 'completed' OR response_snapshot IS NOT NULL),
      CONSTRAINT chk_aro_claimed_shape CHECK (
        state <> 'claimed' OR (response_snapshot IS NULL AND result_semantic_fingerprint IS NULL AND result_provenance_fingerprint IS NULL)
      ),
      CONSTRAINT chk_aro_version CHECK (version >= 1)
    )
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_aro_batch_ref
    ON attendance_result_operations (org_id, entrypoint, batch_command_id)
    WHERE batch_command_id IS NOT NULL
  `.execute(db)

  // -------------------------------------------------------------------------
  // 4. Transactional event outbox (section 7.1a).
  // -------------------------------------------------------------------------
  await sql`
    CREATE TABLE IF NOT EXISTS attendance_result_event_outbox (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      entrypoint text NOT NULL,
      operation_id uuid NOT NULL,
      event_kind text NOT NULL,
      payload jsonb NOT NULL,
      payload_schema_version integer NOT NULL,
      business_key_fingerprint text NOT NULL,
      delivery_state text NOT NULL DEFAULT 'pending',
      attempts integer NOT NULL DEFAULT 0,
      next_attempt_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      delivered_at timestamptz,
      CONSTRAINT uq_areo_identity UNIQUE (org_id, entrypoint, operation_id, event_kind),
      CONSTRAINT chk_areo_entrypoint CHECK (entrypoint IN (${sql.raw(sqlList(COMMAND_ENTRYPOINTS))})),
      CONSTRAINT chk_areo_event_kind CHECK (event_kind IN (${sql.raw(sqlList(OUTBOX_EVENT_KINDS))})),
      CONSTRAINT chk_areo_schema_version CHECK (payload_schema_version >= 1),
      CONSTRAINT chk_areo_business_key_fp CHECK (business_key_fingerprint ~ '^[0-9a-f]{64}$'),
      CONSTRAINT chk_areo_delivery_state CHECK (delivery_state IN ('pending', 'delivered')),
      CONSTRAINT chk_areo_attempts CHECK (attempts >= 0),
      CONSTRAINT chk_areo_delivered_pair CHECK ((delivery_state = 'delivered') = (delivered_at IS NOT NULL))
    )
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_areo_pending
    ON attendance_result_event_outbox (next_attempt_at, created_at)
    WHERE delivery_state = 'pending'
  `.execute(db)

  // -------------------------------------------------------------------------
  // 5. Append-only request snapshots (section 7.2).
  // -------------------------------------------------------------------------
  await sql`
    CREATE TABLE IF NOT EXISTS attendance_request_calculation_snapshots (
      org_id text NOT NULL,
      request_id uuid NOT NULL,
      version integer NOT NULL,
      request_type text NOT NULL,
      subject_user_id text NOT NULL,
      payload jsonb NOT NULL,
      payload_fingerprint text NOT NULL,
      attribution_snapshot jsonb NOT NULL,
      context_snapshot jsonb,
      created_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT pk_attendance_request_calculation_snapshots PRIMARY KEY (org_id, request_id, version),
      CONSTRAINT fk_arcs_request FOREIGN KEY (request_id, org_id)
        REFERENCES attendance_requests (id, org_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT chk_arcs_version CHECK (version >= 1),
      CONSTRAINT chk_arcs_payload_fp CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$')
    )
  `.execute(db)

  // Indexed but deliberately NOT unique (section 7.2: A -> B -> A appends version 3).
  await sql`
    CREATE INDEX IF NOT EXISTS idx_arcs_payload_fingerprint
    ON attendance_request_calculation_snapshots (org_id, request_id, payload_fingerprint)
  `.execute(db)

  // -------------------------------------------------------------------------
  // 6. Immutable calculations (section 7.3).
  // -------------------------------------------------------------------------
  await sql`
    CREATE TABLE IF NOT EXISTS attendance_record_calculations (
      id uuid NOT NULL,
      org_id text NOT NULL,
      attendance_record_id uuid NOT NULL,
      version integer NOT NULL,
      calculation_kind text NOT NULL,
      mode text NOT NULL,
      entrypoint text NOT NULL,
      engine_version text NOT NULL,
      snapshot_schema_version integer NOT NULL,
      supersedes_calculation_id uuid,
      restores_calculation_id uuid,
      source_batch_id uuid,
      operation_id uuid,
      semantic_input_fingerprint char(64) NOT NULL,
      provenance_fingerprint char(64) NOT NULL,
      source_definition_fingerprint char(64),
      attribution_snapshot jsonb NOT NULL,
      context_snapshot jsonb,
      segment_snapshot jsonb NOT NULL,
      evidence_snapshot jsonb NOT NULL,
      approved_facts_snapshot jsonb NOT NULL,
      manual_override_snapshot jsonb,
      input_provenance jsonb NOT NULL,
      merge_policy text NOT NULL,
      calculation_tier text NOT NULL,
      outcome text NOT NULL,
      outcome_reason_code text NOT NULL,
      projection_effect text NOT NULL,
      expected_segment_count integer NOT NULL,
      projected_status text,
      projected_first_in_at timestamptz,
      projected_last_out_at timestamptz,
      projected_work_minutes integer,
      projected_late_minutes integer,
      projected_early_leave_minutes integer,
      projected_daily_fingerprint text,
      parent_preimage_snapshot jsonb,
      shadow_diff_code text,
      shadow_diff jsonb,
      actor_id text NOT NULL,
      correlation_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT pk_attendance_record_calculations PRIMARY KEY (id),
      CONSTRAINT uq_arc_record_version UNIQUE (attendance_record_id, version),
      CONSTRAINT uq_arc_id_record_org UNIQUE (id, attendance_record_id, org_id),
      CONSTRAINT fk_arc_record FOREIGN KEY (attendance_record_id, org_id)
        REFERENCES attendance_records (id, org_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT fk_arc_supersedes FOREIGN KEY (supersedes_calculation_id, attendance_record_id, org_id)
        REFERENCES attendance_record_calculations (id, attendance_record_id, org_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT fk_arc_restores FOREIGN KEY (restores_calculation_id, attendance_record_id, org_id)
        REFERENCES attendance_record_calculations (id, attendance_record_id, org_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT chk_arc_version CHECK (version >= 1),
      CONSTRAINT chk_arc_kind CHECK (calculation_kind IN ('legacy_baseline', 'calculation', 'reversal')),
      CONSTRAINT chk_arc_mode CHECK (mode IN ('shadow', 'authoritative')),
      CONSTRAINT chk_arc_entrypoint CHECK (entrypoint IN (${sql.raw(sqlList(CALCULATION_ENTRYPOINTS))})),
      CONSTRAINT chk_arc_semantic_fp CHECK (semantic_input_fingerprint ~ '^[0-9a-f]{64}$'),
      CONSTRAINT chk_arc_provenance_fp CHECK (provenance_fingerprint ~ '^[0-9a-f]{64}$'),
      CONSTRAINT chk_arc_source_def_fp CHECK (source_definition_fingerprint IS NULL OR source_definition_fingerprint ~ '^[0-9a-f]{64}$'),
      CONSTRAINT chk_arc_merge_policy CHECK (merge_policy IN (${sql.raw(sqlList(MERGE_POLICIES))})),
      CONSTRAINT chk_arc_tier CHECK (calculation_tier IN (${sql.raw(sqlList(CALCULATION_TIERS))})),
      CONSTRAINT chk_arc_outcome CHECK (outcome IN (${sql.raw(sqlList(OUTCOMES))})),
      CONSTRAINT chk_arc_outcome_reason CHECK (outcome_reason_code IN (${sql.raw(sqlList(OUTCOME_REASONS))})),
      -- Section 6.2 exact outcome/reason pairing.
      CONSTRAINT chk_arc_outcome_reason_pair CHECK (
        (outcome = 'baseline' AND outcome_reason_code = 'legacy_projection_baseline') OR
        (outcome = 'completed' AND outcome_reason_code IN ('calculated', 'shadow_only')) OR
        (outcome = 'reversed' AND outcome_reason_code IN ('import_rollback_reversal', 'operator_retirement')) OR
        (outcome = 'review_required' AND outcome_reason_code IN (${sql.raw(sqlList(REVIEW_REASONS))}))
      ),
      CONSTRAINT chk_arc_kind_outcome_pair CHECK (
        (calculation_kind = 'legacy_baseline' AND outcome = 'baseline') OR
        (calculation_kind = 'reversal' AND outcome = 'reversed') OR
        (calculation_kind = 'calculation' AND outcome IN ('completed', 'review_required'))
      ),
      CONSTRAINT chk_arc_projection_effect CHECK (projection_effect IN (${sql.raw(sqlList(PROJECTION_EFFECTS))})),
      CONSTRAINT chk_arc_expected_count CHECK (expected_segment_count BETWEEN 0 AND 3),
      -- operation_id is null only for the internal legacy baseline (section 7.3).
      CONSTRAINT chk_arc_operation_id CHECK (
        (calculation_kind = 'legacy_baseline' AND operation_id IS NULL) OR
        (calculation_kind <> 'legacy_baseline' AND operation_id IS NOT NULL)
      ),
      CONSTRAINT chk_arc_no_self_supersedes CHECK (supersedes_calculation_id IS NULL OR supersedes_calculation_id <> id),
      CONSTRAINT chk_arc_no_self_restores CHECK (restores_calculation_id IS NULL OR restores_calculation_id <> id),
      CONSTRAINT chk_arc_baseline_shape CHECK (
        calculation_kind <> 'legacy_baseline' OR (
          supersedes_calculation_id IS NULL AND restores_calculation_id IS NULL AND
          projection_effect = 'none' AND projected_daily_fingerprint IS NOT NULL
        )
      ),
      CONSTRAINT chk_arc_normal_no_restore CHECK (calculation_kind <> 'calculation' OR restores_calculation_id IS NULL),
      CONSTRAINT chk_arc_reversal_supersedes CHECK (calculation_kind <> 'reversal' OR supersedes_calculation_id IS NOT NULL),
      CONSTRAINT chk_arc_shadow_effect CHECK (mode <> 'shadow' OR projection_effect = 'none'),
      CONSTRAINT chk_arc_review_shape CHECK (
        outcome <> 'review_required' OR (
          projection_effect = 'none' AND expected_segment_count = 0 AND
          projected_status IS NULL AND projected_first_in_at IS NULL AND projected_last_out_at IS NULL AND
          projected_work_minutes IS NULL AND projected_late_minutes IS NULL AND projected_early_leave_minutes IS NULL
        )
      ),
      CONSTRAINT chk_arc_completed_shape CHECK (
        NOT (calculation_kind = 'calculation' AND outcome = 'completed') OR (
          expected_segment_count BETWEEN 1 AND 3 AND context_snapshot IS NOT NULL AND
          (attribution_snapshot ->> 'posture') = 'resolved_v2' AND
          projected_status IS NOT NULL AND projected_work_minutes IS NOT NULL AND
          projected_late_minutes IS NOT NULL AND projected_early_leave_minutes IS NOT NULL
        )
      ),
      CONSTRAINT chk_arc_zero_children_kinds CHECK (
        outcome NOT IN ('baseline', 'reversed') OR expected_segment_count = 0
      ),
      CONSTRAINT chk_arc_authoritative_completed_effect CHECK (
        NOT (mode = 'authoritative' AND outcome = 'completed') OR projection_effect = 'set_active'
      ),
      CONSTRAINT chk_arc_authoritative_reversed_effect CHECK (
        NOT (mode = 'authoritative' AND outcome = 'reversed') OR projection_effect IN ('set_active', 'set_retired')
      ),
      -- Section 7.3: context/source-definition fingerprint nullable only for unsupported review.
      CONSTRAINT chk_arc_context_nullability CHECK (context_snapshot IS NOT NULL OR outcome = 'review_required'),
      CONSTRAINT chk_arc_source_def_nullability CHECK (source_definition_fingerprint IS NOT NULL OR outcome = 'review_required'),
      CONSTRAINT chk_arc_projected_status CHECK (projected_status IS NULL OR projected_status IN (${sql.raw(sqlList(DAILY_STATUSES))})),
      CONSTRAINT chk_arc_projected_minutes CHECK (
        (projected_work_minutes IS NULL OR projected_work_minutes >= 0) AND
        (projected_late_minutes IS NULL OR projected_late_minutes >= 0) AND
        (projected_early_leave_minutes IS NULL OR projected_early_leave_minutes >= 0)
      ),
      CONSTRAINT chk_arc_projected_daily_fp CHECK (projected_daily_fingerprint IS NULL OR projected_daily_fingerprint ~ '^[0-9a-f]{64}$'),
      CONSTRAINT chk_arc_shadow_diff_code CHECK (shadow_diff_code IS NULL OR shadow_diff_code IN (${sql.raw(sqlList(SHADOW_DIFF_CODES))})),
      CONSTRAINT chk_arc_segment_snapshot_array CHECK (jsonb_typeof(segment_snapshot) = 'array'),
      CONSTRAINT chk_arc_evidence_snapshot_array CHECK (jsonb_typeof(evidence_snapshot) = 'array'),
      CONSTRAINT chk_arc_approved_facts_array CHECK (jsonb_typeof(approved_facts_snapshot) = 'array')
    )
  `.execute(db)

  // Retries return the existing calculation and cannot allocate another version.
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_arc_operation
    ON attendance_record_calculations (org_id, entrypoint, operation_id)
    WHERE operation_id IS NOT NULL
  `.execute(db)

  // Baseline uniqueness (section 7.3) without consuming the external operation ID.
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_arc_baseline
    ON attendance_record_calculations (org_id, attendance_record_id, projected_daily_fingerprint)
    WHERE calculation_kind = 'legacy_baseline'
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_arc_record
    ON attendance_record_calculations (org_id, attendance_record_id, version)
  `.execute(db)

  // Lineage guard: supersedes/restores must point at a strictly lower version of the
  // same record/org (immediate; forward references, self references and cycles fail).
  await sql`
    CREATE OR REPLACE FUNCTION attendance_w4_calculation_lineage_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    DECLARE
      target_version integer;
    BEGIN
      IF NEW.supersedes_calculation_id IS NOT NULL THEN
        SELECT version INTO target_version FROM attendance_record_calculations
        WHERE id = NEW.supersedes_calculation_id
          AND attendance_record_id = NEW.attendance_record_id
          AND org_id = NEW.org_id;
        IF target_version IS NULL THEN
          RAISE EXCEPTION 'W4C0_LINEAGE: supersedes target missing on %', TG_TABLE_NAME;
        END IF;
        IF target_version >= NEW.version THEN
          RAISE EXCEPTION 'W4C0_LINEAGE: supersedes target version is not strictly lower on %', TG_TABLE_NAME;
        END IF;
      END IF;
      IF NEW.restores_calculation_id IS NOT NULL THEN
        SELECT version INTO target_version FROM attendance_record_calculations
        WHERE id = NEW.restores_calculation_id
          AND attendance_record_id = NEW.attendance_record_id
          AND org_id = NEW.org_id;
        IF target_version IS NULL THEN
          RAISE EXCEPTION 'W4C0_LINEAGE: restores target missing on %', TG_TABLE_NAME;
        END IF;
        IF target_version >= NEW.version THEN
          RAISE EXCEPTION 'W4C0_LINEAGE: restores target version is not strictly lower on %', TG_TABLE_NAME;
        END IF;
      END IF;
      RETURN NEW;
    END;
    $fn$
  `.execute(db)

  await sql`DROP TRIGGER IF EXISTS trg_arc_lineage_guard ON attendance_record_calculations`.execute(db)
  await sql`
    CREATE TRIGGER trg_arc_lineage_guard
      BEFORE INSERT ON attendance_record_calculations
      FOR EACH ROW EXECUTE FUNCTION attendance_w4_calculation_lineage_guard()
  `.execute(db)

  // -------------------------------------------------------------------------
  // 7. Immutable segments (section 7.4).
  // -------------------------------------------------------------------------
  await sql`
    CREATE TABLE IF NOT EXISTS attendance_record_segments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      record_id uuid NOT NULL,
      calculation_id uuid NOT NULL,
      segment_index integer NOT NULL,
      expected_start_at timestamptz NOT NULL,
      expected_end_at timestamptz NOT NULL,
      actual_in_at timestamptz,
      actual_out_at timestamptz,
      work_minutes integer NOT NULL,
      late_minutes integer NOT NULL,
      early_leave_minutes integer NOT NULL,
      status text NOT NULL,
      status_reasons jsonb NOT NULL,
      matched_evidence_refs jsonb NOT NULL,
      unmatched_evidence_refs jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT uq_ars_calculation_index UNIQUE (calculation_id, segment_index),
      CONSTRAINT fk_ars_calculation FOREIGN KEY (calculation_id, record_id, org_id)
        REFERENCES attendance_record_calculations (id, attendance_record_id, org_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT chk_ars_index CHECK (segment_index BETWEEN 0 AND 2),
      CONSTRAINT chk_ars_expected_order CHECK (expected_start_at < expected_end_at),
      CONSTRAINT chk_ars_minutes CHECK (work_minutes >= 0 AND late_minutes >= 0 AND early_leave_minutes >= 0),
      CONSTRAINT chk_ars_status CHECK (status IN (${sql.raw(sqlList(SEGMENT_STATUSES))})),
      CONSTRAINT chk_ars_status_reasons CHECK (attendance_w4_segment_reasons_valid(status_reasons)),
      CONSTRAINT chk_ars_matched_refs CHECK (jsonb_typeof(matched_evidence_refs) = 'array'),
      CONSTRAINT chk_ars_unmatched_refs CHECK (jsonb_typeof(unmatched_evidence_refs) = 'array')
    )
  `.execute(db)

  // Deferred parent-and-child count constraints (sections 7.4/12.1): a completed normal
  // calculation must have exactly expected_segment_count direct children at commit; every
  // other row must have zero. Checked from BOTH sides so a later extra child also fails.
  await sql`
    CREATE OR REPLACE FUNCTION attendance_w4_calculation_children_commit_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    DECLARE
      calc RECORD;
      required integer;
      actual integer;
    BEGIN
      SELECT calculation_kind, outcome, expected_segment_count INTO calc
      FROM attendance_record_calculations WHERE id = NEW.id;
      IF NOT FOUND THEN
        RETURN NULL;
      END IF;
      IF calc.calculation_kind = 'calculation' AND calc.outcome = 'completed' THEN
        required := calc.expected_segment_count;
      ELSE
        required := 0;
      END IF;
      SELECT count(*) INTO actual FROM attendance_record_segments WHERE calculation_id = NEW.id;
      IF actual <> required THEN
        RAISE EXCEPTION 'W4C0_SEGMENT_COUNT: calculation child count mismatch on %', TG_TABLE_NAME;
      END IF;
      RETURN NULL;
    END;
    $fn$
  `.execute(db)

  await sql`DROP TRIGGER IF EXISTS trg_arc_children_commit_guard ON attendance_record_calculations`.execute(db)
  await sql`
    CREATE CONSTRAINT TRIGGER trg_arc_children_commit_guard
      AFTER INSERT ON attendance_record_calculations
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION attendance_w4_calculation_children_commit_guard()
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION attendance_w4_segment_children_commit_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    DECLARE
      calc RECORD;
      required integer;
      actual integer;
    BEGIN
      SELECT calculation_kind, outcome, expected_segment_count INTO calc
      FROM attendance_record_calculations WHERE id = NEW.calculation_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'W4C0_SEGMENT_COUNT: segment parent calculation missing on %', TG_TABLE_NAME;
      END IF;
      IF calc.calculation_kind = 'calculation' AND calc.outcome = 'completed' THEN
        required := calc.expected_segment_count;
      ELSE
        required := 0;
      END IF;
      SELECT count(*) INTO actual FROM attendance_record_segments WHERE calculation_id = NEW.calculation_id;
      IF actual <> required THEN
        RAISE EXCEPTION 'W4C0_SEGMENT_COUNT: segment child count mismatch on %', TG_TABLE_NAME;
      END IF;
      RETURN NULL;
    END;
    $fn$
  `.execute(db)

  await sql`DROP TRIGGER IF EXISTS trg_ars_children_commit_guard ON attendance_record_segments`.execute(db)
  await sql`
    CREATE CONSTRAINT TRIGGER trg_ars_children_commit_guard
      AFTER INSERT ON attendance_record_segments
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION attendance_w4_segment_children_commit_guard()
  `.execute(db)

  // -------------------------------------------------------------------------
  // 8. Import rollback-closure witnesses (section 7.9, append-only).
  // -------------------------------------------------------------------------
  await sql`
    CREATE TABLE IF NOT EXISTS attendance_import_rollback_closures (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      batch_id uuid NOT NULL,
      batch_fingerprint text NOT NULL,
      actor_id text NOT NULL,
      actor_authorization_posture text NOT NULL,
      reason_code text NOT NULL,
      closed_at timestamptz NOT NULL DEFAULT now(),
      correlation_id text NOT NULL,
      CONSTRAINT uq_airc_org_batch UNIQUE (org_id, batch_id),
      CONSTRAINT chk_airc_batch_fp CHECK (batch_fingerprint ~ '^[0-9a-f]{64}$'),
      CONSTRAINT chk_airc_actor_posture CHECK (actor_authorization_posture IN (${sql.raw(sqlList(ACTOR_POSTURES))}))
    )
  `.execute(db)

  // -------------------------------------------------------------------------
  // 9. Rollout state machine (section 9): org-keyed state + append-only events.
  // -------------------------------------------------------------------------
  await sql`
    CREATE TABLE IF NOT EXISTS attendance_calculation_rollout_state (
      org_id text PRIMARY KEY,
      state text NOT NULL,
      engine_version text NOT NULL,
      reason_code text NOT NULL,
      actor_id text NOT NULL,
      changed_at timestamptz NOT NULL DEFAULT now(),
      version integer NOT NULL,
      prior_state text,
      scope text NOT NULL DEFAULT 'synthetic_staging',
      CONSTRAINT chk_acrs_state CHECK (state IN (${sql.raw(sqlList(ROLLOUT_STATES))})),
      CONSTRAINT chk_acrs_prior_state CHECK (prior_state IS NULL OR prior_state IN (${sql.raw(sqlList(ROLLOUT_STATES))})),
      CONSTRAINT chk_acrs_scope CHECK (scope = 'synthetic_staging'),
      CONSTRAINT chk_acrs_version CHECK (version >= 1)
    )
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS attendance_calculation_rollout_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      prior_state text,
      new_state text NOT NULL,
      reason_code text NOT NULL,
      engine_version text NOT NULL,
      actor_id text NOT NULL,
      evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT chk_acre_prior_state CHECK (prior_state IS NULL OR prior_state IN (${sql.raw(sqlList(ROLLOUT_STATES))})),
      CONSTRAINT chk_acre_new_state CHECK (new_state IN (${sql.raw(sqlList(ROLLOUT_STATES))}))
    )
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_acre_org_time
    ON attendance_calculation_rollout_events (org_id, created_at)
  `.execute(db)

  // Legal transitions only (section 9):
  // legacy->shadow, shadow->eligible|legacy, eligible->authoritative|shadow,
  // authoritative->suspended, suspended->authoritative.
  await sql`
    CREATE OR REPLACE FUNCTION attendance_w4_rollout_state_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NOT (
          (NEW.state = 'legacy' AND NEW.prior_state IS NULL) OR
          (NEW.state = 'shadow' AND NEW.prior_state = 'legacy')
        ) THEN
          RAISE EXCEPTION 'W4C0_ROLLOUT: illegal initial rollout state on %', TG_TABLE_NAME;
        END IF;
        IF NEW.version <> 1 THEN
          RAISE EXCEPTION 'W4C0_ROLLOUT: initial rollout version must be 1 on %', TG_TABLE_NAME;
        END IF;
        RETURN NEW;
      END IF;
      IF NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.scope IS DISTINCT FROM OLD.scope THEN
        RAISE EXCEPTION 'W4C0_ROLLOUT: rollout identity fields are immutable on %', TG_TABLE_NAME;
      END IF;
      IF NOT (
        (OLD.state = 'legacy' AND NEW.state = 'shadow') OR
        (OLD.state = 'shadow' AND NEW.state IN ('eligible', 'legacy')) OR
        (OLD.state = 'eligible' AND NEW.state IN ('authoritative', 'shadow')) OR
        (OLD.state = 'authoritative' AND NEW.state = 'suspended') OR
        (OLD.state = 'suspended' AND NEW.state = 'authoritative')
      ) THEN
        RAISE EXCEPTION 'W4C0_ROLLOUT: illegal rollout state transition on %', TG_TABLE_NAME;
      END IF;
      IF NEW.prior_state IS DISTINCT FROM OLD.state THEN
        RAISE EXCEPTION 'W4C0_ROLLOUT: prior_state must record the previous state on %', TG_TABLE_NAME;
      END IF;
      IF NEW.version IS DISTINCT FROM OLD.version + 1 THEN
        RAISE EXCEPTION 'W4C0_ROLLOUT: optimistic version must increment on %', TG_TABLE_NAME;
      END IF;
      RETURN NEW;
    END;
    $fn$
  `.execute(db)

  await sql`DROP TRIGGER IF EXISTS trg_acrs_state_guard ON attendance_calculation_rollout_state`.execute(db)
  await sql`
    CREATE TRIGGER trg_acrs_state_guard
      BEFORE INSERT OR UPDATE ON attendance_calculation_rollout_state
      FOR EACH ROW EXECUTE FUNCTION attendance_w4_rollout_state_guard()
  `.execute(db)

  // -------------------------------------------------------------------------
  // 10. Parent pointer/owner/visibility/reason (section 7.5) + current view (7.6).
  // -------------------------------------------------------------------------
  await sql`ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS current_calculation_id uuid`.execute(db)
  await sql`
    ALTER TABLE attendance_records
    ADD COLUMN IF NOT EXISTS projection_owner text NOT NULL DEFAULT 'legacy_untracked'
  `.execute(db)
  await sql`
    ALTER TABLE attendance_records
    ADD COLUMN IF NOT EXISTS visibility_state text NOT NULL DEFAULT 'active'
  `.execute(db)
  await sql`
    ALTER TABLE attendance_records
    ADD COLUMN IF NOT EXISTS visibility_reason text NOT NULL DEFAULT 'active'
  `.execute(db)

  await sql`
    DO $do$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_ar_projection_owner') THEN
        ALTER TABLE attendance_records ADD CONSTRAINT chk_ar_projection_owner
          CHECK (projection_owner IN ('legacy_untracked', 'w4'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_ar_visibility_state') THEN
        ALTER TABLE attendance_records ADD CONSTRAINT chk_ar_visibility_state
          CHECK (visibility_state IN ('active', 'retired'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_ar_visibility_reason') THEN
        ALTER TABLE attendance_records ADD CONSTRAINT chk_ar_visibility_reason
          CHECK (visibility_reason IN (${sql.raw(sqlList(VISIBILITY_REASONS))}));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_ar_owner_pointer_pair') THEN
        ALTER TABLE attendance_records ADD CONSTRAINT chk_ar_owner_pointer_pair
          CHECK ((projection_owner = 'legacy_untracked') = (current_calculation_id IS NULL));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_ar_visibility_pair') THEN
        ALTER TABLE attendance_records ADD CONSTRAINT chk_ar_visibility_pair
          CHECK (
            (visibility_state = 'active' AND visibility_reason = 'active') OR
            (visibility_state = 'retired' AND visibility_reason IN ('review_placeholder', 'import_rollback', 'operator_retirement'))
          );
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ar_current_calculation') THEN
        ALTER TABLE attendance_records ADD CONSTRAINT fk_ar_current_calculation
          FOREIGN KEY (current_calculation_id, id, org_id)
          REFERENCES attendance_record_calculations (id, attendance_record_id, org_id)
          ON DELETE RESTRICT ON UPDATE RESTRICT;
      END IF;
    END
    $do$
  `.execute(db)

  // Pointer/state constraint trigger (section 7.5). The WHEN clauses keep the pure-legacy
  // hot path (default tuple -> default tuple) trigger-free so existing runtime behavior and
  // cost stay unchanged.
  await sql`
    CREATE OR REPLACE FUNCTION attendance_w4_records_pointer_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    DECLARE
      calc RECORD;
    BEGIN
      IF NEW.projection_owner = 'legacy_untracked' THEN
        -- Once a baseline or an authoritative current-owning row exists, the parent can
        -- never return to legacy_untracked (review-only rows do not trigger this).
        IF EXISTS (
          SELECT 1 FROM attendance_record_calculations c
          WHERE c.attendance_record_id = NEW.id AND c.org_id = NEW.org_id
            AND (
              c.calculation_kind = 'legacy_baseline' OR
              (c.mode = 'authoritative' AND c.outcome IN ('completed', 'reversed') AND c.projection_effect <> 'none')
            )
        ) THEN
          RAISE EXCEPTION 'W4C0_POINTER: parent cannot return to legacy_untracked on %', TG_TABLE_NAME;
        END IF;
        -- legacy_untracked retired reasons are limited to review_placeholder/import_rollback.
        IF NEW.visibility_state = 'retired' AND NEW.visibility_reason = 'operator_retirement' THEN
          RAISE EXCEPTION 'W4C0_POINTER: operator retirement requires a W4 pointer on %', TG_TABLE_NAME;
        END IF;
        RETURN NULL;
      END IF;

      SELECT mode, outcome, outcome_reason_code, projection_effect, calculation_kind,
             projected_status, projected_first_in_at, projected_last_out_at,
             projected_work_minutes, projected_late_minutes, projected_early_leave_minutes
        INTO calc
      FROM attendance_record_calculations
      WHERE id = NEW.current_calculation_id
        AND attendance_record_id = NEW.id
        AND org_id = NEW.org_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'W4C0_POINTER: current calculation not found for parent on %', TG_TABLE_NAME;
      END IF;
      IF calc.mode <> 'authoritative' OR calc.outcome NOT IN ('completed', 'reversed') THEN
        RAISE EXCEPTION 'W4C0_POINTER: pointer target must be authoritative completed/reversed on %', TG_TABLE_NAME;
      END IF;
      IF calc.projection_effect = 'set_active' THEN
        IF NEW.visibility_state <> 'active' OR NEW.visibility_reason <> 'active' THEN
          RAISE EXCEPTION 'W4C0_POINTER: visibility does not match set_active on %', TG_TABLE_NAME;
        END IF;
      ELSIF calc.projection_effect = 'set_retired' THEN
        IF NEW.visibility_state <> 'retired' THEN
          RAISE EXCEPTION 'W4C0_POINTER: visibility does not match set_retired on %', TG_TABLE_NAME;
        END IF;
        IF NOT (
          (calc.outcome_reason_code = 'import_rollback_reversal' AND NEW.visibility_reason = 'import_rollback') OR
          (calc.outcome_reason_code = 'operator_retirement' AND NEW.visibility_reason = 'operator_retirement')
        ) THEN
          RAISE EXCEPTION 'W4C0_POINTER: retired visibility reason does not match selected row on %', TG_TABLE_NAME;
        END IF;
      ELSE
        RAISE EXCEPTION 'W4C0_POINTER: pointer target projection effect cannot be none on %', TG_TABLE_NAME;
      END IF;
      -- Every mutable W4-owned daily field equals the selected snapshot.
      IF NEW.status IS DISTINCT FROM calc.projected_status OR
         NEW.first_in_at IS DISTINCT FROM calc.projected_first_in_at OR
         NEW.last_out_at IS DISTINCT FROM calc.projected_last_out_at OR
         NEW.work_minutes IS DISTINCT FROM calc.projected_work_minutes OR
         NEW.late_minutes IS DISTINCT FROM calc.projected_late_minutes OR
         NEW.early_leave_minutes IS DISTINCT FROM calc.projected_early_leave_minutes THEN
        RAISE EXCEPTION 'W4C0_POINTER: W4-owned daily fields drifted from the selected snapshot on %', TG_TABLE_NAME;
      END IF;
      RETURN NULL;
    END;
    $fn$
  `.execute(db)

  await sql`DROP TRIGGER IF EXISTS trg_ar_pointer_guard_ins ON attendance_records`.execute(db)
  await sql`
    CREATE CONSTRAINT TRIGGER trg_ar_pointer_guard_ins
      AFTER INSERT ON attendance_records
      FOR EACH ROW
      WHEN (
        NEW.current_calculation_id IS NOT NULL OR
        NEW.projection_owner IS DISTINCT FROM 'legacy_untracked' OR
        NEW.visibility_state IS DISTINCT FROM 'active' OR
        NEW.visibility_reason IS DISTINCT FROM 'active'
      )
      EXECUTE FUNCTION attendance_w4_records_pointer_guard()
  `.execute(db)

  await sql`DROP TRIGGER IF EXISTS trg_ar_pointer_guard_upd ON attendance_records`.execute(db)
  await sql`
    CREATE CONSTRAINT TRIGGER trg_ar_pointer_guard_upd
      AFTER UPDATE ON attendance_records
      FOR EACH ROW
      WHEN (
        NEW.current_calculation_id IS NOT NULL OR OLD.current_calculation_id IS NOT NULL OR
        NEW.projection_owner IS DISTINCT FROM 'legacy_untracked' OR OLD.projection_owner IS DISTINCT FROM 'legacy_untracked' OR
        NEW.visibility_state IS DISTINCT FROM 'active' OR OLD.visibility_state IS DISTINCT FROM 'active' OR
        NEW.visibility_reason IS DISTINCT FROM 'active' OR OLD.visibility_reason IS DISTINCT FROM 'active'
      )
      EXECUTE FUNCTION attendance_w4_records_pointer_guard()
  `.execute(db)

  // Canonical current-record view (section 7.6 schema surface; consumer cutover is a
  // later slice — no existing reader is switched by this migration).
  await sql`
    CREATE OR REPLACE VIEW attendance_current_records AS
    SELECT * FROM attendance_records WHERE visibility_state = 'active'
  `.execute(db)

  // -------------------------------------------------------------------------
  // 11. Immutability boundary (section 7.7).
  // -------------------------------------------------------------------------

  // Append-only tables: reject UPDATE/DELETE/TRUNCATE.
  const appendOnlyTables = [
    'attendance_request_calculation_snapshots',
    'attendance_record_calculations',
    'attendance_record_segments',
    'attendance_import_rollback_closures',
    'attendance_calculation_rollout_events',
  ]
  for (const table of appendOnlyTables) {
    await sql`DROP TRIGGER IF EXISTS ${sql.raw('trg_' + table + '_deny_mutation')} ON ${sql.raw(table)}`.execute(db)
    await sql`
      CREATE TRIGGER ${sql.raw('trg_' + table + '_deny_mutation')}
        BEFORE UPDATE OR DELETE ON ${sql.raw(table)}
        FOR EACH ROW EXECUTE FUNCTION attendance_w4_deny_mutation()
    `.execute(db)
    await sql`DROP TRIGGER IF EXISTS ${sql.raw('trg_' + table + '_deny_truncate')} ON ${sql.raw(table)}`.execute(db)
    await sql`
      CREATE TRIGGER ${sql.raw('trg_' + table + '_deny_truncate')}
        BEFORE TRUNCATE ON ${sql.raw(table)}
        FOR EACH STATEMENT EXECUTE FUNCTION attendance_w4_deny_mutation()
    `.execute(db)
  }

  // Operation registries: DELETE/TRUNCATE refusal.
  for (const table of ['attendance_result_operation_batches', 'attendance_result_operations']) {
    await sql`DROP TRIGGER IF EXISTS ${sql.raw('trg_' + table + '_deny_delete')} ON ${sql.raw(table)}`.execute(db)
    await sql`
      CREATE TRIGGER ${sql.raw('trg_' + table + '_deny_delete')}
        BEFORE DELETE ON ${sql.raw(table)}
        FOR EACH ROW EXECUTE FUNCTION attendance_w4_deny_mutation()
    `.execute(db)
    await sql`DROP TRIGGER IF EXISTS ${sql.raw('trg_' + table + '_deny_truncate')} ON ${sql.raw(table)}`.execute(db)
    await sql`
      CREATE TRIGGER ${sql.raw('trg_' + table + '_deny_truncate')}
        BEFORE TRUNCATE ON ${sql.raw(table)}
        FOR EACH STATEMENT EXECUTE FUNCTION attendance_w4_deny_mutation()
    `.execute(db)
  }

  // Rollout state: transitions only; no DELETE/TRUNCATE.
  await sql`DROP TRIGGER IF EXISTS trg_acrs_deny_delete ON attendance_calculation_rollout_state`.execute(db)
  await sql`
    CREATE TRIGGER trg_acrs_deny_delete
      BEFORE DELETE ON attendance_calculation_rollout_state
      FOR EACH ROW EXECUTE FUNCTION attendance_w4_deny_mutation()
  `.execute(db)
  await sql`DROP TRIGGER IF EXISTS trg_acrs_deny_truncate ON attendance_calculation_rollout_state`.execute(db)
  await sql`
    CREATE TRIGGER trg_acrs_deny_truncate
      BEFORE TRUNCATE ON attendance_calculation_rollout_state
      FOR EACH STATEMENT EXECUTE FUNCTION attendance_w4_deny_mutation()
  `.execute(db)

  // Item registry transition guard (section 7.1 state machine): claimed -> completed|canceled
  // only; identity/proof/command columns immutable across the transition; completed/canceled
  // rows are fully immutable. An UPDATE that performs no legal transition is rejected.
  await sql`
    CREATE OR REPLACE FUNCTION attendance_w4_operation_transition_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    BEGIN
      IF OLD.state IN ('completed', 'canceled') THEN
        RAISE EXCEPTION 'W4C0_OPERATION_STATE: % row is immutable after terminal state on %', OLD.state, TG_TABLE_NAME;
      END IF;
      IF NOT (OLD.state = 'claimed' AND NEW.state IN ('completed', 'canceled')) THEN
        RAISE EXCEPTION 'W4C0_OPERATION_STATE: illegal operation state transition on %', TG_TABLE_NAME;
      END IF;
      IF NEW.org_id IS DISTINCT FROM OLD.org_id OR
         NEW.entrypoint IS DISTINCT FROM OLD.entrypoint OR
         NEW.operation_id IS DISTINCT FROM OLD.operation_id OR
         NEW.batch_command_id IS DISTINCT FROM OLD.batch_command_id OR
         NEW.input_ordinal IS DISTINCT FROM OLD.input_ordinal OR
         NEW.identity_source_kind IS DISTINCT FROM OLD.identity_source_kind OR
         NEW.source_root_id IS DISTINCT FROM OLD.source_root_id OR
         NEW.proof_semantic_fingerprint IS DISTINCT FROM OLD.proof_semantic_fingerprint OR
         NEW.proof_user_id IS DISTINCT FROM OLD.proof_user_id OR
         NEW.proof_work_date IS DISTINCT FROM OLD.proof_work_date OR
         NEW.source_ref IS DISTINCT FROM OLD.source_ref OR
         NEW.actor_id IS DISTINCT FROM OLD.actor_id OR
         NEW.actor_posture IS DISTINCT FROM OLD.actor_posture OR
         NEW.token_subject_user_id IS DISTINCT FROM OLD.token_subject_user_id OR
         NEW.capability IS DISTINCT FROM OLD.capability OR
         NEW.subject_scope IS DISTINCT FROM OLD.subject_scope OR
         NEW.command_fingerprint IS DISTINCT FROM OLD.command_fingerprint OR
         NEW.accepted_write_posture IS DISTINCT FROM OLD.accepted_write_posture OR
         NEW.normalized_business_input_snapshot IS DISTINCT FROM OLD.normalized_business_input_snapshot OR
         NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'W4C0_OPERATION_STATE: identity/proof/command fields are immutable on %', TG_TABLE_NAME;
      END IF;
      RETURN NEW;
    END;
    $fn$
  `.execute(db)

  await sql`DROP TRIGGER IF EXISTS trg_aro_transition_guard ON attendance_result_operations`.execute(db)
  await sql`
    CREATE TRIGGER trg_aro_transition_guard
      BEFORE UPDATE ON attendance_result_operations
      FOR EACH ROW EXECUTE FUNCTION attendance_w4_operation_transition_guard()
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION attendance_w4_operation_batch_transition_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    BEGIN
      IF OLD.state IN ('completed', 'canceled') THEN
        RAISE EXCEPTION 'W4C0_OPERATION_STATE: % row is immutable after terminal state on %', OLD.state, TG_TABLE_NAME;
      END IF;
      IF NOT (OLD.state = 'claimed' AND NEW.state IN ('completed', 'canceled')) THEN
        RAISE EXCEPTION 'W4C0_OPERATION_STATE: illegal operation state transition on %', TG_TABLE_NAME;
      END IF;
      IF NEW.org_id IS DISTINCT FROM OLD.org_id OR
         NEW.entrypoint IS DISTINCT FROM OLD.entrypoint OR
         NEW.batch_command_id IS DISTINCT FROM OLD.batch_command_id OR
         NEW.identity_source_kind IS DISTINCT FROM OLD.identity_source_kind OR
         NEW.source_root_id IS DISTINCT FROM OLD.source_root_id OR
         NEW.source_ref IS DISTINCT FROM OLD.source_ref OR
         NEW.actor_id IS DISTINCT FROM OLD.actor_id OR
         NEW.actor_posture IS DISTINCT FROM OLD.actor_posture OR
         NEW.token_subject_user_id IS DISTINCT FROM OLD.token_subject_user_id OR
         NEW.capability IS DISTINCT FROM OLD.capability OR
         NEW.subject_scope IS DISTINCT FROM OLD.subject_scope OR
         NEW.command_fingerprint IS DISTINCT FROM OLD.command_fingerprint OR
         NEW.accepted_write_posture IS DISTINCT FROM OLD.accepted_write_posture OR
         NEW.item_count IS DISTINCT FROM OLD.item_count OR
         NEW.item_sequence_fingerprint IS DISTINCT FROM OLD.item_sequence_fingerprint OR
         NEW.item_set_fingerprint IS DISTINCT FROM OLD.item_set_fingerprint OR
         NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'W4C0_OPERATION_STATE: identity/command fields are immutable on %', TG_TABLE_NAME;
      END IF;
      RETURN NEW;
    END;
    $fn$
  `.execute(db)

  await sql`DROP TRIGGER IF EXISTS trg_arob_transition_guard ON attendance_result_operation_batches`.execute(db)
  await sql`
    CREATE TRIGGER trg_arob_transition_guard
      BEFORE UPDATE ON attendance_result_operation_batches
      FOR EACH ROW EXECUTE FUNCTION attendance_w4_operation_batch_transition_guard()
  `.execute(db)

  // Deferred commit-time rejection of persisted `claimed` rows (sections 7.1/12.1): a
  // transaction cannot commit an incomplete claim. Re-reads current row state so a legal
  // in-transaction claimed -> completed|canceled seal passes.
  await sql`
    CREATE OR REPLACE FUNCTION attendance_w4_operations_claimed_commit_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    DECLARE
      current_state text;
    BEGIN
      SELECT state INTO current_state FROM attendance_result_operations
      WHERE org_id = NEW.org_id AND entrypoint = NEW.entrypoint AND operation_id = NEW.operation_id;
      IF current_state = 'claimed' THEN
        RAISE EXCEPTION 'W4C0_CLAIMED_COMMIT: claimed operation row cannot commit on %', TG_TABLE_NAME;
      END IF;
      RETURN NULL;
    END;
    $fn$
  `.execute(db)

  await sql`DROP TRIGGER IF EXISTS trg_aro_claimed_commit_guard ON attendance_result_operations`.execute(db)
  await sql`
    CREATE CONSTRAINT TRIGGER trg_aro_claimed_commit_guard
      AFTER INSERT OR UPDATE ON attendance_result_operations
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION attendance_w4_operations_claimed_commit_guard()
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION attendance_w4_batches_claimed_commit_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    DECLARE
      current_state text;
      attached integer;
      expected integer;
    BEGIN
      SELECT state, item_count INTO current_state, expected FROM attendance_result_operation_batches
      WHERE org_id = NEW.org_id AND entrypoint = NEW.entrypoint AND batch_command_id = NEW.batch_command_id;
      IF current_state = 'claimed' THEN
        RAISE EXCEPTION 'W4C0_CLAIMED_COMMIT: claimed batch row cannot commit on %', TG_TABLE_NAME;
      END IF;
      IF current_state = 'completed' THEN
        SELECT count(*) INTO attached FROM attendance_result_operations
        WHERE org_id = NEW.org_id AND entrypoint = NEW.entrypoint AND batch_command_id = NEW.batch_command_id;
        IF attached <> expected THEN
          RAISE EXCEPTION 'W4C0_BATCH_ITEMS: completed batch item count mismatch on %', TG_TABLE_NAME;
        END IF;
      END IF;
      RETURN NULL;
    END;
    $fn$
  `.execute(db)

  await sql`DROP TRIGGER IF EXISTS trg_arob_claimed_commit_guard ON attendance_result_operation_batches`.execute(db)
  await sql`
    CREATE CONSTRAINT TRIGGER trg_arob_claimed_commit_guard
      AFTER INSERT OR UPDATE ON attendance_result_operation_batches
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION attendance_w4_batches_claimed_commit_guard()
  `.execute(db)

  // Item-side mirror of the completed-batch count guard (Stage E1 hardening; sections
  // 7.1/12.1 "deferred parent-and-child triggers reject incomplete or extra direct
  // children at commit"): a LATER extra item inserted against an already-completed batch
  // only fires an item-side trigger — the batch-side guard above cannot see it. During a
  // normal claim->seal transaction the batch is completed by commit time and the count
  // matches, so the guard is invisible to the service flow.
  await sql`
    CREATE OR REPLACE FUNCTION attendance_w4_operation_items_commit_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    DECLARE
      batch RECORD;
      attached integer;
    BEGIN
      IF NEW.batch_command_id IS NULL THEN
        RETURN NULL;
      END IF;
      SELECT state, item_count INTO batch FROM attendance_result_operation_batches
      WHERE org_id = NEW.org_id AND entrypoint = NEW.entrypoint AND batch_command_id = NEW.batch_command_id;
      IF NOT FOUND THEN
        RETURN NULL; -- the immediate composite FK already rejects a missing batch
      END IF;
      IF batch.state = 'completed' THEN
        SELECT count(*) INTO attached FROM attendance_result_operations
        WHERE org_id = NEW.org_id AND entrypoint = NEW.entrypoint AND batch_command_id = NEW.batch_command_id;
        IF attached <> batch.item_count THEN
          RAISE EXCEPTION 'W4C0_BATCH_ITEMS: completed batch item count mismatch on %', TG_TABLE_NAME;
        END IF;
      END IF;
      RETURN NULL;
    END;
    $fn$
  `.execute(db)

  await sql`DROP TRIGGER IF EXISTS trg_aro_items_commit_guard ON attendance_result_operations`.execute(db)
  await sql`
    CREATE CONSTRAINT TRIGGER trg_aro_items_commit_guard
      AFTER INSERT ON attendance_result_operations
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION attendance_w4_operation_items_commit_guard()
  `.execute(db)

  // Outbox: identity/payload immutable; only closed pending -> delivered transitions and
  // retry bookkeeping may change; delivered rows are terminal; no DELETE/TRUNCATE.
  await sql`
    CREATE OR REPLACE FUNCTION attendance_w4_outbox_update_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    BEGIN
      IF OLD.delivery_state = 'delivered' THEN
        RAISE EXCEPTION 'W4C0_OUTBOX: delivered outbox row is immutable on %', TG_TABLE_NAME;
      END IF;
      IF NEW.id IS DISTINCT FROM OLD.id OR
         NEW.org_id IS DISTINCT FROM OLD.org_id OR
         NEW.entrypoint IS DISTINCT FROM OLD.entrypoint OR
         NEW.operation_id IS DISTINCT FROM OLD.operation_id OR
         NEW.event_kind IS DISTINCT FROM OLD.event_kind OR
         NEW.payload IS DISTINCT FROM OLD.payload OR
         NEW.payload_schema_version IS DISTINCT FROM OLD.payload_schema_version OR
         NEW.business_key_fingerprint IS DISTINCT FROM OLD.business_key_fingerprint OR
         NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'W4C0_OUTBOX: outbox identity/payload is immutable on %', TG_TABLE_NAME;
      END IF;
      IF NEW.delivery_state NOT IN ('pending', 'delivered') THEN
        RAISE EXCEPTION 'W4C0_OUTBOX: illegal outbox delivery state on %', TG_TABLE_NAME;
      END IF;
      IF NEW.attempts < OLD.attempts THEN
        RAISE EXCEPTION 'W4C0_OUTBOX: outbox attempts cannot decrease on %', TG_TABLE_NAME;
      END IF;
      RETURN NEW;
    END;
    $fn$
  `.execute(db)

  await sql`DROP TRIGGER IF EXISTS trg_areo_update_guard ON attendance_result_event_outbox`.execute(db)
  await sql`
    CREATE TRIGGER trg_areo_update_guard
      BEFORE UPDATE ON attendance_result_event_outbox
      FOR EACH ROW EXECUTE FUNCTION attendance_w4_outbox_update_guard()
  `.execute(db)

  await sql`DROP TRIGGER IF EXISTS trg_areo_deny_delete ON attendance_result_event_outbox`.execute(db)
  await sql`
    CREATE TRIGGER trg_areo_deny_delete
      BEFORE DELETE ON attendance_result_event_outbox
      FOR EACH ROW EXECUTE FUNCTION attendance_w4_deny_mutation()
  `.execute(db)
  await sql`DROP TRIGGER IF EXISTS trg_areo_deny_truncate ON attendance_result_event_outbox`.execute(db)
  await sql`
    CREATE TRIGGER trg_areo_deny_truncate
      BEFORE TRUNCATE ON attendance_result_event_outbox
      FOR EACH STATEMENT EXECUTE FUNCTION attendance_w4_deny_mutation()
  `.execute(db)

  // -------------------------------------------------------------------------
  // 12. P07 attendance_import_jobs frozen V1 fields (section 7.1 + amendment 1.3).
  // -------------------------------------------------------------------------
  await sql`ALTER TABLE attendance_import_jobs ADD COLUMN IF NOT EXISTS w4_contract_version integer`.execute(db)
  await sql`ALTER TABLE attendance_import_jobs ADD COLUMN IF NOT EXISTS w4_entrypoint text`.execute(db)
  await sql`ALTER TABLE attendance_import_jobs ADD COLUMN IF NOT EXISTS w4_batch_command_id uuid`.execute(db)
  await sql`ALTER TABLE attendance_import_jobs ADD COLUMN IF NOT EXISTS w4_source_kind text`.execute(db)
  await sql`ALTER TABLE attendance_import_jobs ADD COLUMN IF NOT EXISTS w4_source_ref text`.execute(db)
  await sql`ALTER TABLE attendance_import_jobs ADD COLUMN IF NOT EXISTS w4_actor_id text`.execute(db)
  await sql`ALTER TABLE attendance_import_jobs ADD COLUMN IF NOT EXISTS w4_actor_posture text`.execute(db)
  await sql`ALTER TABLE attendance_import_jobs ADD COLUMN IF NOT EXISTS w4_token_subject_user_id text`.execute(db)
  await sql`ALTER TABLE attendance_import_jobs ADD COLUMN IF NOT EXISTS w4_command_fingerprint text`.execute(db)
  await sql`ALTER TABLE attendance_import_jobs ADD COLUMN IF NOT EXISTS w4_accepted_write_posture text`.execute(db)
  await sql`ALTER TABLE attendance_import_jobs ADD COLUMN IF NOT EXISTS w4_item_count integer`.execute(db)
  await sql`ALTER TABLE attendance_import_jobs ADD COLUMN IF NOT EXISTS w4_item_sequence_fingerprint text`.execute(db)
  await sql`ALTER TABLE attendance_import_jobs ADD COLUMN IF NOT EXISTS w4_item_set_fingerprint text`.execute(db)
  await sql`ALTER TABLE attendance_import_jobs ADD COLUMN IF NOT EXISTS w4_identity_proof_vector jsonb`.execute(db)
  await sql`ALTER TABLE attendance_import_jobs ADD COLUMN IF NOT EXISTS w4_execution_reason_code text`.execute(db)

  await sql`
    DO $do$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_aij_w4_shape') THEN
        ALTER TABLE attendance_import_jobs ADD CONSTRAINT chk_aij_w4_shape CHECK (
          (
            w4_contract_version IS NULL AND w4_entrypoint IS NULL AND w4_batch_command_id IS NULL AND
            w4_source_kind IS NULL AND w4_source_ref IS NULL AND w4_actor_id IS NULL AND
            w4_actor_posture IS NULL AND w4_token_subject_user_id IS NULL AND
            w4_command_fingerprint IS NULL AND w4_accepted_write_posture IS NULL AND
            w4_item_count IS NULL AND w4_item_sequence_fingerprint IS NULL AND
            w4_item_set_fingerprint IS NULL AND w4_identity_proof_vector IS NULL AND
            w4_execution_reason_code IS NULL
          ) OR (
            w4_contract_version = 1 AND w4_entrypoint IS NOT NULL AND w4_batch_command_id IS NOT NULL AND
            w4_source_kind IS NOT NULL AND w4_source_ref IS NOT NULL AND w4_actor_id IS NOT NULL AND
            w4_actor_posture IS NOT NULL AND
            w4_command_fingerprint IS NOT NULL AND w4_accepted_write_posture IS NOT NULL AND
            w4_item_count IS NOT NULL AND w4_item_sequence_fingerprint IS NOT NULL AND
            w4_item_set_fingerprint IS NOT NULL AND w4_identity_proof_vector IS NOT NULL
          )
        );
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_aij_w4_version') THEN
        ALTER TABLE attendance_import_jobs ADD CONSTRAINT chk_aij_w4_version
          CHECK (w4_contract_version IS NULL OR w4_contract_version = 1);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_aij_w4_entrypoint') THEN
        ALTER TABLE attendance_import_jobs ADD CONSTRAINT chk_aij_w4_entrypoint
          CHECK (w4_entrypoint IS NULL OR w4_entrypoint IN (${sql.raw(sqlList(BATCH_SOURCE_KINDS))}));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_aij_w4_source_kind') THEN
        ALTER TABLE attendance_import_jobs ADD CONSTRAINT chk_aij_w4_source_kind
          CHECK (w4_source_kind IS NULL OR w4_source_kind IN (${sql.raw(sqlList(BATCH_SOURCE_KINDS))}));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_aij_w4_entrypoint_source_pair') THEN
        ALTER TABLE attendance_import_jobs ADD CONSTRAINT chk_aij_w4_entrypoint_source_pair
          CHECK (w4_entrypoint IS NULL OR w4_entrypoint = w4_source_kind);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_aij_w4_actor_posture') THEN
        ALTER TABLE attendance_import_jobs ADD CONSTRAINT chk_aij_w4_actor_posture
          CHECK (w4_actor_posture IS NULL OR w4_actor_posture IN (${sql.raw(sqlList(ACTOR_POSTURES))}));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_aij_w4_write_posture') THEN
        ALTER TABLE attendance_import_jobs ADD CONSTRAINT chk_aij_w4_write_posture
          CHECK (w4_accepted_write_posture IS NULL OR w4_accepted_write_posture IN (${sql.raw(sqlList(WRITE_POSTURES))}));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_aij_w4_command_fp') THEN
        ALTER TABLE attendance_import_jobs ADD CONSTRAINT chk_aij_w4_command_fp
          CHECK (w4_command_fingerprint IS NULL OR w4_command_fingerprint ~ '^[0-9a-f]{64}$');
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_aij_w4_item_count') THEN
        ALTER TABLE attendance_import_jobs ADD CONSTRAINT chk_aij_w4_item_count
          CHECK (w4_item_count IS NULL OR w4_item_count >= 1);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_aij_w4_seq_fp') THEN
        ALTER TABLE attendance_import_jobs ADD CONSTRAINT chk_aij_w4_seq_fp
          CHECK (w4_item_sequence_fingerprint IS NULL OR w4_item_sequence_fingerprint ~ '^[0-9a-f]{64}$');
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_aij_w4_set_fp') THEN
        ALTER TABLE attendance_import_jobs ADD CONSTRAINT chk_aij_w4_set_fp
          CHECK (w4_item_set_fingerprint IS NULL OR w4_item_set_fingerprint ~ '^[0-9a-f]{64}$');
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_aij_w4_proof_vector') THEN
        ALTER TABLE attendance_import_jobs ADD CONSTRAINT chk_aij_w4_proof_vector
          CHECK (
            w4_identity_proof_vector IS NULL OR
            attendance_w4_job_proof_vector_valid(w4_source_kind, w4_batch_command_id, w4_identity_proof_vector, w4_item_count)
          );
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_aij_w4_exec_reason') THEN
        ALTER TABLE attendance_import_jobs ADD CONSTRAINT chk_aij_w4_exec_reason
          CHECK (
            w4_execution_reason_code IS NULL OR
            (w4_execution_reason_code = 'SEGMENT_CALCULATION_SUSPENDED' AND status = 'queued') OR
            (w4_execution_reason_code = 'ATTENDANCE_ASYNC_JOB_POSTURE_CONFLICT' AND status = 'failed')
          );
      END IF;
    END
    $do$
  `.execute(db)

  // Amendment 1.2 boundary hardening (Stage E2): the exact ASCII default org key can
  // never persist a W4-enabled accepted write posture. "default with shadow or
  // authoritative fails before operation or source DML" — enforced at the DB boundary
  // too, so a raw writer bypassing the verified-identity factory still fails closed.
  await sql`
    DO $do$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_arob_default_org_posture') THEN
        ALTER TABLE attendance_result_operation_batches ADD CONSTRAINT chk_arob_default_org_posture
          CHECK (org_id <> 'default' OR accepted_write_posture = 'legacy_projection_only');
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_aro_default_org_posture') THEN
        ALTER TABLE attendance_result_operations ADD CONSTRAINT chk_aro_default_org_posture
          CHECK (org_id <> 'default' OR accepted_write_posture = 'legacy_projection_only');
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_aij_w4_default_org_posture') THEN
        ALTER TABLE attendance_import_jobs ADD CONSTRAINT chk_aij_w4_default_org_posture
          CHECK (
            w4_accepted_write_posture IS NULL OR org_id <> 'default' OR
            w4_accepted_write_posture = 'legacy_projection_only'
          );
      END IF;
    END
    $do$
  `.execute(db)

  // The V1 reservation partial unique backstop (section 7.1) — never the expected
  // control path; class-10 advisory locks serialize first claims.
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_attendance_import_jobs_w4_reservation
    ON attendance_import_jobs (org_id, w4_entrypoint, w4_batch_command_id)
    WHERE w4_contract_version IS NOT NULL
  `.execute(db)

  // Frozen V1 identity/posture fields are immutable after insert; the W4 contract
  // version can never be rewritten (no history invention, no backfill via UPDATE).
  // Only w4_execution_reason_code may change under its closed pairing CHECK.
  await sql`
    CREATE OR REPLACE FUNCTION attendance_w4_import_jobs_w4_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    BEGIN
      IF NEW.w4_contract_version IS DISTINCT FROM OLD.w4_contract_version OR
         NEW.w4_entrypoint IS DISTINCT FROM OLD.w4_entrypoint OR
         NEW.w4_batch_command_id IS DISTINCT FROM OLD.w4_batch_command_id OR
         NEW.w4_source_kind IS DISTINCT FROM OLD.w4_source_kind OR
         NEW.w4_source_ref IS DISTINCT FROM OLD.w4_source_ref OR
         NEW.w4_actor_id IS DISTINCT FROM OLD.w4_actor_id OR
         NEW.w4_actor_posture IS DISTINCT FROM OLD.w4_actor_posture OR
         NEW.w4_token_subject_user_id IS DISTINCT FROM OLD.w4_token_subject_user_id OR
         NEW.w4_command_fingerprint IS DISTINCT FROM OLD.w4_command_fingerprint OR
         NEW.w4_accepted_write_posture IS DISTINCT FROM OLD.w4_accepted_write_posture OR
         NEW.w4_item_count IS DISTINCT FROM OLD.w4_item_count OR
         NEW.w4_item_sequence_fingerprint IS DISTINCT FROM OLD.w4_item_sequence_fingerprint OR
         NEW.w4_item_set_fingerprint IS DISTINCT FROM OLD.w4_item_set_fingerprint OR
         NEW.w4_identity_proof_vector IS DISTINCT FROM OLD.w4_identity_proof_vector THEN
        RAISE EXCEPTION 'W4C0_JOB_FROZEN: W4 job identity/posture fields are immutable on %', TG_TABLE_NAME;
      END IF;
      RETURN NEW;
    END;
    $fn$
  `.execute(db)

  await sql`DROP TRIGGER IF EXISTS trg_aij_w4_guard ON attendance_import_jobs`.execute(db)
  await sql`
    CREATE TRIGGER trg_aij_w4_guard
      BEFORE UPDATE ON attendance_import_jobs
      FOR EACH ROW EXECUTE FUNCTION attendance_w4_import_jobs_w4_guard()
  `.execute(db)
}

// ---------------------------------------------------------------------------
// down(): section 11 — succeeds only when every W4 surface is empty; ANY row
// aborts BEFORE the first DDL statement. It never clears history to make the
// down migration pass.
// ---------------------------------------------------------------------------

export async function down(db: Kysely<unknown>): Promise<void> {
  const guards: Array<{ label: string; query: string }> = [
    { label: 'attendance_result_operation_batches', query: 'SELECT count(*)::int AS n FROM attendance_result_operation_batches' },
    { label: 'attendance_result_operations', query: 'SELECT count(*)::int AS n FROM attendance_result_operations' },
    { label: 'attendance_result_event_outbox', query: 'SELECT count(*)::int AS n FROM attendance_result_event_outbox' },
    { label: 'attendance_request_calculation_snapshots', query: 'SELECT count(*)::int AS n FROM attendance_request_calculation_snapshots' },
    { label: 'attendance_record_calculations', query: 'SELECT count(*)::int AS n FROM attendance_record_calculations' },
    { label: 'attendance_record_segments', query: 'SELECT count(*)::int AS n FROM attendance_record_segments' },
    { label: 'attendance_import_rollback_closures', query: 'SELECT count(*)::int AS n FROM attendance_import_rollback_closures' },
    { label: 'attendance_calculation_rollout_state', query: 'SELECT count(*)::int AS n FROM attendance_calculation_rollout_state' },
    { label: 'attendance_calculation_rollout_events', query: 'SELECT count(*)::int AS n FROM attendance_calculation_rollout_events' },
    {
      label: 'attendance_records W4 pointer/visibility rows',
      query:
        "SELECT count(*)::int AS n FROM attendance_records WHERE current_calculation_id IS NOT NULL OR projection_owner IS DISTINCT FROM 'legacy_untracked' OR visibility_state IS DISTINCT FROM 'active' OR visibility_reason IS DISTINCT FROM 'active'",
    },
    {
      label: 'attendance_import_jobs W4 V1 rows',
      query: 'SELECT count(*)::int AS n FROM attendance_import_jobs WHERE w4_contract_version IS NOT NULL',
    },
  ]

  for (const guard of guards) {
    const result = await sql.raw(guard.query).execute(db)
    const row = (result.rows[0] ?? {}) as { n?: number | string }
    const count = Number(row.n ?? 0)
    if (count > 0) {
      throw new Error(
        'W4C0_DOWN_BLOCKED: refusing to run down migration while W4 rows exist in ' +
          guard.label +
          ' (count=' + String(count) + '). Down never clears history to pass.',
      )
    }
  }

  // All W4 surfaces proven empty — now (and only now) DDL teardown.
  await sql`DROP VIEW IF EXISTS attendance_current_records`.execute(db)

  await sql`DROP TRIGGER IF EXISTS trg_ar_pointer_guard_ins ON attendance_records`.execute(db)
  await sql`DROP TRIGGER IF EXISTS trg_ar_pointer_guard_upd ON attendance_records`.execute(db)
  await sql`ALTER TABLE attendance_records DROP CONSTRAINT IF EXISTS fk_ar_current_calculation`.execute(db)
  await sql`ALTER TABLE attendance_records DROP CONSTRAINT IF EXISTS chk_ar_owner_pointer_pair`.execute(db)
  await sql`ALTER TABLE attendance_records DROP CONSTRAINT IF EXISTS chk_ar_visibility_pair`.execute(db)
  await sql`ALTER TABLE attendance_records DROP CONSTRAINT IF EXISTS chk_ar_projection_owner`.execute(db)
  await sql`ALTER TABLE attendance_records DROP CONSTRAINT IF EXISTS chk_ar_visibility_state`.execute(db)
  await sql`ALTER TABLE attendance_records DROP CONSTRAINT IF EXISTS chk_ar_visibility_reason`.execute(db)
  await sql`ALTER TABLE attendance_records DROP COLUMN IF EXISTS current_calculation_id`.execute(db)
  await sql`ALTER TABLE attendance_records DROP COLUMN IF EXISTS projection_owner`.execute(db)
  await sql`ALTER TABLE attendance_records DROP COLUMN IF EXISTS visibility_state`.execute(db)
  await sql`ALTER TABLE attendance_records DROP COLUMN IF EXISTS visibility_reason`.execute(db)

  await sql`DROP TRIGGER IF EXISTS trg_aij_w4_guard ON attendance_import_jobs`.execute(db)
  await sql`DROP INDEX IF EXISTS uq_attendance_import_jobs_w4_reservation`.execute(db)
  const jobConstraints = [
    'chk_aij_w4_shape',
    'chk_aij_w4_version',
    'chk_aij_w4_entrypoint',
    'chk_aij_w4_source_kind',
    'chk_aij_w4_entrypoint_source_pair',
    'chk_aij_w4_actor_posture',
    'chk_aij_w4_write_posture',
    'chk_aij_w4_command_fp',
    'chk_aij_w4_item_count',
    'chk_aij_w4_seq_fp',
    'chk_aij_w4_set_fp',
    'chk_aij_w4_proof_vector',
    'chk_aij_w4_exec_reason',
    'chk_aij_w4_default_org_posture',
  ]
  for (const name of jobConstraints) {
    await sql`ALTER TABLE attendance_import_jobs DROP CONSTRAINT IF EXISTS ${sql.raw(name)}`.execute(db)
  }
  const jobColumns = [
    'w4_contract_version',
    'w4_entrypoint',
    'w4_batch_command_id',
    'w4_source_kind',
    'w4_source_ref',
    'w4_actor_id',
    'w4_actor_posture',
    'w4_token_subject_user_id',
    'w4_command_fingerprint',
    'w4_accepted_write_posture',
    'w4_item_count',
    'w4_item_sequence_fingerprint',
    'w4_item_set_fingerprint',
    'w4_identity_proof_vector',
    'w4_execution_reason_code',
  ]
  for (const name of jobColumns) {
    await sql`ALTER TABLE attendance_import_jobs DROP COLUMN IF EXISTS ${sql.raw(name)}`.execute(db)
  }

  await sql`DROP TABLE IF EXISTS attendance_record_segments`.execute(db)
  await sql`DROP TABLE IF EXISTS attendance_record_calculations`.execute(db)
  await sql`DROP TABLE IF EXISTS attendance_request_calculation_snapshots`.execute(db)
  await sql`DROP TABLE IF EXISTS attendance_result_event_outbox`.execute(db)
  await sql`DROP TABLE IF EXISTS attendance_result_operations`.execute(db)
  await sql`DROP TABLE IF EXISTS attendance_result_operation_batches`.execute(db)
  await sql`DROP TABLE IF EXISTS attendance_import_rollback_closures`.execute(db)
  await sql`DROP TABLE IF EXISTS attendance_calculation_rollout_events`.execute(db)
  await sql`DROP TABLE IF EXISTS attendance_calculation_rollout_state`.execute(db)

  await sql`ALTER TABLE attendance_records DROP CONSTRAINT IF EXISTS uq_attendance_records_id_org`.execute(db)
  await sql`ALTER TABLE attendance_requests DROP CONSTRAINT IF EXISTS uq_attendance_requests_id_org`.execute(db)

  const functions = [
    'attendance_w4_import_jobs_w4_guard()',
    'attendance_w4_operation_items_commit_guard()',
    'attendance_w4_outbox_update_guard()',
    'attendance_w4_batches_claimed_commit_guard()',
    'attendance_w4_operations_claimed_commit_guard()',
    'attendance_w4_operation_batch_transition_guard()',
    'attendance_w4_operation_transition_guard()',
    'attendance_w4_records_pointer_guard()',
    'attendance_w4_rollout_state_guard()',
    'attendance_w4_segment_children_commit_guard()',
    'attendance_w4_calculation_children_commit_guard()',
    'attendance_w4_calculation_lineage_guard()',
    'attendance_w4_deny_mutation()',
    'attendance_w4_job_proof_vector_valid(text, uuid, jsonb, integer)',
    'attendance_w4_segment_reasons_valid(jsonb)',
    'attendance_w4_scheduled_name_bytes(uuid, uuid, date)',
    'attendance_w4_item_name_bytes(uuid, integer, text)',
    'attendance_w4_canonical_date_text(date)',
    'attendance_w4_uuidv5(uuid, bytea)',
  ]
  for (const fn of functions) {
    await sql`DROP FUNCTION IF EXISTS ${sql.raw(fn)}`.execute(db)
  }
}
