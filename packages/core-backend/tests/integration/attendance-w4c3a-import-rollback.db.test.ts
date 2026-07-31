import crypto from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { up as w4c0Up } from '../../src/db/migrations/zzzz20260725120000_w4c0_attendance_segment_calculation_durable_storage'
import {
  down as rollbackDown,
  up as rollbackUp,
} from '../../src/db/migrations/zzzz20260731120000_w4c3a_import_rollback_foundation'
import {
  createAuthorizedAttendanceWriteContextV1,
  recheckAttendanceActorLivenessInTransactionV1,
} from '../../src/attendance/w4c0-authorization'
import { recheckAttendanceFullImportAuthorizationInTransactionV1 } from '../../src/attendance/w4c3a-legacy-plan-enqueue'
import type { AttendanceW4TransactionClientV1 } from '../../src/attendance/w4c0-identity'
import {
  AttendanceImportRollbackError,
  type AttendanceImportRollbackAuthorizationPortV1,
  computeAttendanceImportRollbackPreimageFingerprintV1,
  createCoreAttendanceImportRollbackAuthorizationPortV1,
  createFrozenAttendanceImportRollbackCommandV1,
  rollbackAttendanceImportV1,
} from '../../src/attendance/w4c3a-import-rollback'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip
const run = crypto.randomUUID().replace(/-/g, '').slice(0, 10)
const hex = (value: string) => value.repeat(64)
const id = () => crypto.randomUUID()

function trx(client: PoolClient): AttendanceW4TransactionClientV1 {
  return {
    query: (statement, values) =>
      client.query(statement, values as unknown[]) as unknown as Promise<{
        rows: Array<Record<string, unknown>>
      }>,
  }
}

it('sentinel: DATABASE_URL is set (real-DB lane must not silently skip)', () => {
  expect(dbUrl).toBeTruthy()
})

describeIfDatabase('W4C-3a import rollback foundation (fresh PostgreSQL)', () => {
  const scratchName = `ms2_w4c3a_rollback_${run}`
  const orgId = id()
  const actorId = id()
  let adminPool: Pool
  let pool: Pool
  let kyselyPool: Pool
  let db: Kysely<unknown>

  beforeAll(async () => {
    const adminUrl = new URL(dbUrl as string)
    adminUrl.pathname = '/postgres'
    adminPool = new Pool({ connectionString: adminUrl.toString() })
    await adminPool.query(`DROP DATABASE IF EXISTS ${scratchName}`)
    await adminPool.query(`CREATE DATABASE ${scratchName}`)
    const scratchUrl = new URL(dbUrl as string)
    scratchUrl.pathname = `/${scratchName}`
    pool = new Pool({ connectionString: scratchUrl.toString(), max: 5 })
    kyselyPool = new Pool({ connectionString: scratchUrl.toString(), max: 2 })
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: kyselyPool }) })

    await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto')
    await pool.query(`
      CREATE TABLE attendance_records (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id text NOT NULL,
        work_date date NOT NULL, first_in_at timestamptz, last_out_at timestamptz,
        work_minutes integer NOT NULL DEFAULT 0, late_minutes integer NOT NULL DEFAULT 0,
        early_leave_minutes integer NOT NULL DEFAULT 0,
        status varchar(64) NOT NULL DEFAULT 'normal', org_id text NOT NULL DEFAULT 'default',
        is_workday boolean, meta jsonb, source_batch_id uuid,
        updated_at timestamptz NOT NULL DEFAULT now())`)
    await pool.query(`
      CREATE TABLE attendance_requests (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id text NOT NULL,
        work_date date NOT NULL, request_type varchar(30) NOT NULL,
        status varchar(20) NOT NULL DEFAULT 'pending', org_id text NOT NULL DEFAULT 'default')`)
    await pool.query(`
      CREATE TABLE attendance_import_jobs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id text NOT NULL DEFAULT 'default',
        batch_id uuid NOT NULL, created_by text NOT NULL, idempotency_key text,
        status varchar(20) NOT NULL DEFAULT 'queued', progress integer NOT NULL DEFAULT 0,
        total integer NOT NULL DEFAULT 0, payload jsonb NOT NULL DEFAULT '{}'::jsonb)`)
    await pool.query(`
      CREATE TABLE users (
        id text PRIMARY KEY, is_active boolean NOT NULL DEFAULT true,
        activation_status text NOT NULL DEFAULT 'activated', permissions jsonb NOT NULL DEFAULT '[]'::jsonb);
      CREATE TABLE user_orgs (
        user_id text NOT NULL, org_id text NOT NULL, is_active boolean NOT NULL DEFAULT true,
        PRIMARY KEY (user_id, org_id));
      CREATE TABLE user_roles (user_id text NOT NULL, role_id text NOT NULL);
      CREATE TABLE role_permissions (role_id text NOT NULL, permission_code text NOT NULL);
      CREATE TABLE user_permissions (user_id text NOT NULL, permission_code text NOT NULL);
      CREATE TABLE user_namespace_admissions (
        user_id text NOT NULL, namespace text NOT NULL, enabled boolean NOT NULL DEFAULT true);
      CREATE TABLE test_attendance_import_delegated_scopes (
        actor_id text NOT NULL, org_id text NOT NULL, user_id text NOT NULL,
        group_ref text NOT NULL, is_active boolean NOT NULL DEFAULT true,
        PRIMARY KEY (actor_id, org_id, user_id));
    `)
    await pool.query('INSERT INTO users (id) VALUES ($1)', [actorId])
    await pool.query('INSERT INTO user_orgs (user_id, org_id) VALUES ($1, $2)', [actorId, orgId])
    await pool.query("INSERT INTO user_namespace_admissions VALUES ($1, 'attendance', true)", [actorId])
    await pool.query("INSERT INTO user_roles VALUES ($1, 'attendance_admin')", [actorId])
    await pool.query("INSERT INTO role_permissions VALUES ('attendance_admin', 'attendance:admin')")

    await w4c0Up(db)
    await rollbackUp(db)
    expect(await pool.query("SELECT to_regclass('attendance_import_rollback_commands') AS name")).toMatchObject({
      rows: [{ name: 'attendance_import_rollback_commands' }],
    })
    await rollbackDown(db)
    expect((await pool.query("SELECT to_regclass('attendance_import_rollback_commands') AS name")).rows[0].name).toBeNull()
    await rollbackUp(db)
  }, 120000)

  afterAll(async () => {
    for (const current of [pool, kyselyPool, adminPool]) current?.on('error', () => undefined)
    await db?.destroy()
    await pool?.end()
    await adminPool?.query(`DROP DATABASE IF EXISTS ${scratchName} WITH (FORCE)`).catch(() => undefined)
    await adminPool?.end()
  })

  function authorization(
    subjectActor = actorId,
    authorizationOrgId = orgId,
    subjectUserIds: readonly string[] = [subjectActor],
    actorPosture: 'delegated_import' | 'attendance_admin' | 'platform_admin' = 'delegated_import',
  ) {
    return createAuthorizedAttendanceWriteContextV1({
      actorId: subjectActor,
      actorPosture,
      tokenSubjectUserId: null,
      orgId: authorizationOrgId,
      subjectScope: { kind: 'explicit_users', userIds: [...subjectUserIds] },
      capability: 'rollback',
      sourceRef: 'test:w4c3a-import-rollback',
    })
  }

  const rollbackAuthorizationPort = createCoreAttendanceImportRollbackAuthorizationPortV1(
    async (transaction, input) => {
      await recheckAttendanceActorLivenessInTransactionV1(transaction, input.authorization)
      if (
        input.authorization.actorPosture !== 'delegated_import' ||
        input.authorization.subjectScope.kind !== 'explicit_users'
      ) {
        throw new AttendanceImportRollbackError('IMPORT_ROLLBACK_AUTHORIZATION_STALE')
      }
      for (const target of input.targets) {
        const scope = await transaction.query(
          `SELECT 1
             FROM test_attendance_import_delegated_scopes
            WHERE actor_id = $1 AND org_id = $2 AND user_id = $3
              AND group_ref = 'group-a' AND is_active = true`,
          [input.authorization.actorId, input.orgId, target.userId],
        )
        if (scope.rows.length !== 1) {
          throw new AttendanceImportRollbackError('IMPORT_ROLLBACK_AUTHORIZATION_STALE')
        }
      }
    },
  )

  const fullAdminRollbackAuthorizationPort = createCoreAttendanceImportRollbackAuthorizationPortV1(
    async (transaction, input) => {
      if (!['attendance_admin', 'platform_admin'].includes(input.authorization.actorPosture)) {
        throw new AttendanceImportRollbackError('IMPORT_ROLLBACK_AUTHORIZATION_STALE')
      }
      await recheckAttendanceFullImportAuthorizationInTransactionV1(
        transaction,
        input.authorization,
      )
    },
  )

  async function sourceBatch(
    batchId: string,
    fingerprint: string,
    options: {
      orgId?: string
      actorId?: string
      subjectUserIds?: readonly string[]
      actorPosture?: 'delegated_import' | 'attendance_admin' | 'platform_admin'
    } = {},
  ): Promise<void> {
    const batchOrgId = options.orgId ?? orgId
    const batchActorId = options.actorId ?? actorId
    const batchActorPosture = options.actorPosture ?? 'delegated_import'
    const subjectUserIds = options.subjectUserIds ?? [batchActorId]
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO attendance_result_operation_batches (
           org_id, entrypoint, batch_command_id, identity_source_kind, source_root_id,
           source_ref, actor_id, actor_posture, token_subject_user_id, capability,
           subject_scope, accepted_write_posture, command_fingerprint, item_count,
           item_sequence_fingerprint, item_set_fingerprint, state
         ) VALUES ($1, 'import_batch', $2, 'import_batch', $2, $3, $4,
           $5, NULL, 'import', $6::jsonb, 'authoritative', $7,
           0 + 1, $8, $9, 'claimed')`,
        [
          batchOrgId,
          batchId,
          'test:w4c3a-import-rollback',
          batchActorId,
          batchActorPosture,
          JSON.stringify({ kind: 'explicit_users', userIds: subjectUserIds }),
          fingerprint,
          hex('b'),
          hex('c'),
        ],
      )
      await client.query(
        `INSERT INTO attendance_result_operations (
           org_id, entrypoint, operation_id, batch_command_id, input_ordinal,
           identity_source_kind, source_root_id, proof_semantic_fingerprint,
           source_ref, actor_id, actor_posture, token_subject_user_id, capability,
           subject_scope, command_fingerprint, accepted_write_posture,
           normalized_business_input_snapshot, state
         ) VALUES ($1, 'import_batch', attendance_w4_uuidv5(
             '6f67fdaa-e2aa-48b3-b76c-c4aab9723173'::uuid,
             attendance_w4_item_name_bytes($2::uuid, 0, $3)),
           $2, 0, 'import_item', $2, $3, $4, $5, $6, NULL,
           'import', $7::jsonb, $8, 'authoritative', '{}'::jsonb, 'claimed')`,
        [
          batchOrgId,
          batchId,
          hex('d'),
          'test:w4c3a-import-rollback',
          batchActorId,
          batchActorPosture,
          JSON.stringify({ kind: 'explicit_users', userIds: subjectUserIds }),
          fingerprint,
        ],
      )
      await client.query(
        `UPDATE attendance_result_operations
            SET state = 'completed', response_snapshot = '{}'::jsonb,
                updated_at = now(), version = version + 1
          WHERE org_id = $1 AND entrypoint = 'import_batch' AND batch_command_id = $2`,
        [batchOrgId, batchId],
      )
      await client.query(
        `UPDATE attendance_result_operation_batches
            SET state = 'completed', response_snapshot = '{}'::jsonb,
                updated_at = now(), version = version + 1
          WHERE org_id = $1 AND entrypoint = 'import_batch' AND batch_command_id = $2`,
        [batchOrgId, batchId],
      )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async function importedRecord(input: {
    batchId: string
    preimage: 'absent' | 'active' | 'retired'
    workDate: string
    workMinutes: number
    fabricateFingerprint?: boolean
    mutateProjectionWithoutFingerprint?: boolean
    orgId?: string
  }): Promise<{
    recordId: string
    calculationId: string
    userId: string
    projection: {
      firstInAt: null
      lastOutAt: null
      workMinutes: number
      lateMinutes: number
      earlyLeaveMinutes: number
      status: string
    }
  }> {
    const recordOrgId = input.orgId ?? orgId
    const recordId = id()
    const calculationId = id()
    const userId = id()
    const projection = {
      firstInAt: null,
      lastOutAt: null,
      workMinutes: 120,
      lateMinutes: 0,
      earlyLeaveMinutes: 0,
      status: 'normal',
    }
    const visibilityState = input.preimage === 'active' ? 'active' as const : 'retired' as const
    const visibilityReason = input.preimage === 'active' ? 'active' as const : 'review_placeholder' as const
    const fingerprintInput = {
      projection,
      projectionOwner: 'legacy_untracked' as const,
      currentCalculationId: null,
      visibilityState,
      visibilityReason,
    }
    const compatibilityFingerprint = computeAttendanceImportRollbackPreimageFingerprintV1(
      fingerprintInput,
    )
    const storedProjection = input.mutateProjectionWithoutFingerprint
      ? { ...projection, workMinutes: projection.workMinutes + 1 }
      : projection
    const preimage =
      input.preimage === 'absent'
        ? { posture: 'absent' as const }
        : {
            posture: 'present' as const,
            projectionOwner: 'legacy_untracked' as const,
            currentCalculationId: null,
            visibilityState,
            visibilityReason,
            compatibilityFingerprint:
              input.fabricateFingerprint
                ? hex('f')
                : compatibilityFingerprint,
            projection: storedProjection,
          }
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO attendance_records (
           id, user_id, work_date, first_in_at, last_out_at, work_minutes,
           late_minutes, early_leave_minutes, status, org_id, is_workday,
           meta, source_batch_id)
         VALUES ($1, $2, $3, '2026-07-31T01:00:00Z', '2026-07-31T09:00:00Z',
           $4, 1, 2, 'late', $5, true, '{"imported":true}'::jsonb,
           CASE WHEN $6 = 'absent' THEN $7::uuid ELSE NULL END)`,
        [recordId, userId, input.workDate, input.workMinutes, recordOrgId, input.preimage, input.batchId],
      )
      await client.query(
        `INSERT INTO test_attendance_import_delegated_scopes (
           actor_id, org_id, user_id, group_ref, is_active)
         VALUES ($1, $2, $3, 'group-a', true)`,
        [actorId, recordOrgId, userId],
      )
      await client.query(
        `INSERT INTO attendance_record_calculations (
           id, org_id, attendance_record_id, version, calculation_kind, mode,
           entrypoint, engine_version, snapshot_schema_version, source_batch_id,
           operation_id, semantic_input_fingerprint, provenance_fingerprint,
           source_definition_fingerprint, attribution_snapshot, context_snapshot,
           segment_snapshot, evidence_snapshot, approved_facts_snapshot,
           input_provenance, merge_policy, calculation_tier, outcome,
           outcome_reason_code, projection_effect, expected_segment_count,
           projected_status, projected_first_in_at, projected_last_out_at,
           projected_work_minutes, projected_late_minutes,
           projected_early_leave_minutes, projected_daily_fingerprint,
           parent_preimage_snapshot, actor_id, correlation_id
         ) VALUES ($1, $2, $3, 1, 'calculation', 'authoritative', 'legacy_import',
           'fixture-v1', 1, $4, $5, $6, $7, $8,
           '{"posture":"resolved_v2"}'::jsonb, '{}'::jsonb, '[]'::jsonb,
           '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, 'merge',
           'segment_authoritative', 'completed', 'calculated', 'set_active', 1,
           'late', '2026-07-31T01:00:00Z', '2026-07-31T09:00:00Z', $9, 1, 2,
           $10, $11::jsonb, $12, $13)`,
        [
          calculationId,
          recordOrgId,
          recordId,
          input.batchId,
          id(),
          hex('1'),
          hex('2'),
          hex('3'),
          input.workMinutes,
          hex('4'),
          JSON.stringify(preimage),
          actorId,
          `fixture-${run}`,
        ],
      )
      await client.query(
        `INSERT INTO attendance_record_segments (
           org_id, record_id, calculation_id, segment_index, expected_start_at,
           expected_end_at, actual_in_at, actual_out_at, work_minutes,
           late_minutes, early_leave_minutes, status, status_reasons,
           matched_evidence_refs, unmatched_evidence_refs)
         VALUES ($1, $2, $3, 0, '2026-07-31T01:00:00Z', '2026-07-31T09:00:00Z',
           '2026-07-31T01:00:00Z', '2026-07-31T09:00:00Z', $4, 1, 2, 'late',
           '["late_check_in"]'::jsonb, '[]'::jsonb, '[]'::jsonb)`,
        [recordOrgId, recordId, calculationId, input.workMinutes],
      )
      await client.query(
        `UPDATE attendance_records
            SET projection_owner = 'w4', current_calculation_id = $3,
                visibility_state = 'active', visibility_reason = 'active'
          WHERE org_id = $1 AND id = $2`,
        [recordOrgId, recordId, calculationId],
      )
      await client.query('COMMIT')
      return { recordId, calculationId, userId, projection }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  function rollbackCommand(input: {
    batchId: string
    fingerprint: string
    targets: readonly { recordId: string }[]
    rollbackOperationId?: string
    auth?: ReturnType<typeof authorization>
    correlationId?: string
  }) {
    return createFrozenAttendanceImportRollbackCommandV1({
      orgId: input.auth?.orgId ?? orgId,
      rollbackOperationId: input.rollbackOperationId ?? id(),
      sourceBatchEntrypoint: 'import_batch',
      sourceBatchId: input.batchId,
      expectedSourceBatchFingerprint: input.fingerprint,
      authorization: input.auth ?? authorization(),
      correlationId: input.correlationId ?? `rollback-${id()}`,
      targets: input.targets.map((target) => ({
        attendanceRecordId: target.recordId,
        reversalOperationId: id(),
        reversalCalculationId: id(),
      })),
    })
  }

  async function rollbackResidue(batchId: string): Promise<{
    commands: number
    reversals: number
    witnesses: number
  }> {
    const result = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM attendance_import_rollback_commands
           WHERE source_batch_id = $1) AS commands,
         (SELECT count(*)::int FROM attendance_record_calculations
           WHERE source_batch_id = $1 AND entrypoint = 'import_rollback') AS reversals,
         (SELECT count(*)::int FROM attendance_import_rollback_restore_witnesses
           WHERE source_batch_id = $1) AS witnesses`,
      [batchId],
    )
    return result.rows[0]
  }

  async function insertCalculation(
    client: PoolClient,
    input: {
      recordId: string
      version: number
      calculationId?: string
      kind?: 'legacy_baseline' | 'calculation'
      outcome?: 'baseline' | 'completed' | 'review_required'
      entrypoint?: 'live' | 'correction' | 'recompute'
      supersedesCalculationId?: string | null
      updateParent?: boolean
      workMinutes?: number
    },
  ): Promise<string> {
    const calculationId = input.calculationId ?? id()
    const kind = input.kind ?? 'calculation'
    const outcome = input.outcome ?? 'completed'
    const completed = outcome === 'completed'
    const baseline = outcome === 'baseline'
    const workMinutes = input.workMinutes ?? 240
    await client.query(
      `INSERT INTO attendance_record_calculations (
         id, org_id, attendance_record_id, version, calculation_kind, mode,
         entrypoint, engine_version, snapshot_schema_version,
         supersedes_calculation_id, operation_id, semantic_input_fingerprint,
         provenance_fingerprint, source_definition_fingerprint,
         attribution_snapshot, context_snapshot, segment_snapshot,
         evidence_snapshot, approved_facts_snapshot, input_provenance,
         merge_policy, calculation_tier, outcome, outcome_reason_code,
         projection_effect, expected_segment_count, projected_status,
         projected_first_in_at, projected_last_out_at, projected_work_minutes,
         projected_late_minutes, projected_early_leave_minutes,
         projected_daily_fingerprint, actor_id, correlation_id
       ) VALUES (
         $1, $2, $3, $4, $5, 'authoritative', $6, 'fixture-next-v1', 1,
         $7, $8, $9, $10, $11,
         '{"posture":"resolved_v2"}'::jsonb, '{}'::jsonb, '[]'::jsonb,
         '[]'::jsonb, '[]'::jsonb, '{}'::jsonb,
         'merge', 'segment_authoritative', $12, $13, $14, $15,
         $16, $17, $18, $19, $20, $21, $22, $23, $24)`,
      [
        calculationId,
        orgId,
        input.recordId,
        input.version,
        kind,
        input.entrypoint ?? (baseline ? 'recompute' : 'live'),
        input.supersedesCalculationId ?? null,
        baseline ? null : id(),
        hex('1'),
        hex('2'),
        hex('3'),
        outcome,
        baseline
          ? 'legacy_projection_baseline'
          : completed
            ? 'calculated'
            : 'context_mismatch',
        completed ? 'set_active' : 'none',
        completed ? 1 : 0,
        completed || baseline ? 'normal' : null,
        null,
        null,
        completed || baseline ? workMinutes : null,
        completed || baseline ? 0 : null,
        completed || baseline ? 0 : null,
        completed || baseline ? hex('6') : null,
        actorId,
        `next-${id()}`,
      ],
    )
    if (completed) {
      await client.query(
        `INSERT INTO attendance_record_segments (
           org_id, record_id, calculation_id, segment_index,
           expected_start_at, expected_end_at, work_minutes, late_minutes,
           early_leave_minutes, status, status_reasons,
           matched_evidence_refs, unmatched_evidence_refs)
         VALUES ($1, $2, $3, 0, '2026-08-01T01:00:00Z',
           '2026-08-01T09:00:00Z', $4, 0, 0, 'normal', '["within_window"]'::jsonb,
           '[]'::jsonb, '[]'::jsonb)`,
        [orgId, input.recordId, calculationId, workMinutes],
      )
      if (input.updateParent) {
        await client.query(
          `UPDATE attendance_records
              SET current_calculation_id = $3, projection_owner = 'w4',
                  visibility_state = 'active', visibility_reason = 'active',
                  status = 'normal', first_in_at = NULL, last_out_at = NULL,
                  work_minutes = $4, late_minutes = 0, early_leave_minutes = 0
            WHERE org_id = $1 AND id = $2`,
          [orgId, input.recordId, calculationId, workMinutes],
        )
      }
    }
    return calculationId
  }

  async function runSingleRollback(input: {
    preimage: 'absent' | 'active' | 'retired'
    workDate: string
    importedWorkMinutes?: number
  }) {
    const batchId = id()
    const fingerprint = crypto.createHash('sha256').update(batchId).digest('hex')
    await sourceBatch(batchId, fingerprint)
    const target = await importedRecord({
      batchId,
      preimage: input.preimage,
      workDate: input.workDate,
      workMinutes: input.importedWorkMinutes ?? 480,
    })
    const command = rollbackCommand({ batchId, fingerprint, targets: [target] })
    const client = await pool.connect()
    try {
      const result = await rollbackAttendanceImportV1(trx(client), command, rollbackAuthorizationPort)
      return { batchId, fingerprint, target, command, result }
    } finally {
      client.release()
    }
  }

  it('matches the app golden in SQL and changes for one frozen-domain field', async () => {
    const input = {
      projection: {
        status: 'normal',
        firstInAt: '2026-07-31T01:00:00.000Z',
        lastOutAt: '2026-07-31T09:00:00.000Z',
        workMinutes: 480,
        lateMinutes: 0,
        earlyLeaveMinutes: 0,
      },
      projectionOwner: 'legacy_untracked' as const,
      currentCalculationId: null,
      visibilityState: 'active' as const,
      visibilityReason: 'active' as const,
    }
    const appFingerprint = computeAttendanceImportRollbackPreimageFingerprintV1(input)
    const sqlFingerprint = await pool.query(
      `SELECT attendance_w4c3a_rollback_preimage_fingerprint($1::jsonb) AS fingerprint`,
      [JSON.stringify({ posture: 'present', ...input, compatibilityFingerprint: hex('0') })],
    )
    expect(sqlFingerprint.rows[0].fingerprint).toBe(appFingerprint)
    const mutated = await pool.query(
      `SELECT attendance_w4c3a_rollback_preimage_fingerprint($1::jsonb) AS fingerprint`,
      [
        JSON.stringify({
          posture: 'present',
          ...input,
          projection: { ...input.projection, workMinutes: 481 },
          compatibilityFingerprint: appFingerprint,
        }),
      ],
    )
    expect(mutated.rows[0].fingerprint).not.toBe(appFingerprint)
  })

  it('absent preimage retires the first import with the exact imported after-image', async () => {
    const { batchId, target, result } = await runSingleRollback({
      preimage: 'absent',
      workDate: '2026-08-04',
      importedWorkMinutes: 455,
    })
    const parent = await pool.query(
      `SELECT projection_owner, current_calculation_id::text, visibility_state,
              visibility_reason, status, first_in_at::text, last_out_at::text,
              work_minutes, late_minutes, early_leave_minutes
         FROM attendance_records WHERE org_id = $1 AND id = $2`,
      [orgId, target.recordId],
    )
    expect(parent.rows[0]).toEqual({
      projection_owner: 'w4',
      current_calculation_id: result.reversalCalculationIds[0],
      visibility_state: 'retired',
      visibility_reason: 'import_rollback',
      status: 'late',
      first_in_at: '2026-07-31 09:00:00+08',
      last_out_at: '2026-07-31 17:00:00+08',
      work_minutes: 455,
      late_minutes: 1,
      early_leave_minutes: 2,
    })
    const reversal = await pool.query(
      `SELECT projected_status, projected_first_in_at::text,
              projected_last_out_at::text, projected_work_minutes,
              projected_late_minutes, projected_early_leave_minutes,
              restores_calculation_id
         FROM attendance_record_calculations WHERE id = $1`,
      [result.reversalCalculationIds[0]],
    )
    expect(reversal.rows[0]).toEqual({
      projected_status: 'late',
      projected_first_in_at: '2026-07-31 09:00:00+08',
      projected_last_out_at: '2026-07-31 17:00:00+08',
      projected_work_minutes: 455,
      projected_late_minutes: 1,
      projected_early_leave_minutes: 2,
      restores_calculation_id: null,
    })
    expect(await rollbackResidue(batchId)).toEqual({ commands: 1, reversals: 1, witnesses: 0 })
    expect((await pool.query(
      'SELECT parent_preimage_snapshot FROM attendance_record_calculations WHERE id = $1',
      [target.calculationId],
    )).rows[0].parent_preimage_snapshot).toEqual({ posture: 'absent' })
  }, 60000)

  it('present active preimage restores the exact active legacy tuple', async () => {
    const { batchId, target } = await runSingleRollback({
      preimage: 'active',
      workDate: '2026-08-05',
    })
    expect((await pool.query(
      `SELECT projection_owner, current_calculation_id, visibility_state,
              visibility_reason, status, first_in_at, last_out_at,
              work_minutes, late_minutes, early_leave_minutes
         FROM attendance_records WHERE id = $1`,
      [target.recordId],
    )).rows[0]).toEqual({
      projection_owner: 'legacy_untracked',
      current_calculation_id: null,
      visibility_state: 'active',
      visibility_reason: 'active',
      status: 'normal',
      first_in_at: null,
      last_out_at: null,
      work_minutes: 120,
      late_minutes: 0,
      early_leave_minutes: 0,
    })
    expect(await rollbackResidue(batchId)).toEqual({ commands: 1, reversals: 1, witnesses: 1 })
  }, 60000)

  it('present retired review-placeholder preimage remains exactly retired', async () => {
    const { batchId, target } = await runSingleRollback({
      preimage: 'retired',
      workDate: '2026-08-06',
    })
    expect((await pool.query(
      `SELECT projection_owner, current_calculation_id, visibility_state,
              visibility_reason, status, work_minutes
         FROM attendance_records WHERE id = $1`,
      [target.recordId],
    )).rows[0]).toEqual({
      projection_owner: 'legacy_untracked',
      current_calculation_id: null,
      visibility_state: 'retired',
      visibility_reason: 'review_placeholder',
      status: 'normal',
      work_minutes: 120,
    })
    expect(await rollbackResidue(batchId)).toEqual({ commands: 1, reversals: 1, witnesses: 1 })
  }, 60000)

  it('same command replay returns the prior reversal without duplicate effects', async () => {
    const { batchId, command, result } = await runSingleRollback({
      preimage: 'absent',
      workDate: '2026-08-07',
    })
    const client = await pool.connect()
    try {
      const replay = await rollbackAttendanceImportV1(trx(client), command, rollbackAuthorizationPort)
      expect(replay).toEqual({ ...result, replayed: true })
    } finally {
      client.release()
    }
    expect(await rollbackResidue(batchId)).toEqual({ commands: 1, reversals: 1, witnesses: 0 })
  }, 60000)

  it.each([
    ['fabricated fingerprint', { fabricateFingerprint: true }],
    ['one-field projection mutation', { mutateProjectionWithoutFingerprint: true }],
  ])('rejects %s before rollback DML', async (_label, fixtureOptions) => {
    const batchId = id()
    const fingerprint = hex('8')
    await sourceBatch(batchId, fingerprint)
    const target = await importedRecord({
      batchId,
      preimage: 'retired',
      workDate: `2026-08-${fixtureOptions.fabricateFingerprint ? '02' : '03'}`,
      workMinutes: 420,
      ...fixtureOptions,
    })
    const command = createFrozenAttendanceImportRollbackCommandV1({
      orgId,
      rollbackOperationId: id(),
      sourceBatchEntrypoint: 'import_batch',
      sourceBatchId: batchId,
      expectedSourceBatchFingerprint: fingerprint,
      authorization: authorization(),
      correlationId: `invalid-preimage-${run}`,
      targets: [{
        attendanceRecordId: target.recordId,
        reversalOperationId: id(),
        reversalCalculationId: id(),
      }],
    })
    const client = await pool.connect()
    try {
      await expect(rollbackAttendanceImportV1(trx(client), command, rollbackAuthorizationPort)).rejects.toMatchObject({
        code: 'IMPORT_ROLLBACK_PREIMAGE_INVALID',
      } satisfies Partial<AttendanceImportRollbackError>)
      expect((await pool.query(
        'SELECT count(*)::int AS n FROM attendance_import_rollback_commands WHERE source_batch_id = $1',
        [batchId],
      )).rows[0].n).toBe(0)
      expect((await pool.query(
        "SELECT count(*)::int AS n FROM attendance_record_calculations WHERE source_batch_id = $1 AND entrypoint = 'import_rollback'",
        [batchId],
      )).rows[0].n).toBe(0)
    } finally {
      client.release()
    }
  }, 60000)

  it('binds command and witness to one current transaction XID', async () => {
    const { batchId, result } = await runSingleRollback({
      preimage: 'active',
      workDate: '2026-08-08',
    })
    const xids = await pool.query(
      `SELECT command.writer_xid::text AS command_xid,
              witness.writer_xid::text AS witness_xid
         FROM attendance_import_rollback_commands command
         JOIN attendance_import_rollback_restore_witnesses witness
           ON witness.org_id = command.org_id
          AND witness.rollback_operation_id = command.rollback_operation_id
        WHERE command.source_batch_id = $1
          AND witness.reversal_calculation_id = $2`,
      [batchId, result.reversalCalculationIds[0]],
    )
    expect(xids.rows).toHaveLength(1)
    expect(xids.rows[0].command_xid).toMatch(/^[0-9]+$/)
    expect(xids.rows[0].witness_xid).toBe(xids.rows[0].command_xid)

    const staleBatchId = id()
    const fingerprint = hex('7')
    await sourceBatch(staleBatchId, fingerprint)
    const operationId = id()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO attendance_result_operations (
           org_id, entrypoint, operation_id, identity_source_kind, source_ref,
           actor_id, actor_posture, capability, subject_scope,
           command_fingerprint, accepted_write_posture, state)
         VALUES ($1, 'import_rollback', $2, 'direct_import_rollback', $3,
           $4, 'delegated_import', 'rollback', $5::jsonb, $6,
           'authoritative', 'claimed')`,
        [
          orgId,
          operationId,
          'test:w4c3a-import-rollback',
          actorId,
          JSON.stringify({ kind: 'explicit_users', userIds: [actorId] }),
          hex('5'),
        ],
      )
      await expect(client.query(
        `INSERT INTO attendance_import_rollback_commands (
           org_id, rollback_operation_id, rollback_entrypoint,
           source_batch_entrypoint, source_batch_id, writer_xid,
           actor_id, actor_posture, correlation_id)
         VALUES ($1, $2, 'import_rollback', 'import_batch', $3, '1'::xid8,
           $4, 'delegated_import', 'stale-xid')`,
        [orgId, operationId, staleBatchId, actorId],
      )).rejects.toThrow(/writer xid mismatch/)
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
    expect(await rollbackResidue(staleBatchId)).toEqual({ commands: 0, reversals: 0, witnesses: 0 })
  }, 60000)

  it('rejects reuse of one rollback operation for another source batch', async () => {
    const first = await runSingleRollback({
      preimage: 'absent',
      workDate: '2026-08-09',
    })
    const secondBatchId = id()
    const secondFingerprint = hex('4')
    await sourceBatch(secondBatchId, secondFingerprint)
    const secondTarget = await importedRecord({
      batchId: secondBatchId,
      preimage: 'absent',
      workDate: '2026-08-10',
      workMinutes: 300,
    })
    const conflicting = rollbackCommand({
      batchId: secondBatchId,
      fingerprint: secondFingerprint,
      targets: [secondTarget],
      rollbackOperationId: first.command.rollbackOperationId,
      correlationId: first.command.correlationId,
    })
    const client = await pool.connect()
    try {
      await expect(rollbackAttendanceImportV1(trx(client), conflicting, rollbackAuthorizationPort)).rejects.toMatchObject({
        code: 'IMPORT_ROLLBACK_CONFLICT',
      } satisfies Partial<AttendanceImportRollbackError>)
    } finally {
      client.release()
    }
    expect(await rollbackResidue(secondBatchId)).toEqual({ commands: 0, reversals: 0, witnesses: 0 })
  }, 60000)

  it('rolls back every row when the second reversal insert fails', async () => {
    const batchId = id()
    const fingerprint = hex('3')
    await sourceBatch(batchId, fingerprint)
    const targets = await Promise.all([
      importedRecord({ batchId, preimage: 'absent', workDate: '2026-08-11', workMinutes: 401 }),
      importedRecord({ batchId, preimage: 'active', workDate: '2026-08-12', workMinutes: 402 }),
    ])
    const command = rollbackCommand({ batchId, fingerprint, targets })
    const client = await pool.connect()
    const base = trx(client)
    let reversalInsertCount = 0
    const injected: AttendanceW4TransactionClientV1 = {
      query: async (statement, values) => {
        if (statement.includes('INSERT INTO attendance_record_calculations')) {
          reversalInsertCount += 1
          if (reversalInsertCount === 2) throw new Error('INJECTED_SECOND_REVERSAL_FAILURE')
        }
        return base.query(statement, values)
      },
    }
    try {
      await expect(rollbackAttendanceImportV1(injected, command, rollbackAuthorizationPort)).rejects.toThrow(
        'INJECTED_SECOND_REVERSAL_FAILURE',
      )
    } finally {
      client.release()
    }
    expect(reversalInsertCount).toBe(2)
    expect(await rollbackResidue(batchId)).toEqual({ commands: 0, reversals: 0, witnesses: 0 })
    const parents = await pool.query(
      `SELECT id::text, current_calculation_id::text, projection_owner
         FROM attendance_records WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [targets.map((target) => target.recordId)],
    )
    expect(parents.rows).toEqual(
      [...targets]
        .sort((left, right) => left.recordId.localeCompare(right.recordId))
        .map((target) => ({
          id: target.recordId,
          current_calculation_id: target.calculationId,
          projection_owner: 'w4',
        })),
    )
  }, 60000)

  it('serializes two connections for the same command into one execution and one replay', async () => {
    const batchId = id()
    const fingerprint = hex('2')
    await sourceBatch(batchId, fingerprint)
    const target = await importedRecord({
      batchId,
      preimage: 'active',
      workDate: '2026-08-13',
      workMinutes: 390,
    })
    const command = rollbackCommand({ batchId, fingerprint, targets: [target] })
    const first = await pool.connect()
    const second = await pool.connect()
    try {
      const results = await Promise.all([
        rollbackAttendanceImportV1(trx(first), command, rollbackAuthorizationPort),
        rollbackAttendanceImportV1(trx(second), command, rollbackAuthorizationPort),
      ])
      expect(results.map((result) => result.replayed).sort()).toEqual([false, true])
      expect(results[0].reversalCalculationIds).toEqual(results[1].reversalCalculationIds)
    } finally {
      first.release()
      second.release()
    }
    expect(await rollbackResidue(batchId)).toEqual({ commands: 1, reversals: 1, witnesses: 1 })
  }, 60000)

  it('rejects a command whose target calculation belongs to another source batch', async () => {
    const actualBatchId = id()
    const requestedBatchId = id()
    const actualFingerprint = hex('1')
    const requestedFingerprint = hex('2')
    await sourceBatch(actualBatchId, actualFingerprint)
    await sourceBatch(requestedBatchId, requestedFingerprint)
    const target = await importedRecord({
      batchId: actualBatchId,
      preimage: 'absent',
      workDate: '2026-08-14',
      workMinutes: 360,
    })
    const command = rollbackCommand({
      batchId: requestedBatchId,
      fingerprint: requestedFingerprint,
      targets: [target],
    })
    const client = await pool.connect()
    try {
      await expect(rollbackAttendanceImportV1(trx(client), command, rollbackAuthorizationPort)).rejects.toMatchObject({
        code: 'IMPORT_ROLLBACK_SUPERSEDED',
      } satisfies Partial<AttendanceImportRollbackError>)
    } finally {
      client.release()
    }
    expect(await rollbackResidue(requestedBatchId)).toEqual({ commands: 0, reversals: 0, witnesses: 0 })
    expect((await pool.query(
      'SELECT current_calculation_id::text FROM attendance_records WHERE id = $1',
      [target.recordId],
    )).rows[0].current_calculation_id).toBe(target.calculationId)
  }, 60000)

  it('blocks the whole batch after a later punch changes one current calculation', async () => {
    const batchId = id()
    const fingerprint = hex('3')
    await sourceBatch(batchId, fingerprint)
    const untouched = await importedRecord({
      batchId,
      preimage: 'absent',
      workDate: '2026-08-15',
      workMinutes: 410,
    })
    const changed = await importedRecord({
      batchId,
      preimage: 'active',
      workDate: '2026-08-16',
      workMinutes: 420,
    })
    const writer = await pool.connect()
    let laterCalculationId = ''
    try {
      await writer.query('BEGIN')
      laterCalculationId = await insertCalculation(writer, {
        recordId: changed.recordId,
        version: 2,
        entrypoint: 'live',
        supersedesCalculationId: changed.calculationId,
        updateParent: true,
        workMinutes: 421,
      })
      await writer.query('COMMIT')
    } catch (error) {
      await writer.query('ROLLBACK')
      throw error
    } finally {
      writer.release()
    }
    const command = rollbackCommand({ batchId, fingerprint, targets: [untouched, changed] })
    const client = await pool.connect()
    try {
      await expect(rollbackAttendanceImportV1(trx(client), command, rollbackAuthorizationPort)).rejects.toMatchObject({
        code: 'IMPORT_ROLLBACK_SUPERSEDED',
      } satisfies Partial<AttendanceImportRollbackError>)
    } finally {
      client.release()
    }
    expect(await rollbackResidue(batchId)).toEqual({ commands: 0, reversals: 0, witnesses: 0 })
    const pointers = await pool.query(
      `SELECT id::text, current_calculation_id::text FROM attendance_records
        WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[untouched.recordId, changed.recordId]],
    )
    expect(pointers.rows).toEqual(
      [
        { id: untouched.recordId, current_calculation_id: untouched.calculationId },
        { id: changed.recordId, current_calculation_id: laterCalculationId },
      ].sort((left, right) => left.id.localeCompare(right.id)),
    )
  }, 60000)

  it('rejects direct legacy pointer clear without a restore witness', async () => {
    const batchId = id()
    const fingerprint = hex('4')
    await sourceBatch(batchId, fingerprint)
    const target = await importedRecord({
      batchId,
      preimage: 'active',
      workDate: '2026-08-17',
      workMinutes: 430,
    })
    await expect(pool.query(
      `UPDATE attendance_records
          SET projection_owner = 'legacy_untracked', current_calculation_id = NULL,
              visibility_state = 'active', visibility_reason = 'active',
              status = 'normal', first_in_at = NULL, last_out_at = NULL,
              work_minutes = 120, late_minutes = 0, early_leave_minutes = 0
        WHERE org_id = $1 AND id = $2`,
      [orgId, target.recordId],
    )).rejects.toThrow(/parent cannot return to legacy_untracked/)
    expect((await pool.query(
      'SELECT current_calculation_id::text FROM attendance_records WHERE id = $1',
      [target.recordId],
    )).rows[0].current_calculation_id).toBe(target.calculationId)
  })

  it('rejects an already closed import batch before reversal DML', async () => {
    const batchId = id()
    const fingerprint = hex('4')
    await sourceBatch(batchId, fingerprint)
    const target = await importedRecord({
      batchId,
      preimage: 'absent',
      workDate: '2026-08-17',
      workMinutes: 431,
    })
    await pool.query(
      `INSERT INTO attendance_import_rollback_closures (
         org_id, batch_id, batch_fingerprint, actor_id,
         actor_authorization_posture, reason_code, correlation_id)
       VALUES ($1, $2, $3, $4, 'delegated_import',
         'preimage_unavailable', 'closed-before-rollback')`,
      [orgId, batchId, fingerprint, actorId],
    )
    const command = rollbackCommand({ batchId, fingerprint, targets: [target] })
    const client = await pool.connect()
    try {
      await expect(rollbackAttendanceImportV1(trx(client), command, rollbackAuthorizationPort)).rejects.toMatchObject({
        code: 'IMPORT_ROLLBACK_CONFLICT',
      } satisfies Partial<AttendanceImportRollbackError>)
    } finally {
      client.release()
    }
    expect(await rollbackResidue(batchId)).toEqual({ commands: 0, reversals: 0, witnesses: 0 })
  }, 60000)

  it('P23 rejects a same-org different importer before reversal DML', async () => {
    const otherActor = id()
    await pool.query('INSERT INTO users (id) VALUES ($1)', [otherActor])
    await pool.query('INSERT INTO user_orgs (user_id, org_id) VALUES ($1, $2)', [otherActor, orgId])
    await pool.query("INSERT INTO user_namespace_admissions VALUES ($1, 'attendance', true)", [otherActor])
    await pool.query("INSERT INTO user_roles VALUES ($1, 'attendance_admin')", [otherActor])
    const batchId = id()
    const fingerprint = hex('5')
    await sourceBatch(batchId, fingerprint)
    const target = await importedRecord({
      batchId,
      preimage: 'absent',
      workDate: '2026-08-18',
      workMinutes: 440,
    })
    const command = rollbackCommand({
      batchId,
      fingerprint,
      targets: [target],
      auth: authorization(otherActor),
    })
    const client = await pool.connect()
    try {
      await expect(rollbackAttendanceImportV1(trx(client), command, rollbackAuthorizationPort)).rejects.toMatchObject({
        code: 'IMPORT_ROLLBACK_AUTHORIZATION_STALE',
      } satisfies Partial<AttendanceImportRollbackError>)
    } finally {
      client.release()
    }
    expect(await rollbackResidue(batchId)).toEqual({ commands: 0, reversals: 0, witnesses: 0 })
  }, 60000)

  it('P23 rejects an inactive org membership before reversal DML', async () => {
    const inactiveActor = id()
    await pool.query('INSERT INTO users (id) VALUES ($1)', [inactiveActor])
    await pool.query(
      'INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, false)',
      [inactiveActor, orgId],
    )
    await pool.query("INSERT INTO user_namespace_admissions VALUES ($1, 'attendance', true)", [inactiveActor])
    await pool.query("INSERT INTO user_roles VALUES ($1, 'attendance_admin')", [inactiveActor])
    const batchId = id()
    const fingerprint = hex('6')
    await sourceBatch(batchId, fingerprint, { actorId: inactiveActor })
    const target = await importedRecord({
      batchId,
      preimage: 'absent',
      workDate: '2026-08-19',
      workMinutes: 450,
    })
    const command = rollbackCommand({
      batchId,
      fingerprint,
      targets: [target],
      auth: authorization(inactiveActor),
    })
    const client = await pool.connect()
    try {
      await expect(rollbackAttendanceImportV1(trx(client), command, rollbackAuthorizationPort)).rejects.toThrow(
        /ATTENDANCE_WRITE_NOT_AUTHORIZED/,
      )
    } finally {
      client.release()
    }
    expect(await rollbackResidue(batchId)).toEqual({ commands: 0, reversals: 0, witnesses: 0 })
  }, 60000)

  it('P23 rejects a cross-org target before reversal DML', async () => {
    const otherOrgId = id()
    await pool.query('INSERT INTO user_orgs (user_id, org_id) VALUES ($1, $2)', [actorId, otherOrgId])
    const batchId = id()
    const fingerprint = hex('7')
    await sourceBatch(batchId, fingerprint, { orgId: otherOrgId })
    const foreignTarget = await importedRecord({
      batchId,
      preimage: 'absent',
      workDate: '2026-08-20',
      workMinutes: 460,
    })
    const command = rollbackCommand({
      batchId,
      fingerprint,
      targets: [foreignTarget],
      auth: authorization(actorId, otherOrgId),
    })
    const client = await pool.connect()
    try {
      await expect(rollbackAttendanceImportV1(trx(client), command, rollbackAuthorizationPort)).rejects.toMatchObject({
        code: 'IMPORT_ROLLBACK_NOT_FOUND',
      } satisfies Partial<AttendanceImportRollbackError>)
    } finally {
      client.release()
    }
    expect(await rollbackResidue(batchId)).toEqual({ commands: 0, reversals: 0, witnesses: 0 })
    expect((await pool.query(
      'SELECT current_calculation_id::text FROM attendance_records WHERE id = $1',
      [foreignTarget.recordId],
    )).rows[0].current_calculation_id).toBe(foreignTarget.calculationId)
  }, 60000)

  it('P23 rejects a wrong delegated group before reversal DML', async () => {
    const batchId = id()
    const fingerprint = hex('8')
    await sourceBatch(batchId, fingerprint)
    const target = await importedRecord({
      batchId,
      preimage: 'absent',
      workDate: '2026-08-21',
      workMinutes: 470,
    })
    await pool.query(
      `UPDATE test_attendance_import_delegated_scopes
          SET group_ref = 'group-b'
        WHERE actor_id = $1 AND org_id = $2 AND user_id = $3`,
      [actorId, orgId, target.userId],
    )
    const command = rollbackCommand({ batchId, fingerprint, targets: [target] })
    const client = await pool.connect()
    try {
      await expect(
        rollbackAttendanceImportV1(trx(client), command, rollbackAuthorizationPort),
      ).rejects.toMatchObject({
        code: 'IMPORT_ROLLBACK_AUTHORIZATION_STALE',
      } satisfies Partial<AttendanceImportRollbackError>)
    } finally {
      client.release()
    }
    expect(await rollbackResidue(batchId)).toEqual({ commands: 0, reversals: 0, witnesses: 0 })
  }, 60000)

  it('P23 rejects a shape-forged authorization port before reversal DML', async () => {
    const batchId = id()
    const fingerprint = crypto.createHash('sha256').update(batchId).digest('hex')
    await sourceBatch(batchId, fingerprint)
    const target = await importedRecord({
      batchId,
      preimage: 'absent',
      workDate: '2026-08-28',
      workMinutes: 465,
    })
    const command = rollbackCommand({ batchId, fingerprint, targets: [target] })
    const forgedPort = Object.freeze({
      recheckInTransaction: async () => Object.freeze({}),
    }) as unknown as AttendanceImportRollbackAuthorizationPortV1
    const client = await pool.connect()
    try {
      await expect(
        rollbackAttendanceImportV1(trx(client), command, forgedPort),
      ).rejects.toMatchObject({
        code: 'IMPORT_ROLLBACK_AUTHORIZATION_STALE',
      } satisfies Partial<AttendanceImportRollbackError>)
    } finally {
      client.release()
    }
    expect(await rollbackResidue(batchId)).toEqual({ commands: 0, reversals: 0, witnesses: 0 })
  }, 60000)

  it.each(['attendance_admin', 'platform_admin'] as const)(
    'P23 permits the closed %s override posture after transaction recheck',
    async (actorPosture) => {
      const batchId = id()
      const fingerprint = crypto.createHash('sha256').update(batchId).digest('hex')
      await sourceBatch(batchId, fingerprint, { actorPosture })
      const target = await importedRecord({
        batchId,
        preimage: 'absent',
        workDate: actorPosture === 'attendance_admin' ? '2026-08-29' : '2026-08-30',
        workMinutes: 475,
      })
      const command = rollbackCommand({
        batchId,
        fingerprint,
        targets: [target],
        auth: authorization(actorId, orgId, [actorId], actorPosture),
      })
      const client = await pool.connect()
      try {
        const result = await rollbackAttendanceImportV1(
          trx(client),
          command,
          fullAdminRollbackAuthorizationPort,
        )
        expect(result.replayed).toBe(false)
      } finally {
        client.release()
      }
      expect(await rollbackResidue(batchId)).toEqual({ commands: 1, reversals: 1, witnesses: 0 })
    },
    60000,
  )

  it('keeps virgin legacy baseline lineage separate from witnessed restores', async () => {
    const recordId = id()
    await pool.query(
      `INSERT INTO attendance_records (
         id, user_id, work_date, org_id, status, work_minutes,
         late_minutes, early_leave_minutes, visibility_state, visibility_reason)
       VALUES ($1, $2, '2026-08-22', $3, 'normal', 120, 0, 0, 'active', 'active')`,
      [recordId, id(), orgId],
    )
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const baselineId = await insertCalculation(client, {
        recordId,
        version: 1,
        kind: 'legacy_baseline',
        outcome: 'baseline',
        workMinutes: 120,
      })
      const currentId = await insertCalculation(client, {
        recordId,
        version: 2,
        supersedesCalculationId: baselineId,
        updateParent: true,
        workMinutes: 240,
      })
      await client.query('COMMIT')
      expect((await pool.query(
        'SELECT current_calculation_id::text, projection_owner FROM attendance_records WHERE id = $1',
        [recordId],
      )).rows[0]).toEqual({ current_calculation_id: currentId, projection_owner: 'w4' })
      expect((await pool.query(
        'SELECT count(*)::int AS n FROM attendance_import_rollback_restore_witnesses WHERE attendance_record_id = $1',
        [recordId],
      )).rows[0].n).toBe(0)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }, 60000)

  it('allows review pass-through but requires the durable reversal for the next active source', async () => {
    const restored = await runSingleRollback({
      preimage: 'active',
      workDate: '2026-08-23',
    })
    const bridge = restored.result.reversalCalculationIds[0]
    const client = await pool.connect()
    let reviewId = ''
    try {
      await client.query('BEGIN')
      reviewId = await insertCalculation(client, {
        recordId: restored.target.recordId,
        version: 3,
        outcome: 'review_required',
        entrypoint: 'correction',
      })
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    }
    try {
      await client.query('BEGIN')
      await expect(insertCalculation(client, {
        recordId: restored.target.recordId,
        version: 4,
        entrypoint: 'live',
        supersedesCalculationId: reviewId,
        workMinutes: 250,
      })).rejects.toThrow(/witnessed legacy predecessor required/)
      await client.query('ROLLBACK')

      await client.query('BEGIN')
      const nextId = await insertCalculation(client, {
        recordId: restored.target.recordId,
        version: 4,
        entrypoint: 'live',
        supersedesCalculationId: bridge,
        updateParent: true,
        workMinutes: 250,
      })
      await client.query('COMMIT')
      expect((await pool.query(
        `SELECT current_calculation_id::text, projection_owner, visibility_state
           FROM attendance_records WHERE id = $1`,
        [restored.target.recordId],
      )).rows[0]).toEqual({
        current_calculation_id: nextId,
        projection_owner: 'w4',
        visibility_state: 'active',
      })
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }, 60000)

  it('rejects a duplicate baseline after a witnessed legacy restore', async () => {
    const restored = await runSingleRollback({
      preimage: 'active',
      workDate: '2026-08-24',
    })
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await expect(insertCalculation(client, {
        recordId: restored.target.recordId,
        version: 3,
        kind: 'legacy_baseline',
        outcome: 'baseline',
        workMinutes: 120,
      })).rejects.toThrow(/witnessed legacy predecessor required/)
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
    expect((await pool.query(
      `SELECT count(*)::int AS n FROM attendance_record_calculations
        WHERE attendance_record_id = $1 AND calculation_kind = 'legacy_baseline'`,
      [restored.target.recordId],
    )).rows[0].n).toBe(0)
  }, 60000)

  it('fails closed when rollback history has no durable restore witness', async () => {
    const restored = await runSingleRollback({
      preimage: 'active',
      workDate: '2026-08-25',
    })
    // Historical-corruption fixture only; no successful path disables triggers.
    await pool.query('ALTER TABLE attendance_import_rollback_restore_witnesses DISABLE TRIGGER USER')
    try {
      await pool.query(
        'DELETE FROM attendance_import_rollback_restore_witnesses WHERE attendance_record_id = $1',
        [restored.target.recordId],
      )
    } finally {
      await pool.query('ALTER TABLE attendance_import_rollback_restore_witnesses ENABLE TRIGGER USER')
    }
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await expect(insertCalculation(client, {
        recordId: restored.target.recordId,
        version: 3,
        supersedesCalculationId: restored.result.reversalCalculationIds[0],
      })).rejects.toThrow(/durable restore witness missing/)
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  }, 60000)

  it('fails closed when the durable restore witness fingerprint is corrupted', async () => {
    const restored = await runSingleRollback({
      preimage: 'active',
      workDate: '2026-08-26',
    })
    // Historical-corruption fixture only: make both stored copies agree on one
    // fabricated hex so only canonical-domain recomputation can reject it.
    await pool.query('ALTER TABLE attendance_import_rollback_restore_witnesses DISABLE TRIGGER USER')
    await pool.query('ALTER TABLE attendance_record_calculations DISABLE TRIGGER USER')
    try {
      await pool.query(
        `UPDATE attendance_import_rollback_restore_witnesses
            SET frozen_preimage_fingerprint = $2
          WHERE attendance_record_id = $1`,
        [restored.target.recordId, hex('f')],
      )
      await pool.query(
        `UPDATE attendance_record_calculations reversed
            SET parent_preimage_snapshot = jsonb_set(
              reversed.parent_preimage_snapshot,
              '{compatibilityFingerprint}',
              to_jsonb($2::text)
            )
           FROM attendance_import_rollback_restore_witnesses witness
          WHERE witness.attendance_record_id = $1
            AND reversed.id = witness.reversed_calculation_id`,
        [restored.target.recordId, hex('f')],
      )
    } finally {
      await pool.query('ALTER TABLE attendance_record_calculations ENABLE TRIGGER USER')
      await pool.query('ALTER TABLE attendance_import_rollback_restore_witnesses ENABLE TRIGGER USER')
    }
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await expect(insertCalculation(client, {
        recordId: restored.target.recordId,
        version: 3,
        supersedesCalculationId: restored.result.reversalCalculationIds[0],
      })).rejects.toThrow(/restore witness fingerprint invalid/)
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  }, 60000)

  it('rejects a cross-org restore witness before it can become a lineage bridge', async () => {
    const restored = await runSingleRollback({
      preimage: 'active',
      workDate: '2026-08-27',
    })
    const otherOrgId = `witness-${id()}`
    await expect(pool.query(
      `INSERT INTO attendance_import_rollback_restore_witnesses (
         org_id, attendance_record_id, reversal_calculation_id,
         reversed_calculation_id, rollback_operation_id,
         source_batch_entrypoint, source_batch_id, frozen_preimage_fingerprint,
         actor_id, actor_posture, correlation_id)
       SELECT $2, attendance_record_id, reversal_calculation_id,
              reversed_calculation_id, rollback_operation_id,
              source_batch_entrypoint, source_batch_id, frozen_preimage_fingerprint,
              actor_id, actor_posture, correlation_id
         FROM attendance_import_rollback_restore_witnesses
        WHERE org_id = $1 AND attendance_record_id = $3`,
      [orgId, otherOrgId, restored.target.recordId],
    )).rejects.toThrow(/rollback command missing/)
    expect((await pool.query(
      'SELECT count(*)::int AS n FROM attendance_import_rollback_restore_witnesses WHERE org_id = $1',
      [otherOrgId],
    )).rows[0].n).toBe(0)
  }, 60000)

  it('retires first imports, restores exact frozen legacy tuples, and replays one result', async () => {
    const batchId = id()
    const fingerprint = hex('a')
    await sourceBatch(batchId, fingerprint)
    const first = await importedRecord({
      batchId,
      preimage: 'absent',
      workDate: '2026-07-30',
      workMinutes: 480,
    })
    const restore = await importedRecord({
      batchId,
      preimage: 'retired',
      workDate: '2026-07-31',
      workMinutes: 500,
    })
    const rollbackOperationId = id()
    const command = createFrozenAttendanceImportRollbackCommandV1({
      orgId,
      rollbackOperationId,
      sourceBatchEntrypoint: 'import_batch',
      sourceBatchId: batchId,
      expectedSourceBatchFingerprint: fingerprint,
      authorization: authorization(),
      correlationId: `rollback-${run}`,
      targets: [first, restore].map((row) => ({
        attendanceRecordId: row.recordId,
        reversalOperationId: id(),
        reversalCalculationId: id(),
      })),
    })
    const client = await pool.connect()
    try {
      const result = await rollbackAttendanceImportV1(trx(client), command, rollbackAuthorizationPort)
      expect(result.replayed).toBe(false)
      expect(result.reversalCalculationIds).toHaveLength(2)
      const rows = await pool.query(
        `SELECT id::text, projection_owner, current_calculation_id::text,
                visibility_state, visibility_reason, status, work_minutes
           FROM attendance_records
          WHERE org_id = $1 AND id = ANY($2::uuid[])
          ORDER BY work_date`,
        [orgId, [first.recordId, restore.recordId]],
      )
      expect(rows.rows).toEqual([
        expect.objectContaining({
          id: first.recordId,
          projection_owner: 'w4',
          visibility_state: 'retired',
          visibility_reason: 'import_rollback',
          work_minutes: 480,
        }),
        {
          id: restore.recordId,
          projection_owner: 'legacy_untracked',
          current_calculation_id: null,
          visibility_state: 'retired',
          visibility_reason: 'review_placeholder',
          status: 'normal',
          work_minutes: 120,
        },
      ])
      const replay = await rollbackAttendanceImportV1(trx(client), command, rollbackAuthorizationPort)
      expect(replay).toEqual({ ...result, replayed: true })
      expect(await rollbackResidue(batchId)).toEqual({ commands: 1, reversals: 2, witnesses: 1 })
    } finally {
      client.release()
    }
  }, 60000)

  it('fails stale authorization before rollback DML', async () => {
    const otherActor = id()
    await pool.query('INSERT INTO users (id) VALUES ($1)', [otherActor])
    await pool.query('INSERT INTO user_orgs (user_id, org_id) VALUES ($1, $2)', [otherActor, orgId])
    await pool.query("INSERT INTO user_namespace_admissions VALUES ($1, 'attendance', true)", [otherActor])
    await pool.query("INSERT INTO user_roles VALUES ($1, 'attendance_admin')", [otherActor])
    const batchId = id()
    const fingerprint = hex('9')
    await sourceBatch(batchId, fingerprint)
    const target = await importedRecord({
      batchId,
      preimage: 'absent',
      workDate: '2026-08-01',
      workMinutes: 400,
    })
    const stale = createFrozenAttendanceImportRollbackCommandV1({
      orgId,
      rollbackOperationId: id(),
      sourceBatchEntrypoint: 'import_batch',
      sourceBatchId: batchId,
      expectedSourceBatchFingerprint: fingerprint,
      authorization: authorization(otherActor),
      correlationId: `stale-${run}`,
      targets: [{ attendanceRecordId: target.recordId, reversalOperationId: id(), reversalCalculationId: id() }],
    })
    const client = await pool.connect()
    try {
      await expect(rollbackAttendanceImportV1(trx(client), stale, rollbackAuthorizationPort)).rejects.toMatchObject({
        code: 'IMPORT_ROLLBACK_AUTHORIZATION_STALE',
      } satisfies Partial<AttendanceImportRollbackError>)
      expect((await pool.query('SELECT count(*)::int AS n FROM attendance_import_rollback_commands WHERE source_batch_id = $1', [batchId])).rows[0].n).toBe(0)
    } finally {
      client.release()
    }
  }, 60000)
})
