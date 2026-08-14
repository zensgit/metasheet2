/**
 * W7-1a-M (#4556) — provenance value-domain widening, DB half.
 *
 * Ratified per #4556 comments 5293034619 + 5293478713. INERT: this migration
 * only makes the live domains ACCEPT `w4_group`; nothing in this slice emits it
 * (the producer seam is W7-1b). No existing row changes, and every value that
 * was accepted before is still accepted with unchanged meaning.
 *
 * The widening surface was DERIVED, not enumerated: the DB half is derived from
 * the live catalogue (`pg_constraint` / `pg_proc`) on a migrated database, and
 * asserted point-by-point by
 * `tests/integration/attendance-w7-1am-provenance-widening.db.test.ts`.
 * Deriving from migration TEXT would be wrong here — `attendance_w4_records_pointer_guard`
 * is defined twice in the tree (zzzz20260725120000 then REPLACED by
 * zzzz20260731120000), so only the catalogue says what is actually live.
 *
 * Three live objects carry the two-value domain and are superseded here:
 *   1. `chk_ar_projection_owner` — CHECK (projection_owner IN (...)).
 *   2. `attendance_w4_records_pointer_guard()` — the narrow import-rollback
 *      restore exception gates on `OLD.projection_owner = 'w4'`.
 *   3. `attendance_w4c3a_restore_witness_command_guard()` — the W4C3A_WITNESS
 *      frozen-preimage check: a `NOT IN` membership test AND a coupled
 *      pointer-null disjunction. Both are widened together; widening only the
 *      membership test would admit `w4_group` and then reject it one line later.
 *
 * DELIBERATELY UNCHANGED — `chk_ar_owner_pointer_pair`
 * (`(projection_owner = 'legacy_untracked') = (current_calculation_id IS NULL)`).
 * The semantic ruling gives `w4_group` `w4`'s NON-NULL pointer semantics and
 * leaves `legacy_untracked` as the only NULL-pointer member, so this invariant
 * is already correct for the widened domain: it keeps REFUSING a `w4_group` row
 * with a NULL pointer. The .db test proves that refusal rather than trusting it.
 *
 * The two function bodies below are the historical bodies with ONLY the
 * substitutions named above applied; they were extracted mechanically from
 * zzzz20260731120000 rather than retyped, and the .db test diffs the resulting
 * `prosrc` against the pre-migration `prosrc` to prove nothing else moved.
 *
 * Historical migrations are NEVER edited: this file supersedes them, and the new
 * value enters via a zzzz migration as required.
 */
import { Kysely, sql } from 'kysely'
import { ATTENDANCE_PROJECTION_OWNERS_SQL_LIST_V1 } from '../../attendance/w7-provenance-domain'

export async function up(db: Kysely<unknown>): Promise<void> {
  // 1. Widen the closed-set CHECK. Drop/re-add is the only way to change a CHECK;
  //    the column keeps NOT NULL and its default throughout.
  await sql`ALTER TABLE attendance_records DROP CONSTRAINT IF EXISTS chk_ar_projection_owner`.execute(db)
  await sql`
    ALTER TABLE attendance_records ADD CONSTRAINT chk_ar_projection_owner
      CHECK (projection_owner IN (${sql.raw(ATTENDANCE_PROJECTION_OWNERS_SQL_LIST_V1)}))
  `.execute(db)

  // 2. Pointer guard — body unchanged except the restore-eligibility owner test.
  await sql`
    CREATE OR REPLACE FUNCTION attendance_w4_records_pointer_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    DECLARE
      calc RECORD;
      witness_ok boolean;
    BEGIN
      IF NEW.projection_owner = 'legacy_untracked' THEN
        IF EXISTS (
          SELECT 1 FROM attendance_record_calculations c
          WHERE c.attendance_record_id = NEW.id AND c.org_id = NEW.org_id
            AND (
              c.calculation_kind = 'legacy_baseline' OR
              (c.mode = 'authoritative' AND c.outcome IN ('completed', 'reversed') AND c.projection_effect <> 'none')
            )
        ) THEN
          -- Narrow exception: same-transaction import-rollback restore witness only.
          IF TG_OP = 'UPDATE'
             AND OLD.projection_owner IN ('w4', 'w4_group')
             AND OLD.current_calculation_id IS NOT NULL THEN
            SELECT EXISTS (
              SELECT 1
              FROM attendance_import_rollback_restore_witnesses w
              JOIN attendance_import_rollback_commands cmd
                ON cmd.org_id = w.org_id
               AND cmd.rollback_operation_id = w.rollback_operation_id
              JOIN attendance_record_calculations rev
                ON rev.id = w.reversal_calculation_id
               AND rev.attendance_record_id = w.attendance_record_id
               AND rev.org_id = w.org_id
              JOIN attendance_record_calculations reversed
                ON reversed.id = w.reversed_calculation_id
               AND reversed.attendance_record_id = w.attendance_record_id
               AND reversed.org_id = w.org_id
              WHERE w.org_id = NEW.org_id
                AND w.attendance_record_id = NEW.id
                AND w.reversed_calculation_id = OLD.current_calculation_id
                AND w.writer_xid = pg_current_xact_id()
                AND cmd.writer_xid = pg_current_xact_id()
                AND NEW.current_calculation_id IS NULL
                AND NEW.projection_owner = 'legacy_untracked'
                AND reversed.parent_preimage_snapshot ->> 'posture' = 'present'
                AND reversed.parent_preimage_snapshot ->> 'projectionOwner' = 'legacy_untracked'
                AND reversed.parent_preimage_snapshot ->> 'currentCalculationId' IS NULL
                AND NEW.visibility_state IS NOT DISTINCT FROM
                      (reversed.parent_preimage_snapshot ->> 'visibilityState')
                AND NEW.visibility_reason IS NOT DISTINCT FROM
                      (reversed.parent_preimage_snapshot ->> 'visibilityReason')
                AND NEW.status IS NOT DISTINCT FROM
                      (reversed.parent_preimage_snapshot #>> '{projection,status}')
                AND NEW.first_in_at IS NOT DISTINCT FROM
                      NULLIF(reversed.parent_preimage_snapshot #>> '{projection,firstInAt}', '')::timestamptz
                AND NEW.last_out_at IS NOT DISTINCT FROM
                      NULLIF(reversed.parent_preimage_snapshot #>> '{projection,lastOutAt}', '')::timestamptz
                AND NEW.work_minutes IS NOT DISTINCT FROM
                      (reversed.parent_preimage_snapshot #>> '{projection,workMinutes}')::integer
                AND NEW.late_minutes IS NOT DISTINCT FROM
                      (reversed.parent_preimage_snapshot #>> '{projection,lateMinutes}')::integer
                AND NEW.early_leave_minutes IS NOT DISTINCT FROM
                      (reversed.parent_preimage_snapshot #>> '{projection,earlyLeaveMinutes}')::integer
                AND w.frozen_preimage_fingerprint IS NOT DISTINCT FROM
                      (reversed.parent_preimage_snapshot ->> 'compatibilityFingerprint')
                AND rev.entrypoint = 'import_rollback'
                AND rev.outcome = 'reversed'
                AND rev.outcome_reason_code = 'import_rollback_reversal'
                AND rev.supersedes_calculation_id = OLD.current_calculation_id
            ) INTO witness_ok;
            IF witness_ok THEN
              IF NEW.visibility_state = 'retired' AND NEW.visibility_reason = 'operator_retirement' THEN
                RAISE EXCEPTION 'W4C0_POINTER: operator retirement requires a W4 pointer on %', TG_TABLE_NAME;
              END IF;
              RETURN NULL;
            END IF;
          END IF;
          RAISE EXCEPTION 'W4C0_POINTER: parent cannot return to legacy_untracked on %', TG_TABLE_NAME;
        END IF;
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

  // 3. W4C3A_WITNESS command guard — membership + coupled pointer disjunct.
  await sql`
    CREATE OR REPLACE FUNCTION attendance_w4c3a_restore_witness_command_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    DECLARE
      cmd RECORD;
      rev RECORD;
      reversed RECORD;
    BEGIN
      SELECT source_batch_entrypoint, source_batch_id, writer_xid, rollback_entrypoint
        INTO cmd
      FROM attendance_import_rollback_commands
      WHERE org_id = NEW.org_id AND rollback_operation_id = NEW.rollback_operation_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'W4C3A_WITNESS: rollback command missing on %', TG_TABLE_NAME;
      END IF;
      IF cmd.source_batch_entrypoint IS DISTINCT FROM NEW.source_batch_entrypoint
         OR cmd.source_batch_id IS DISTINCT FROM NEW.source_batch_id THEN
        RAISE EXCEPTION 'W4C3A_WITNESS: source batch mismatch on %', TG_TABLE_NAME;
      END IF;
      IF NEW.writer_xid IS DISTINCT FROM pg_current_xact_id()
         OR cmd.writer_xid IS DISTINCT FROM pg_current_xact_id() THEN
        RAISE EXCEPTION 'W4C3A_WITNESS: writer xid mismatch on %', TG_TABLE_NAME;
      END IF;

      SELECT entrypoint, operation_id, outcome, outcome_reason_code, supersedes_calculation_id,
             restores_calculation_id, calculation_kind, mode, projection_effect,
             projected_status, projected_first_in_at, projected_last_out_at,
             projected_work_minutes, projected_late_minutes, projected_early_leave_minutes,
             projected_daily_fingerprint, source_batch_id
        INTO rev
      FROM attendance_record_calculations
      WHERE id = NEW.reversal_calculation_id
        AND attendance_record_id = NEW.attendance_record_id
        AND org_id = NEW.org_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'W4C3A_WITNESS: reversal missing on %', TG_TABLE_NAME;
      END IF;
      IF rev.calculation_kind <> 'reversal'
         OR rev.entrypoint <> 'import_rollback'
         OR rev.outcome <> 'reversed'
         OR rev.outcome_reason_code <> 'import_rollback_reversal'
         OR rev.mode <> 'authoritative'
         OR rev.supersedes_calculation_id IS DISTINCT FROM NEW.reversed_calculation_id THEN
        RAISE EXCEPTION 'W4C3A_WITNESS: reversal shape invalid on %', TG_TABLE_NAME;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM attendance_result_operations op
        WHERE op.org_id = NEW.org_id
          AND op.entrypoint = 'import_rollback'
          AND op.operation_id = rev.operation_id
          AND op.identity_source_kind = 'direct_import_rollback'
          AND op.actor_id = NEW.actor_id
          AND op.actor_posture = NEW.actor_posture
          AND op.state = 'claimed'
      ) THEN
        RAISE EXCEPTION 'W4C3A_WITNESS: reversal operation mismatch on %', TG_TABLE_NAME;
      END IF;

      SELECT entrypoint, source_batch_id, parent_preimage_snapshot, mode, outcome
        INTO reversed
      FROM attendance_record_calculations
      WHERE id = NEW.reversed_calculation_id
        AND attendance_record_id = NEW.attendance_record_id
        AND org_id = NEW.org_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'W4C3A_WITNESS: reversed calculation missing on %', TG_TABLE_NAME;
      END IF;
      IF reversed.source_batch_id IS NULL
         OR reversed.source_batch_id IS DISTINCT FROM NEW.source_batch_id THEN
        RAISE EXCEPTION 'W4C3A_WITNESS: reversed source batch invalid on %', TG_TABLE_NAME;
      END IF;
      IF NOT (
        (reversed.entrypoint = 'legacy_import' AND NEW.source_batch_entrypoint = 'import_batch')
        OR (reversed.entrypoint = 'integration_sync' AND NEW.source_batch_entrypoint = 'integration_batch')
      ) THEN
        RAISE EXCEPTION 'W4C3A_WITNESS: calculation/batch entrypoint map invalid on %', TG_TABLE_NAME;
      END IF;
      IF jsonb_typeof(reversed.parent_preimage_snapshot) IS DISTINCT FROM 'object'
         OR (SELECT count(*) FROM jsonb_object_keys(reversed.parent_preimage_snapshot)) <> 7
         OR reversed.parent_preimage_snapshot ->> 'posture' IS DISTINCT FROM 'present'
         OR reversed.parent_preimage_snapshot ->> 'projectionOwner' NOT IN ('legacy_untracked', 'w4', 'w4_group')
         OR reversed.parent_preimage_snapshot ? 'currentCalculationId' = false
         OR NOT (
              (reversed.parent_preimage_snapshot ->> 'projectionOwner' = 'legacy_untracked'
                AND reversed.parent_preimage_snapshot ->> 'currentCalculationId' IS NULL)
              OR
              (reversed.parent_preimage_snapshot ->> 'projectionOwner' IN ('w4', 'w4_group')
                AND reversed.parent_preimage_snapshot ->> 'currentCalculationId' IS NOT NULL
                AND EXISTS (
                  SELECT 1
                  FROM attendance_record_calculations restored
                  WHERE restored.id = (reversed.parent_preimage_snapshot ->> 'currentCalculationId')::uuid
                    AND restored.attendance_record_id = NEW.attendance_record_id
                    AND restored.org_id = NEW.org_id
                ))
            )
         OR reversed.parent_preimage_snapshot ->> 'compatibilityFingerprint'
              IS DISTINCT FROM NEW.frozen_preimage_fingerprint
         OR jsonb_typeof(reversed.parent_preimage_snapshot -> 'projection') IS DISTINCT FROM 'object'
         OR (SELECT count(*) FROM jsonb_object_keys(reversed.parent_preimage_snapshot -> 'projection')) <> 6
         OR NOT ((reversed.parent_preimage_snapshot -> 'projection') ?& ARRAY[
              'status', 'firstInAt', 'lastOutAt', 'workMinutes', 'lateMinutes',
              'earlyLeaveMinutes'
            ])
         OR attendance_w4c3a_rollback_preimage_fingerprint(
              reversed.parent_preimage_snapshot
            ) IS DISTINCT FROM NEW.frozen_preimage_fingerprint THEN
        RAISE EXCEPTION 'W4C3A_WITNESS: closed present preimage invalid on %', TG_TABLE_NAME;
      END IF;
      IF rev.restores_calculation_id IS DISTINCT FROM
           NULLIF(reversed.parent_preimage_snapshot ->> 'currentCalculationId', '')::uuid THEN
        RAISE EXCEPTION 'W4C3A_WITNESS: restore pointer drift on %', TG_TABLE_NAME;
      END IF;
      IF rev.projected_status IS DISTINCT FROM (reversed.parent_preimage_snapshot #>> '{projection,status}')
         OR rev.projected_first_in_at IS DISTINCT FROM
              NULLIF(reversed.parent_preimage_snapshot #>> '{projection,firstInAt}', '')::timestamptz
         OR rev.projected_last_out_at IS DISTINCT FROM
              NULLIF(reversed.parent_preimage_snapshot #>> '{projection,lastOutAt}', '')::timestamptz
         OR rev.projected_work_minutes IS DISTINCT FROM
              (reversed.parent_preimage_snapshot #>> '{projection,workMinutes}')::integer
         OR rev.projected_late_minutes IS DISTINCT FROM
              (reversed.parent_preimage_snapshot #>> '{projection,lateMinutes}')::integer
         OR rev.projected_early_leave_minutes IS DISTINCT FROM
              (reversed.parent_preimage_snapshot #>> '{projection,earlyLeaveMinutes}')::integer THEN
        RAISE EXCEPTION 'W4C3A_WITNESS: reversal projection drift on %', TG_TABLE_NAME;
      END IF;
      IF (reversed.parent_preimage_snapshot ->> 'visibilityState') = 'active' THEN
        IF rev.projection_effect <> 'set_active' THEN
          RAISE EXCEPTION 'W4C3A_WITNESS: projection effect mismatch on %', TG_TABLE_NAME;
        END IF;
      ELSIF (reversed.parent_preimage_snapshot ->> 'visibilityState') = 'retired' THEN
        IF rev.projection_effect <> 'set_retired' THEN
          RAISE EXCEPTION 'W4C3A_WITNESS: projection effect mismatch on %', TG_TABLE_NAME;
        END IF;
      ELSE
        RAISE EXCEPTION 'W4C3A_WITNESS: frozen visibility invalid on %', TG_TABLE_NAME;
      END IF;
      RETURN NEW;
    END;
    $fn$
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Restore the pre-widening domain. Any `w4_group` row would block the CHECK
  // re-add; that is intended — the down path must not silently rewrite data.
  await sql`ALTER TABLE attendance_records DROP CONSTRAINT IF EXISTS chk_ar_projection_owner`.execute(db)
  await sql`
    ALTER TABLE attendance_records ADD CONSTRAINT chk_ar_projection_owner
      CHECK (projection_owner IN ('legacy_untracked', 'w4'))
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION attendance_w4_records_pointer_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    DECLARE
      calc RECORD;
      witness_ok boolean;
    BEGIN
      IF NEW.projection_owner = 'legacy_untracked' THEN
        IF EXISTS (
          SELECT 1 FROM attendance_record_calculations c
          WHERE c.attendance_record_id = NEW.id AND c.org_id = NEW.org_id
            AND (
              c.calculation_kind = 'legacy_baseline' OR
              (c.mode = 'authoritative' AND c.outcome IN ('completed', 'reversed') AND c.projection_effect <> 'none')
            )
        ) THEN
          -- Narrow exception: same-transaction import-rollback restore witness only.
          IF TG_OP = 'UPDATE'
             AND OLD.projection_owner = 'w4'
             AND OLD.current_calculation_id IS NOT NULL THEN
            SELECT EXISTS (
              SELECT 1
              FROM attendance_import_rollback_restore_witnesses w
              JOIN attendance_import_rollback_commands cmd
                ON cmd.org_id = w.org_id
               AND cmd.rollback_operation_id = w.rollback_operation_id
              JOIN attendance_record_calculations rev
                ON rev.id = w.reversal_calculation_id
               AND rev.attendance_record_id = w.attendance_record_id
               AND rev.org_id = w.org_id
              JOIN attendance_record_calculations reversed
                ON reversed.id = w.reversed_calculation_id
               AND reversed.attendance_record_id = w.attendance_record_id
               AND reversed.org_id = w.org_id
              WHERE w.org_id = NEW.org_id
                AND w.attendance_record_id = NEW.id
                AND w.reversed_calculation_id = OLD.current_calculation_id
                AND w.writer_xid = pg_current_xact_id()
                AND cmd.writer_xid = pg_current_xact_id()
                AND NEW.current_calculation_id IS NULL
                AND NEW.projection_owner = 'legacy_untracked'
                AND reversed.parent_preimage_snapshot ->> 'posture' = 'present'
                AND reversed.parent_preimage_snapshot ->> 'projectionOwner' = 'legacy_untracked'
                AND reversed.parent_preimage_snapshot ->> 'currentCalculationId' IS NULL
                AND NEW.visibility_state IS NOT DISTINCT FROM
                      (reversed.parent_preimage_snapshot ->> 'visibilityState')
                AND NEW.visibility_reason IS NOT DISTINCT FROM
                      (reversed.parent_preimage_snapshot ->> 'visibilityReason')
                AND NEW.status IS NOT DISTINCT FROM
                      (reversed.parent_preimage_snapshot #>> '{projection,status}')
                AND NEW.first_in_at IS NOT DISTINCT FROM
                      NULLIF(reversed.parent_preimage_snapshot #>> '{projection,firstInAt}', '')::timestamptz
                AND NEW.last_out_at IS NOT DISTINCT FROM
                      NULLIF(reversed.parent_preimage_snapshot #>> '{projection,lastOutAt}', '')::timestamptz
                AND NEW.work_minutes IS NOT DISTINCT FROM
                      (reversed.parent_preimage_snapshot #>> '{projection,workMinutes}')::integer
                AND NEW.late_minutes IS NOT DISTINCT FROM
                      (reversed.parent_preimage_snapshot #>> '{projection,lateMinutes}')::integer
                AND NEW.early_leave_minutes IS NOT DISTINCT FROM
                      (reversed.parent_preimage_snapshot #>> '{projection,earlyLeaveMinutes}')::integer
                AND w.frozen_preimage_fingerprint IS NOT DISTINCT FROM
                      (reversed.parent_preimage_snapshot ->> 'compatibilityFingerprint')
                AND rev.entrypoint = 'import_rollback'
                AND rev.outcome = 'reversed'
                AND rev.outcome_reason_code = 'import_rollback_reversal'
                AND rev.supersedes_calculation_id = OLD.current_calculation_id
            ) INTO witness_ok;
            IF witness_ok THEN
              IF NEW.visibility_state = 'retired' AND NEW.visibility_reason = 'operator_retirement' THEN
                RAISE EXCEPTION 'W4C0_POINTER: operator retirement requires a W4 pointer on %', TG_TABLE_NAME;
              END IF;
              RETURN NULL;
            END IF;
          END IF;
          RAISE EXCEPTION 'W4C0_POINTER: parent cannot return to legacy_untracked on %', TG_TABLE_NAME;
        END IF;
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

  await sql`
    CREATE OR REPLACE FUNCTION attendance_w4c3a_restore_witness_command_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    DECLARE
      cmd RECORD;
      rev RECORD;
      reversed RECORD;
    BEGIN
      SELECT source_batch_entrypoint, source_batch_id, writer_xid, rollback_entrypoint
        INTO cmd
      FROM attendance_import_rollback_commands
      WHERE org_id = NEW.org_id AND rollback_operation_id = NEW.rollback_operation_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'W4C3A_WITNESS: rollback command missing on %', TG_TABLE_NAME;
      END IF;
      IF cmd.source_batch_entrypoint IS DISTINCT FROM NEW.source_batch_entrypoint
         OR cmd.source_batch_id IS DISTINCT FROM NEW.source_batch_id THEN
        RAISE EXCEPTION 'W4C3A_WITNESS: source batch mismatch on %', TG_TABLE_NAME;
      END IF;
      IF NEW.writer_xid IS DISTINCT FROM pg_current_xact_id()
         OR cmd.writer_xid IS DISTINCT FROM pg_current_xact_id() THEN
        RAISE EXCEPTION 'W4C3A_WITNESS: writer xid mismatch on %', TG_TABLE_NAME;
      END IF;

      SELECT entrypoint, operation_id, outcome, outcome_reason_code, supersedes_calculation_id,
             restores_calculation_id, calculation_kind, mode, projection_effect,
             projected_status, projected_first_in_at, projected_last_out_at,
             projected_work_minutes, projected_late_minutes, projected_early_leave_minutes,
             projected_daily_fingerprint, source_batch_id
        INTO rev
      FROM attendance_record_calculations
      WHERE id = NEW.reversal_calculation_id
        AND attendance_record_id = NEW.attendance_record_id
        AND org_id = NEW.org_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'W4C3A_WITNESS: reversal missing on %', TG_TABLE_NAME;
      END IF;
      IF rev.calculation_kind <> 'reversal'
         OR rev.entrypoint <> 'import_rollback'
         OR rev.outcome <> 'reversed'
         OR rev.outcome_reason_code <> 'import_rollback_reversal'
         OR rev.mode <> 'authoritative'
         OR rev.supersedes_calculation_id IS DISTINCT FROM NEW.reversed_calculation_id THEN
        RAISE EXCEPTION 'W4C3A_WITNESS: reversal shape invalid on %', TG_TABLE_NAME;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM attendance_result_operations op
        WHERE op.org_id = NEW.org_id
          AND op.entrypoint = 'import_rollback'
          AND op.operation_id = rev.operation_id
          AND op.identity_source_kind = 'direct_import_rollback'
          AND op.actor_id = NEW.actor_id
          AND op.actor_posture = NEW.actor_posture
          AND op.state = 'claimed'
      ) THEN
        RAISE EXCEPTION 'W4C3A_WITNESS: reversal operation mismatch on %', TG_TABLE_NAME;
      END IF;

      SELECT entrypoint, source_batch_id, parent_preimage_snapshot, mode, outcome
        INTO reversed
      FROM attendance_record_calculations
      WHERE id = NEW.reversed_calculation_id
        AND attendance_record_id = NEW.attendance_record_id
        AND org_id = NEW.org_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'W4C3A_WITNESS: reversed calculation missing on %', TG_TABLE_NAME;
      END IF;
      IF reversed.source_batch_id IS NULL
         OR reversed.source_batch_id IS DISTINCT FROM NEW.source_batch_id THEN
        RAISE EXCEPTION 'W4C3A_WITNESS: reversed source batch invalid on %', TG_TABLE_NAME;
      END IF;
      IF NOT (
        (reversed.entrypoint = 'legacy_import' AND NEW.source_batch_entrypoint = 'import_batch')
        OR (reversed.entrypoint = 'integration_sync' AND NEW.source_batch_entrypoint = 'integration_batch')
      ) THEN
        RAISE EXCEPTION 'W4C3A_WITNESS: calculation/batch entrypoint map invalid on %', TG_TABLE_NAME;
      END IF;
      IF jsonb_typeof(reversed.parent_preimage_snapshot) IS DISTINCT FROM 'object'
         OR (SELECT count(*) FROM jsonb_object_keys(reversed.parent_preimage_snapshot)) <> 7
         OR reversed.parent_preimage_snapshot ->> 'posture' IS DISTINCT FROM 'present'
         OR reversed.parent_preimage_snapshot ->> 'projectionOwner' NOT IN ('legacy_untracked', 'w4')
         OR reversed.parent_preimage_snapshot ? 'currentCalculationId' = false
         OR NOT (
              (reversed.parent_preimage_snapshot ->> 'projectionOwner' = 'legacy_untracked'
                AND reversed.parent_preimage_snapshot ->> 'currentCalculationId' IS NULL)
              OR
              (reversed.parent_preimage_snapshot ->> 'projectionOwner' = 'w4'
                AND reversed.parent_preimage_snapshot ->> 'currentCalculationId' IS NOT NULL
                AND EXISTS (
                  SELECT 1
                  FROM attendance_record_calculations restored
                  WHERE restored.id = (reversed.parent_preimage_snapshot ->> 'currentCalculationId')::uuid
                    AND restored.attendance_record_id = NEW.attendance_record_id
                    AND restored.org_id = NEW.org_id
                ))
            )
         OR reversed.parent_preimage_snapshot ->> 'compatibilityFingerprint'
              IS DISTINCT FROM NEW.frozen_preimage_fingerprint
         OR jsonb_typeof(reversed.parent_preimage_snapshot -> 'projection') IS DISTINCT FROM 'object'
         OR (SELECT count(*) FROM jsonb_object_keys(reversed.parent_preimage_snapshot -> 'projection')) <> 6
         OR NOT ((reversed.parent_preimage_snapshot -> 'projection') ?& ARRAY[
              'status', 'firstInAt', 'lastOutAt', 'workMinutes', 'lateMinutes',
              'earlyLeaveMinutes'
            ])
         OR attendance_w4c3a_rollback_preimage_fingerprint(
              reversed.parent_preimage_snapshot
            ) IS DISTINCT FROM NEW.frozen_preimage_fingerprint THEN
        RAISE EXCEPTION 'W4C3A_WITNESS: closed present preimage invalid on %', TG_TABLE_NAME;
      END IF;
      IF rev.restores_calculation_id IS DISTINCT FROM
           NULLIF(reversed.parent_preimage_snapshot ->> 'currentCalculationId', '')::uuid THEN
        RAISE EXCEPTION 'W4C3A_WITNESS: restore pointer drift on %', TG_TABLE_NAME;
      END IF;
      IF rev.projected_status IS DISTINCT FROM (reversed.parent_preimage_snapshot #>> '{projection,status}')
         OR rev.projected_first_in_at IS DISTINCT FROM
              NULLIF(reversed.parent_preimage_snapshot #>> '{projection,firstInAt}', '')::timestamptz
         OR rev.projected_last_out_at IS DISTINCT FROM
              NULLIF(reversed.parent_preimage_snapshot #>> '{projection,lastOutAt}', '')::timestamptz
         OR rev.projected_work_minutes IS DISTINCT FROM
              (reversed.parent_preimage_snapshot #>> '{projection,workMinutes}')::integer
         OR rev.projected_late_minutes IS DISTINCT FROM
              (reversed.parent_preimage_snapshot #>> '{projection,lateMinutes}')::integer
         OR rev.projected_early_leave_minutes IS DISTINCT FROM
              (reversed.parent_preimage_snapshot #>> '{projection,earlyLeaveMinutes}')::integer THEN
        RAISE EXCEPTION 'W4C3A_WITNESS: reversal projection drift on %', TG_TABLE_NAME;
      END IF;
      IF (reversed.parent_preimage_snapshot ->> 'visibilityState') = 'active' THEN
        IF rev.projection_effect <> 'set_active' THEN
          RAISE EXCEPTION 'W4C3A_WITNESS: projection effect mismatch on %', TG_TABLE_NAME;
        END IF;
      ELSIF (reversed.parent_preimage_snapshot ->> 'visibilityState') = 'retired' THEN
        IF rev.projection_effect <> 'set_retired' THEN
          RAISE EXCEPTION 'W4C3A_WITNESS: projection effect mismatch on %', TG_TABLE_NAME;
        END IF;
      ELSE
        RAISE EXCEPTION 'W4C3A_WITNESS: frozen visibility invalid on %', TG_TABLE_NAME;
      END IF;
      RETURN NEW;
    END;
    $fn$
  `.execute(db)
}
