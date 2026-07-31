/**
 * W4C-3a (#4556) — P11/P23 import-rollback foundation for OD-W4C-55(a).
 *
 * Contract inputs:
 *  - design lock sections 7.9 / 12.4
 *  - OD-W4C-55(a) schema and lineage shape
 *
 * Creates:
 *  - attendance_import_rollback_commands (append-only one-op/one-batch header)
 *  - attendance_import_rollback_restore_witnesses (append-only per-record restore)
 *  - narrow same-transaction pointer exception for exact legacy preimage restore
 *
 * No caller/route/host cutover. Values-free trigger errors (table names only).
 */
import type { Kysely } from 'kysely'
import { sql } from 'kysely'

function sqlList(values: readonly string[]): string {
  return values.map((v) => "'" + v + "'").join(', ')
}

const ACTOR_POSTURES = [
  'self',
  'platform_admin',
  'attendance_admin',
  'delegated_import',
  'scheduler',
  'approval_system',
  'operator',
] as const

const BATCH_ENTRYPOINTS = ['import_batch', 'integration_batch'] as const

async function emptySurfaceGuard(db: Kysely<unknown>): Promise<void> {
  const guards: Array<{ label: string; query: string }> = [
    {
      label: 'attendance_import_rollback_commands',
      query: 'SELECT count(*)::int AS n FROM attendance_import_rollback_commands',
    },
    {
      label: 'attendance_import_rollback_restore_witnesses',
      query: 'SELECT count(*)::int AS n FROM attendance_import_rollback_restore_witnesses',
    },
  ]
  for (const guard of guards) {
    const result = await sql.raw(guard.query).execute(db)
    const row = (result.rows[0] ?? {}) as { n?: number | string }
    const count = Number(row.n ?? 0)
    if (count > 0) {
      throw new Error(
        'W4C3A_DOWN_BLOCKED: refusing to run down migration while W4 rows exist in ' +
          guard.label +
          ' (count=' +
          String(count) +
          '). Down never clears history to pass.',
      )
    }
  }
}

export async function up(db: Kysely<unknown>): Promise<void> {
  // Independent SQL parity for the closed, domain-separated rollback-preimage
  // fingerprint. A copied or fabricated compatibility hex is insufficient.
  await sql`
    CREATE OR REPLACE FUNCTION attendance_w4c3a_canonical_json(value jsonb)
    RETURNS text
    LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
    AS $fn$
    DECLARE
      kind text;
      encoded text;
    BEGIN
      kind := jsonb_typeof(value);
      IF kind IN ('null', 'boolean', 'number', 'string') THEN
        RETURN value::text;
      ELSIF kind = 'array' THEN
        SELECT '[' || COALESCE(string_agg(attendance_w4c3a_canonical_json(item), ',' ORDER BY ordinal), '') || ']'
          INTO encoded
        FROM jsonb_array_elements(value) WITH ORDINALITY AS entries(item, ordinal);
        RETURN encoded;
      ELSIF kind = 'object' THEN
        SELECT '{' || COALESCE(string_agg(to_jsonb(key)::text || ':' || attendance_w4c3a_canonical_json(item), ',' ORDER BY key COLLATE "C"), '') || '}'
          INTO encoded
        FROM jsonb_each(value) AS entries(key, item);
        RETURN encoded;
      END IF;
      RAISE EXCEPTION 'W4C3A_FINGERPRINT: unsupported json shape';
    END;
    $fn$
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION attendance_w4c3a_rollback_preimage_fingerprint(value jsonb)
    RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $fn$
      SELECT encode(
        digest(
          convert_to(
            'metasheet2:attendance:w4c3a:rollback-preimage-fingerprint:v1',
            'UTF8'
          ) || decode('00', 'hex') || convert_to(
            attendance_w4c3a_canonical_json(jsonb_build_object(
              'projection', value -> 'projection',
              'projectionOwner', value -> 'projectionOwner',
              'currentCalculationId', value -> 'currentCalculationId',
              'visibilityState', value -> 'visibilityState',
              'visibilityReason', value -> 'visibilityReason'
            )),
            'UTF8'
          ),
          'sha256'
        ),
        'hex'
      )
    $fn$
  `.execute(db)

  // -------------------------------------------------------------------------
  // 1. Append-only rollback-command header (one root op -> one source batch).
  // -------------------------------------------------------------------------
  await sql`
    CREATE TABLE IF NOT EXISTS attendance_import_rollback_commands (
      org_id text NOT NULL,
      rollback_operation_id uuid NOT NULL,
      rollback_entrypoint text NOT NULL,
      source_batch_entrypoint text NOT NULL,
      source_batch_id uuid NOT NULL,
      writer_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
      actor_id text NOT NULL,
      actor_posture text NOT NULL,
      correlation_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT pk_attendance_import_rollback_commands
        PRIMARY KEY (org_id, rollback_operation_id),
      CONSTRAINT uq_airc_cmd_source_batch
        UNIQUE (org_id, source_batch_entrypoint, source_batch_id),
      CONSTRAINT chk_airc_cmd_rollback_entrypoint
        CHECK (rollback_entrypoint = 'import_rollback'),
      CONSTRAINT chk_airc_cmd_source_batch_entrypoint
        CHECK (source_batch_entrypoint IN (${sql.raw(sqlList(BATCH_ENTRYPOINTS))})),
      CONSTRAINT chk_airc_cmd_actor_posture
        CHECK (actor_posture IN (${sql.raw(sqlList(ACTOR_POSTURES))})),
      CONSTRAINT fk_airc_cmd_operation
        FOREIGN KEY (org_id, rollback_entrypoint, rollback_operation_id)
        REFERENCES attendance_result_operations (org_id, entrypoint, operation_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT fk_airc_cmd_source_batch
        FOREIGN KEY (org_id, source_batch_entrypoint, source_batch_id)
        REFERENCES attendance_result_operation_batches (org_id, entrypoint, batch_command_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
    )
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION attendance_w4c3a_rollback_command_insert_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    DECLARE
      op RECORD;
      batch RECORD;
    BEGIN
      IF NEW.writer_xid IS DISTINCT FROM pg_current_xact_id() THEN
        RAISE EXCEPTION 'W4C3A_COMMAND: writer xid mismatch on %', TG_TABLE_NAME;
      END IF;
      SELECT actor_id, actor_posture, state INTO op
      FROM attendance_result_operations
      WHERE org_id = NEW.org_id
        AND entrypoint = NEW.rollback_entrypoint
        AND operation_id = NEW.rollback_operation_id;
      IF NOT FOUND OR op.state <> 'claimed'
         OR op.actor_id IS DISTINCT FROM NEW.actor_id
         OR op.actor_posture IS DISTINCT FROM NEW.actor_posture THEN
        RAISE EXCEPTION 'W4C3A_COMMAND: rollback operation mismatch on %', TG_TABLE_NAME;
      END IF;
      SELECT state INTO batch
      FROM attendance_result_operation_batches
      WHERE org_id = NEW.org_id
        AND entrypoint = NEW.source_batch_entrypoint
        AND batch_command_id = NEW.source_batch_id;
      IF NOT FOUND OR batch.state <> 'completed' THEN
        RAISE EXCEPTION 'W4C3A_COMMAND: source batch mismatch on %', TG_TABLE_NAME;
      END IF;
      RETURN NEW;
    END;
    $fn$
  `.execute(db)

  await sql`DROP TRIGGER IF EXISTS trg_airc_insert_guard ON attendance_import_rollback_commands`.execute(db)
  await sql`
    CREATE TRIGGER trg_airc_insert_guard
      BEFORE INSERT ON attendance_import_rollback_commands
      FOR EACH ROW EXECUTE FUNCTION attendance_w4c3a_rollback_command_insert_guard()
  `.execute(db)

  // -------------------------------------------------------------------------
  // 2. Append-only per-record restore witnesses (transaction-bound XID).
  // -------------------------------------------------------------------------
  await sql`
    CREATE TABLE IF NOT EXISTS attendance_import_rollback_restore_witnesses (
      org_id text NOT NULL,
      attendance_record_id uuid NOT NULL,
      reversal_calculation_id uuid NOT NULL,
      reversed_calculation_id uuid NOT NULL,
      rollback_operation_id uuid NOT NULL,
      source_batch_entrypoint text NOT NULL,
      source_batch_id uuid NOT NULL,
      frozen_preimage_fingerprint char(64) NOT NULL,
      writer_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
      actor_id text NOT NULL,
      actor_posture text NOT NULL,
      correlation_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT pk_attendance_import_rollback_restore_witnesses
        PRIMARY KEY (org_id, attendance_record_id, reversal_calculation_id),
      CONSTRAINT uq_airw_reversal UNIQUE (reversal_calculation_id),
      CONSTRAINT uq_airw_reversed UNIQUE (org_id, reversed_calculation_id),
      CONSTRAINT chk_airw_fp CHECK (frozen_preimage_fingerprint ~ '^[0-9a-f]{64}$'),
      CONSTRAINT chk_airw_source_batch_entrypoint
        CHECK (source_batch_entrypoint IN (${sql.raw(sqlList(BATCH_ENTRYPOINTS))})),
      CONSTRAINT chk_airw_actor_posture
        CHECK (actor_posture IN (${sql.raw(sqlList(ACTOR_POSTURES))})),
      CONSTRAINT fk_airw_parent
        FOREIGN KEY (attendance_record_id, org_id)
        REFERENCES attendance_records (id, org_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT fk_airw_reversal
        FOREIGN KEY (reversal_calculation_id, attendance_record_id, org_id)
        REFERENCES attendance_record_calculations (id, attendance_record_id, org_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT fk_airw_reversed
        FOREIGN KEY (reversed_calculation_id, attendance_record_id, org_id)
        REFERENCES attendance_record_calculations (id, attendance_record_id, org_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT fk_airw_command
        FOREIGN KEY (org_id, rollback_operation_id)
        REFERENCES attendance_import_rollback_commands (org_id, rollback_operation_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT chk_airw_command_batch_pair
        CHECK (true)
    )
  `.execute(db)

  // Bind witness batch identity to the exact command header batch (no substitution).
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
         OR rev.supersedes_calculation_id IS DISTINCT FROM NEW.reversed_calculation_id
         OR rev.restores_calculation_id IS NOT NULL THEN
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
         OR reversed.parent_preimage_snapshot ->> 'projectionOwner' IS DISTINCT FROM 'legacy_untracked'
         OR reversed.parent_preimage_snapshot ? 'currentCalculationId' = false
         OR reversed.parent_preimage_snapshot ->> 'currentCalculationId' IS NOT NULL
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

  await sql`DROP TRIGGER IF EXISTS trg_airw_command_guard ON attendance_import_rollback_restore_witnesses`.execute(db)
  await sql`
    CREATE TRIGGER trg_airw_command_guard
      BEFORE INSERT ON attendance_import_rollback_restore_witnesses
      FOR EACH ROW EXECUTE FUNCTION attendance_w4c3a_restore_witness_command_guard()
  `.execute(db)

  // Deferred: root rollback op and source batch must be completed at commit.
  await sql`
    CREATE OR REPLACE FUNCTION attendance_w4c3a_rollback_command_commit_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    DECLARE
      op_state text;
      batch_state text;
    BEGIN
      SELECT state INTO op_state
      FROM attendance_result_operations
      WHERE org_id = NEW.org_id
        AND entrypoint = 'import_rollback'
        AND operation_id = NEW.rollback_operation_id;
      IF op_state IS DISTINCT FROM 'completed' THEN
        RAISE EXCEPTION 'W4C3A_COMMAND_COMMIT: rollback operation not completed on %', TG_TABLE_NAME;
      END IF;
      SELECT state INTO batch_state
      FROM attendance_result_operation_batches
      WHERE org_id = NEW.org_id
        AND entrypoint = NEW.source_batch_entrypoint
        AND batch_command_id = NEW.source_batch_id;
      IF batch_state IS DISTINCT FROM 'completed' THEN
        RAISE EXCEPTION 'W4C3A_COMMAND_COMMIT: source batch not completed on %', TG_TABLE_NAME;
      END IF;
      RETURN NULL;
    END;
    $fn$
  `.execute(db)

  await sql`DROP TRIGGER IF EXISTS trg_airc_cmd_commit_guard ON attendance_import_rollback_commands`.execute(db)
  await sql`
    CREATE CONSTRAINT TRIGGER trg_airc_cmd_commit_guard
      AFTER INSERT ON attendance_import_rollback_commands
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION attendance_w4c3a_rollback_command_commit_guard()
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION attendance_w4c3a_restore_witness_commit_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    DECLARE
      parent RECORD;
      reversed RECORD;
      root_state text;
      reversal_state text;
    BEGIN
      IF NEW.writer_xid IS DISTINCT FROM pg_current_xact_id() THEN
        RAISE EXCEPTION 'W4C3A_WITNESS_COMMIT: writer xid mismatch on %', TG_TABLE_NAME;
      END IF;
      SELECT projection_owner, current_calculation_id, visibility_state,
             visibility_reason, status, first_in_at, last_out_at,
             work_minutes, late_minutes, early_leave_minutes,
             is_workday, meta, source_batch_id
        INTO parent
      FROM attendance_records
      WHERE id = NEW.attendance_record_id AND org_id = NEW.org_id;
      SELECT parent_preimage_snapshot INTO reversed
      FROM attendance_record_calculations
      WHERE id = NEW.reversed_calculation_id
        AND attendance_record_id = NEW.attendance_record_id
        AND org_id = NEW.org_id;
      IF NOT FOUND OR parent.projection_owner IS DISTINCT FROM 'legacy_untracked'
         OR parent.current_calculation_id IS NOT NULL
         OR parent.visibility_state IS DISTINCT FROM (reversed.parent_preimage_snapshot ->> 'visibilityState')
         OR parent.visibility_reason IS DISTINCT FROM (reversed.parent_preimage_snapshot ->> 'visibilityReason')
         OR parent.status IS DISTINCT FROM (reversed.parent_preimage_snapshot #>> '{projection,status}')
         OR parent.first_in_at IS DISTINCT FROM NULLIF(reversed.parent_preimage_snapshot #>> '{projection,firstInAt}', '')::timestamptz
         OR parent.last_out_at IS DISTINCT FROM NULLIF(reversed.parent_preimage_snapshot #>> '{projection,lastOutAt}', '')::timestamptz
         OR parent.work_minutes IS DISTINCT FROM (reversed.parent_preimage_snapshot #>> '{projection,workMinutes}')::integer
         OR parent.late_minutes IS DISTINCT FROM (reversed.parent_preimage_snapshot #>> '{projection,lateMinutes}')::integer
         OR parent.early_leave_minutes IS DISTINCT FROM (reversed.parent_preimage_snapshot #>> '{projection,earlyLeaveMinutes}')::integer THEN
        RAISE EXCEPTION 'W4C3A_WITNESS_COMMIT: final parent tuple mismatch on %', TG_TABLE_NAME;
      END IF;
      SELECT state INTO root_state FROM attendance_result_operations
      WHERE org_id = NEW.org_id AND entrypoint = 'import_rollback'
        AND operation_id = NEW.rollback_operation_id;
      SELECT op.state INTO reversal_state
      FROM attendance_record_calculations rev
      JOIN attendance_result_operations op
        ON op.org_id = rev.org_id AND op.entrypoint = rev.entrypoint
       AND op.operation_id = rev.operation_id
      WHERE rev.id = NEW.reversal_calculation_id
        AND rev.attendance_record_id = NEW.attendance_record_id
        AND rev.org_id = NEW.org_id;
      IF root_state IS DISTINCT FROM 'completed' OR reversal_state IS DISTINCT FROM 'completed' THEN
        RAISE EXCEPTION 'W4C3A_WITNESS_COMMIT: operation not completed on %', TG_TABLE_NAME;
      END IF;
      RETURN NULL;
    END;
    $fn$
  `.execute(db)

  await sql`DROP TRIGGER IF EXISTS trg_airw_commit_guard ON attendance_import_rollback_restore_witnesses`.execute(db)
  await sql`
    CREATE CONSTRAINT TRIGGER trg_airw_commit_guard
      AFTER INSERT ON attendance_import_rollback_restore_witnesses
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION attendance_w4c3a_restore_witness_commit_guard()
  `.execute(db)

  // -------------------------------------------------------------------------
  // 3. Immutability: UPDATE/DELETE/TRUNCATE refuse on both tables.
  // -------------------------------------------------------------------------
  for (const table of [
    'attendance_import_rollback_commands',
    'attendance_import_rollback_restore_witnesses',
  ]) {
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

  // -------------------------------------------------------------------------
  // 4. Pointer guard: exact legacy restore exception (OD-W4C-55=(a)).
  // -------------------------------------------------------------------------
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
    CREATE OR REPLACE FUNCTION attendance_w4c3a_witnessed_legacy_lineage_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    DECLARE
      parent RECORD;
      bridge uuid;
      bridge_fingerprint text;
      bridge_preimage jsonb;
      rollback_history boolean;
    BEGIN
      SELECT projection_owner, current_calculation_id INTO parent
      FROM attendance_records
      WHERE id = NEW.attendance_record_id AND org_id = NEW.org_id
      FOR SHARE;
      IF NOT FOUND OR parent.projection_owner <> 'legacy_untracked'
         OR parent.current_calculation_id IS NOT NULL THEN
        RETURN NEW;
      END IF;
      SELECT w.reversal_calculation_id, w.frozen_preimage_fingerprint,
             reversed.parent_preimage_snapshot
        INTO bridge, bridge_fingerprint, bridge_preimage
      FROM attendance_import_rollback_restore_witnesses w
      JOIN attendance_record_calculations reversal
        ON reversal.id = w.reversal_calculation_id
       AND reversal.attendance_record_id = w.attendance_record_id
       AND reversal.org_id = w.org_id
      JOIN attendance_record_calculations reversed
        ON reversed.id = w.reversed_calculation_id
       AND reversed.attendance_record_id = w.attendance_record_id
       AND reversed.org_id = w.org_id
      WHERE w.org_id = NEW.org_id
        AND w.attendance_record_id = NEW.attendance_record_id
      ORDER BY reversal.version DESC
      LIMIT 1;
      IF bridge IS NULL THEN
        SELECT EXISTS (
          SELECT 1
          FROM attendance_record_calculations calculation
          WHERE calculation.org_id = NEW.org_id
            AND calculation.attendance_record_id = NEW.attendance_record_id
            AND calculation.entrypoint = 'import_rollback'
            AND calculation.calculation_kind = 'reversal'
            AND calculation.outcome = 'reversed'
        ) INTO rollback_history;
        IF rollback_history THEN
          RAISE EXCEPTION 'W4C3A_LINEAGE: durable restore witness missing on %', TG_TABLE_NAME;
        END IF;
        RETURN NEW;
      END IF;
      IF jsonb_typeof(bridge_preimage) IS DISTINCT FROM 'object'
         OR bridge_preimage ->> 'posture' IS DISTINCT FROM 'present'
         OR bridge_preimage ->> 'compatibilityFingerprint' IS DISTINCT FROM bridge_fingerprint
         OR attendance_w4c3a_rollback_preimage_fingerprint(bridge_preimage)
              IS DISTINCT FROM bridge_fingerprint THEN
        RAISE EXCEPTION 'W4C3A_LINEAGE: restore witness fingerprint invalid on %', TG_TABLE_NAME;
      END IF;
      IF NEW.calculation_kind = 'calculation'
         AND NEW.outcome = 'review_required'
         AND NEW.projection_effect = 'none' THEN
        RETURN NEW;
      END IF;
      IF NEW.calculation_kind = 'calculation'
         AND NEW.mode = 'authoritative'
         AND NEW.outcome = 'completed'
         AND NEW.projection_effect = 'set_active'
         AND NEW.entrypoint <> 'import_rollback'
         AND NEW.supersedes_calculation_id = bridge THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'W4C3A_LINEAGE: witnessed legacy predecessor required on %', TG_TABLE_NAME;
    END;
    $fn$
  `.execute(db)

  await sql`DROP TRIGGER IF EXISTS trg_arc_witnessed_legacy_lineage ON attendance_record_calculations`.execute(db)
  await sql`
    CREATE TRIGGER trg_arc_witnessed_legacy_lineage
      BEFORE INSERT ON attendance_record_calculations
      FOR EACH ROW EXECUTE FUNCTION attendance_w4c3a_witnessed_legacy_lineage_guard()
  `.execute(db)

}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Fail closed while any foundation row exists (before DDL).
  const commandsExist = await sql`
    SELECT to_regclass('public.attendance_import_rollback_commands') IS NOT NULL AS exists
  `.execute(db)
  const witnessesExist = await sql`
    SELECT to_regclass('public.attendance_import_rollback_restore_witnesses') IS NOT NULL AS exists
  `.execute(db)
  const cmdTable = Boolean((commandsExist.rows[0] as { exists?: boolean } | undefined)?.exists)
  const witTable = Boolean((witnessesExist.rows[0] as { exists?: boolean } | undefined)?.exists)
  if (cmdTable || witTable) {
    if (cmdTable && witTable) {
      await emptySurfaceGuard(db)
    } else if (cmdTable) {
      const result = await sql`SELECT count(*)::int AS n FROM attendance_import_rollback_commands`.execute(db)
      if (Number((result.rows[0] as { n?: number }).n ?? 0) > 0) {
        throw new Error(
          'W4C3A_DOWN_BLOCKED: refusing to run down migration while W4 rows exist in attendance_import_rollback_commands',
        )
      }
    } else if (witTable) {
      const result = await sql`SELECT count(*)::int AS n FROM attendance_import_rollback_restore_witnesses`.execute(db)
      if (Number((result.rows[0] as { n?: number }).n ?? 0) > 0) {
        throw new Error(
          'W4C3A_DOWN_BLOCKED: refusing to run down migration while W4 rows exist in attendance_import_rollback_restore_witnesses',
        )
      }
    }
  }

  await sql`DROP TRIGGER IF EXISTS trg_airc_cmd_commit_guard ON attendance_import_rollback_commands`.execute(db)
  await sql`DROP FUNCTION IF EXISTS attendance_w4c3a_rollback_command_commit_guard()`.execute(db)
  await sql`DROP TRIGGER IF EXISTS trg_airw_commit_guard ON attendance_import_rollback_restore_witnesses`.execute(db)
  await sql`DROP FUNCTION IF EXISTS attendance_w4c3a_restore_witness_commit_guard()`.execute(db)
  await sql`DROP TRIGGER IF EXISTS trg_airw_command_guard ON attendance_import_rollback_restore_witnesses`.execute(db)
  await sql`DROP FUNCTION IF EXISTS attendance_w4c3a_restore_witness_command_guard()`.execute(db)
  await sql`DROP TRIGGER IF EXISTS trg_arc_witnessed_legacy_lineage ON attendance_record_calculations`.execute(db)
  await sql`DROP FUNCTION IF EXISTS attendance_w4c3a_witnessed_legacy_lineage_guard()`.execute(db)

  await sql`DROP TABLE IF EXISTS attendance_import_rollback_restore_witnesses`.execute(db)
  await sql`DROP TABLE IF EXISTS attendance_import_rollback_commands`.execute(db)
  await sql`DROP FUNCTION IF EXISTS attendance_w4c3a_rollback_command_insert_guard()`.execute(db)

  // Restore the pre-55 pointer guard body (no legacy-return exception).
  await sql`
    CREATE OR REPLACE FUNCTION attendance_w4_records_pointer_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    DECLARE
      calc RECORD;
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
  await sql`DROP FUNCTION IF EXISTS attendance_w4c3a_rollback_preimage_fingerprint(jsonb)`.execute(db)
  await sql`DROP FUNCTION IF EXISTS attendance_w4c3a_canonical_json(jsonb)`.execute(db)
}
