/**
 * Fresh-PostgreSQL integration lane for W4C-3a P06 modern synchronous import.
 */
import crypto from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'

import { up as w4c0Up } from '../../src/db/migrations/zzzz20260725120000_w4c0_attendance_segment_calculation_durable_storage'
import { up as w4c3aUp } from '../../src/db/migrations/zzzz20260730120000_w4c3a_durable_legacy_execution_plan'
import { up as rollbackUp } from '../../src/db/migrations/zzzz20260731120000_w4c3a_import_rollback_foundation'
import {
  __setW4C3aSyncImportAfterPreconditionsForTests,
  createAttendanceSyncImportHostV1,
} from '../../src/attendance/w4c3a-sync-import-host'
import { __setW4C3aImportRollbackBeforeDmlForTests } from '../../src/attendance/w4c3a-import-rollback'
import { createAttendanceImportRollbackBoundaryV1 } from '../../src/attendance/w4c3a-import-rollback-boundary'
import {
  buildAttendanceImportAttributionFreezeV1,
  buildAttendanceImportPolicySourceProofV1,
} from '../../src/attendance/w4c3a-import-proof'
import { rawImportEvidenceV1 } from '../utils/attendance-w4c3a-raw-evidence'
import type { CommitAttendanceSyncImportPlanFromHostInputV1 } from '../../src/attendance/w4c3a-sync-import-host'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip
const run = crypto.randomUUID().replace(/-/g, '').slice(0, 12)

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: (() => void) | undefined
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve: () => resolve?.() }
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return String((error as { code: unknown }).code)
  }
  return String((error as Error).message)
}

async function createBase(pool: Pool): Promise<void> {
  await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto')
  await pool.query(`
    CREATE TABLE users (
      id text PRIMARY KEY, is_active boolean NOT NULL DEFAULT true,
      activation_status text NOT NULL DEFAULT 'activated',
      permissions jsonb NOT NULL DEFAULT '[]'::jsonb
    )`)
  await pool.query(`
    CREATE TABLE user_orgs (
      user_id text NOT NULL, org_id text NOT NULL, is_active boolean NOT NULL DEFAULT true,
      PRIMARY KEY (user_id, org_id)
    )`)
  await pool.query(`
    CREATE TABLE user_permissions (
      user_id text NOT NULL, permission_code text NOT NULL,
      PRIMARY KEY (user_id, permission_code)
    )`)
  await pool.query(`
    CREATE TABLE user_roles (
      user_id text NOT NULL, role_id text NOT NULL, PRIMARY KEY (user_id, role_id)
    )`)
  await pool.query(`
    CREATE TABLE role_permissions (
      role_id text NOT NULL, permission_code text NOT NULL,
      PRIMARY KEY (role_id, permission_code)
    )`)
  await pool.query(`
    CREATE TABLE user_namespace_admissions (
      user_id text NOT NULL, namespace text NOT NULL, enabled boolean NOT NULL DEFAULT false,
      PRIMARY KEY (user_id, namespace)
    )`)
  await pool.query(`
    CREATE TABLE attendance_records (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id text NOT NULL, work_date date NOT NULL,
      first_in_at timestamptz, last_out_at timestamptz, work_minutes integer NOT NULL DEFAULT 0,
      late_minutes integer NOT NULL DEFAULT 0, early_leave_minutes integer NOT NULL DEFAULT 0,
      status varchar(64) NOT NULL DEFAULT 'normal', is_workday boolean,
      timezone text, meta jsonb, source_batch_id uuid, org_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (org_id, user_id, work_date)
    )`)
  await pool.query(`
    CREATE TABLE attendance_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id text NOT NULL, work_date date NOT NULL,
      request_type varchar(30) NOT NULL, status varchar(20) NOT NULL DEFAULT 'pending', org_id text NOT NULL
    )`)
  await pool.query(`
    CREATE TABLE attendance_import_jobs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id text NOT NULL, batch_id uuid NOT NULL,
      created_by text NOT NULL, idempotency_key text, status varchar(20) NOT NULL DEFAULT 'queued',
      progress integer NOT NULL DEFAULT 0, total integer NOT NULL DEFAULT 0, error text,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb, started_at timestamptz, finished_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    )`)
  await pool.query(`
    CREATE TABLE attendance_import_batches (
      id uuid PRIMARY KEY, org_id text NOT NULL, idempotency_key text, created_by text NOT NULL,
      source text, rule_set_id uuid, mapping jsonb NOT NULL, row_count integer NOT NULL,
      status text NOT NULL, meta jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`)
  await pool.query(`
    CREATE TABLE attendance_import_items (
      id uuid PRIMARY KEY, batch_id uuid NOT NULL, org_id text NOT NULL, user_id text,
      work_date date, record_id uuid, preview_snapshot jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`)
  await pool.query(`
    CREATE TABLE attendance_groups (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id text NOT NULL, name text NOT NULL,
      code text, timezone text, rule_set_id uuid, description text,
      created_at timestamptz, updated_at timestamptz, UNIQUE (org_id, name)
    )`)
  await pool.query(`
    CREATE TABLE attendance_group_members (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id text NOT NULL, group_id uuid NOT NULL,
      user_id text NOT NULL, created_at timestamptz, updated_at timestamptz,
      UNIQUE (org_id, group_id, user_id)
    )`)
}

function hostInput(input: {
  orgId: string
  actorId: string
  batchId: string
  userId: string
  workDate: string
  strategy: 'values' | 'unnest' | 'staging'
}): CommitAttendanceSyncImportPlanFromHostInputV1 {
  const targetRef = JSON.stringify([input.orgId, input.userId, input.workDate])
  const attribution = buildAttendanceImportAttributionFreezeV1({
    orgId: input.orgId,
    userId: input.userId,
    workDate: input.workDate,
    shiftId: `shift-p06-${run}`,
    reasonCode: 'SINGLE_MATCHING_CANDIDATE',
    resolvedAt: `${input.workDate}T00:00:00.000Z`,
    timezone: 'Asia/Shanghai',
    workStartTime: '09:00',
    workEndTime: '17:00',
    isOvernight: false,
    candidateAbsoluteWindow: {
      startAt: `${input.workDate}T01:00:00.000Z`,
      endAt: `${input.workDate}T09:00:00.000Z`,
    },
    candidateAttributionWindow: {
      startAt: `${input.workDate}T01:00:00.000Z`,
      endAt: `${input.workDate}T09:00:00.000Z`,
    },
    attributionTailMinutes: 0,
    approvedOvertimeWindows: [],
  })
  if (attribution.kind !== 'resolved_v2') {
    throw new Error('expected a resolved P06 attribution fixture')
  }
  const context = {
    schemaVersion: 1 as const,
    selector: 'legacy' as const,
    orgId: input.orgId,
    userId: input.userId,
    workDate: input.workDate,
    timezone: 'Asia/Shanghai',
    shiftId: `shift-p06-${run}`,
    isWorkday: true,
    holidayKind: null,
    calculationGroupId: null,
    roundingMinutes: 1,
    severeLateThresholdMinutes: 60,
    absenceLateThresholdMinutes: 240,
    segments: [{
      index: 0,
      startTime: '09:00',
      endTime: '17:00',
      startDayOffset: 0,
      endDayOffset: 0,
      lateGraceMinutes: 0,
      earlyLeaveGraceMinutes: 0,
    }],
  }
  const policyProof = buildAttendanceImportPolicySourceProofV1({
    ruleVersion: 'w4c3a-p06',
    engineVersion: null,
    rule: {
      timezone: 'Asia/Shanghai',
      workStartTime: '09:00',
      workEndTime: '17:00',
      lateGraceMinutes: 0,
      earlyGraceMinutes: 0,
      roundingMinutes: 1,
      severeLateThresholdMinutes: 60,
      absenceLateThresholdMinutes: 240,
      workingDays: [1, 2, 3, 4, 5],
    },
    policy: { appliedRules: [], userGroups: [] },
    engine: null,
  })
  return {
    orgId: input.orgId,
    actorId: input.actorId,
    actorPosture: 'platform_admin',
    tokenSubjectUserId: input.actorId,
    batchId: input.batchId,
    idempotencyKey: null,
    payload: {
      __jobType: 'commit',
      idempotencyKey: null,
      __importEngine: input.strategy === 'values' ? 'standard' : 'bulk',
      recordUpsertStrategy: input.strategy,
      itemsInsertStrategy: input.strategy,
      __w4ContractVersion: 1,
    },
    legacyRowSourceKind: 'direct_rows',
    legacySourceRowLimit: null,
    batch: {
      kind: 'normal',
      source: 'manual',
      ruleSetId: null,
      mappingSnapshot: {},
      sourceRowCount: 1,
      status: 'committed',
      idempotencyKey: null,
      visibilityRule: 'org',
      engine: input.strategy === 'values' ? 'standard' : 'bulk',
      chunkConfig: { recordsChunkSize: 100, itemsChunkSize: 100 },
      recordUpsertStrategy: input.strategy,
      itemsInsertStrategy: input.strategy,
      mappingProfileId: null,
      compatibilityMetadata: {},
      groupSync: null,
      itemReturnPolicy: { returnItems: false, itemsLimit: null },
      skippedSamplePolicy: { limit: 50 },
      resultSlots: {
        groupCreated: 'ensure_group_returned_row_count',
        groupMembersAdded: 'ensure_member_inserted_row_count',
      },
    },
    artifactCleanup: { kind: 'none' },
    items: [
      {
        kind: 'apply',
        ordinal: 0,
        semanticOrdinal: 0,
        targetRef,
        previewSnapshot: {},
        rawEvidence: rawImportEvidenceV1(0, {
          userId: input.userId,
          workDate: input.workDate,
          firstInAt: `${input.workDate}T01:00:00.000Z`,
          lastOutAt: `${input.workDate}T09:00:00.000Z`,
          status: 'normal',
          isWorkday: true,
          workMinutes: 480,
        }),
      },
    ],
    recordWrites: [
      {
        orgId: input.orgId,
        userId: input.userId,
        workDate: input.workDate,
        sourceOrdinals: [0],
        mergeMode: 'override',
        firstInAt: `${input.workDate}T01:00:00.000Z`,
        lastOutAt: `${input.workDate}T09:00:00.000Z`,
        workMinutes: 480,
        lateMinutes: 0,
        earlyLeaveMinutes: 0,
        status: 'normal',
        isWorkday: true,
        timezone: 'Asia/Shanghai',
        compatibilityMetadata: {},
        policySnapshot: {
          schemaVersion: 2,
          sources: [
            {
              sourceOrdinal: 0,
              sourceFingerprint: policyProof.sourceFingerprint,
              sourceDefinition: policyProof.sourceDefinition,
              output: {
                status: 'normal',
                workMinutes: 480,
                lateMinutes: 0,
                earlyLeaveMinutes: 0,
                leaveMinutes: 0,
                overtimeMinutes: 0,
              },
            },
          ],
        },
        profileSnapshot: {},
        multiPunchSnapshot: {},
        attributionSnapshot: {
          schemaVersion: 2,
          sources: [
            {
              sourceOrdinal: 0,
              attribution: attribution.attribution,
              context,
              importAttributionReconstruction: attribution.reconstruction,
            },
          ],
        },
        sourceBatchId: input.batchId,
        resultSlots: {},
      },
    ],
    groupEffects: [],
    itemReturnPolicy: { returnItems: true, itemsLimit: null },
    csvWarnings: [],
    groupWarnings: [],
  }
}

it('sentinel: DATABASE_URL is set (real-DB lane must not silently skip)', () => {
  expect(dbUrl).toBeTruthy()
})

describeIfDatabase('W4C-3a P06 sync import host (fresh PostgreSQL)', () => {
  const scratchName = `ms2_w4c3a_p06_${run}`
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
    pool = new Pool({ connectionString: scratchUrl.toString() })
    kyselyPool = new Pool({ connectionString: scratchUrl.toString() })
    db = new Kysely<unknown>({
      dialect: new PostgresDialect({ pool: kyselyPool }),
    })
    await createBase(pool)
    await w4c0Up(db)
    await w4c3aUp(db)
    await rollbackUp(db)
  }, 120000)

  afterAll(async () => {
    __setW4C3aSyncImportAfterPreconditionsForTests(null)
    __setW4C3aImportRollbackBeforeDmlForTests(null)
    for (const current of [pool, kyselyPool]) {
      try {
        await current?.end()
      } catch {
        // ignore
      }
    }
    try {
      await adminPool.query(`DROP DATABASE IF EXISTS ${scratchName}`)
    } catch (error) {
      if (errorCode(error) !== '57P01') throw error
    }
    await adminPool?.end()
  }, 120000)

  function syncHost() {
    return createAttendanceSyncImportHostV1({
      acquireConnection: async () => {
        const client = await pool.connect()
        return { client, release: () => client.release() }
      },
    })
  }

  function rollbackBoundary() {
    return createAttendanceImportRollbackBoundaryV1({
      acquireConnection: async () => {
        const client = await pool.connect()
        return { client, release: () => client.release() }
      },
    })
  }

  async function authoritativeRaceFixture(label: string) {
    const orgId = crypto.randomUUID()
    const actorId = `admin-p06-race-${label}-${run}`
    const userId = crypto.randomUUID()
    const oldBatchId = crypto.randomUUID()
    const workDate = '2026-07-30'
    process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = orgId
    await pool.query(
      `INSERT INTO users (id, is_active, activation_status, permissions)
       VALUES ($1, true, 'activated', '["attendance:admin"]'::jsonb),
              ($2, true, 'activated', '[]'::jsonb)`,
      [actorId, userId],
    )
    await pool.query(
      `INSERT INTO user_orgs (user_id, org_id, is_active)
       VALUES ($1, $3, true), ($2, $3, true)`,
      [actorId, userId, orgId],
    )
    await pool.query(
      `INSERT INTO attendance_calculation_rollout_state
         (org_id, state, engine_version, reason_code, actor_id, version, prior_state, scope)
       VALUES ($1, 'legacy', 'w4c3a-p06-race', 'TEST_FIXTURE', $2, 1, NULL,
               'synthetic_staging')`,
      [orgId, actorId],
    )
    await pool.query(
      `UPDATE attendance_calculation_rollout_state
          SET state = 'shadow', prior_state = 'legacy', version = 2
        WHERE org_id = $1`,
      [orgId],
    )
    await pool.query(
      `UPDATE attendance_calculation_rollout_state
          SET state = 'eligible', prior_state = 'shadow', version = 3
        WHERE org_id = $1`,
      [orgId],
    )
    await pool.query(
      `UPDATE attendance_calculation_rollout_state
          SET state = 'authoritative', prior_state = 'eligible', version = 4
        WHERE org_id = $1`,
      [orgId],
    )

    await syncHost().commitSyncImportPlanV1(
      hostInput({
        orgId,
        actorId,
        batchId: oldBatchId,
        userId,
        workDate,
        strategy: 'values',
      }),
    )
    const initial = await pool.query(
      `SELECT r.id::text AS record_id, r.current_calculation_id::text,
              r.projection_owner, r.visibility_state,
              c.source_batch_id::text AS calculation_source_batch_id,
              c.parent_preimage_snapshot
         FROM attendance_records r
         JOIN attendance_record_calculations c
           ON c.org_id = r.org_id AND c.id = r.current_calculation_id
        WHERE r.org_id = $1 AND r.user_id = $2 AND r.work_date = $3::date`,
      [orgId, userId, workDate],
    )
    expect(initial.rows).toHaveLength(1)
    expect(initial.rows[0]).toMatchObject({
      projection_owner: 'w4',
      visibility_state: 'active',
      calculation_source_batch_id: oldBatchId,
    })
    expect(initial.rows[0].parent_preimage_snapshot).not.toBeNull()
    return { orgId, actorId, userId, oldBatchId, workDate, recordId: initial.rows[0].record_id as string }
  }

  it('legacy_projection_only writes batch/item/record with zero job/plan/terminal DML', async () => {
    const orgId = crypto.randomUUID()
    const actorId = `admin-p06-${run}`
    const userId = crypto.randomUUID()
    const batchId = crypto.randomUUID()
    const workDate = '2026-07-31'

    await pool.query(
      `INSERT INTO users (id, is_active, activation_status, permissions)
       VALUES ($1, true, 'activated', '["attendance:admin"]'::jsonb)`,
      [actorId],
    )
    await pool.query(
      `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)`,
      [actorId, orgId],
    )
    await pool.query(
      `INSERT INTO users (id, is_active, activation_status, permissions)
       VALUES ($1, true, 'activated', '[]'::jsonb)`,
      [userId],
    )
    await pool.query(
      `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)`,
      [userId, orgId],
    )
    // Leave rollout state absent => legacy_projection_only.

    const host = createAttendanceSyncImportHostV1({
      acquireConnection: async () => {
        const client = await pool.connect()
        return { client, release: () => client.release() }
      },
    })

    const response = await host.commitSyncImportPlanV1(
      hostInput({
        orgId,
        actorId,
        batchId,
        userId,
        workDate,
        strategy: 'values',
      }),
    )

    expect(response.batchId).toBe(batchId)
    expect(response.imported).toBe(1)
    expect(response.failedRows).toBe(0)
    expect(response.meta).not.toHaveProperty('async')
    expect(response.recordUpsertStrategy).toBe('values')
    expect(response.items).toHaveLength(1)
    expect(response.items[0]).toMatchObject({
      userId,
      workDate,
    })

    const batches = await pool.query(
      `SELECT id::text AS id, status, meta FROM attendance_import_batches WHERE org_id = $1`,
      [orgId],
    )
    expect(batches.rows).toHaveLength(1)
    expect(batches.rows[0].id).toBe(batchId)
    expect(batches.rows[0].status).toBe('committed')
    expect(batches.rows[0].meta).not.toHaveProperty('async')

    const items = await pool.query(
      `SELECT id FROM attendance_import_items WHERE batch_id = $1::uuid AND org_id = $2`,
      [batchId, orgId],
    )
    expect(items.rows).toHaveLength(1)

    const records = await pool.query(
      `SELECT user_id, work_date::text AS work_date, work_minutes, status
         FROM attendance_records WHERE org_id = $1`,
      [orgId],
    )
    expect(records.rows).toHaveLength(1)
    expect(records.rows[0]).toMatchObject({
      user_id: userId,
      work_date: workDate,
      work_minutes: 480,
      status: 'normal',
    })

    const jobs = await pool.query(
      `SELECT id FROM attendance_import_jobs WHERE org_id = $1`,
      [orgId],
    )
    expect(jobs.rows).toHaveLength(0)

    const plans = await pool.query(
      `SELECT job_id FROM attendance_import_legacy_execution_plans WHERE org_id = $1`,
      [orgId],
    )
    expect(plans.rows).toHaveLength(0)

    const terminals = await pool.query(
      `SELECT job_id FROM attendance_import_legacy_terminal_responses WHERE org_id = $1`,
      [orgId],
    )
    expect(terminals.rows).toHaveLength(0)

    const ops = await pool.query(
      `SELECT operation_id FROM attendance_result_operations WHERE org_id = $1`,
      [orgId],
    )
    expect(ops.rows).toHaveLength(0)
  })

  it('rejects an inactive actor membership before sync import business DML', async () => {
    const orgId = crypto.randomUUID()
    const actorId = `inactive-admin-p06-${run}`
    const userId = crypto.randomUUID()
    const batchId = crypto.randomUUID()

    await pool.query(
      `INSERT INTO users (id, is_active, activation_status, permissions)
       VALUES ($1, true, 'activated', '["attendance:admin"]'::jsonb),
              ($2, true, 'activated', '[]'::jsonb)`,
      [actorId, userId],
    )
    await pool.query(
      `INSERT INTO user_orgs (user_id, org_id, is_active)
       VALUES ($1, $3, false), ($2, $3, true)`,
      [actorId, userId, orgId],
    )

    const host = createAttendanceSyncImportHostV1({
      acquireConnection: async () => {
        const client = await pool.connect()
        return { client, release: () => client.release() }
      },
    })

    await expect(
      host.commitSyncImportPlanV1({
        ...hostInput({
          orgId,
          actorId,
          batchId,
          userId,
          workDate: '2026-07-31',
          strategy: 'values',
        }),
        actorPosture: 'attendance_admin',
      }),
    ).rejects.toThrow('ATTENDANCE_WRITE_NOT_AUTHORIZED')

    const residue = await pool.query<{ batches: number; items: number; records: number; operations: number }>(
      `SELECT
         (SELECT count(*)::int FROM attendance_import_batches WHERE org_id = $1) AS batches,
         (SELECT count(*)::int FROM attendance_import_items WHERE org_id = $1) AS items,
         (SELECT count(*)::int FROM attendance_records WHERE org_id = $1) AS records,
         (SELECT count(*)::int FROM attendance_result_operations WHERE org_id = $1) AS operations`,
      [orgId],
    )
    expect(residue.rows[0]).toEqual({
      batches: 0,
      items: 0,
      records: 0,
      operations: 0,
    })
  })

  it('source-first serializes a later source before old-batch rollback and rejects stale reversal', async () => {
    const previousAllowlist = process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
    const fixture = await authoritativeRaceFixture('source-first')
    const newBatchId = crypto.randomUUID()
    process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = fixture.orgId
    const sourceEntered = deferred()
    const releaseSource = deferred()
    let rollbackSettled = false
    __setW4C3aSyncImportAfterPreconditionsForTests(async () => {
      sourceEntered.resolve()
      await releaseSource.promise
    })
    try {
      const sourceOutcome = syncHost()
        .commitSyncImportPlanV1(
          hostInput({
            orgId: fixture.orgId,
            actorId: fixture.actorId,
            batchId: newBatchId,
            userId: fixture.userId,
            workDate: fixture.workDate,
            strategy: 'values',
          }),
        )
        .then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        )
      await sourceEntered.promise
      const rollbackOutcome = rollbackBoundary()
        .rollbackImportBatchV1({
          orgId: fixture.orgId,
          batchId: fixture.oldBatchId,
          actorId: fixture.actorId,
          tokenSubjectUserId: fixture.actorId,
        })
        .then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        )
        .finally(() => { rollbackSettled = true })
      await new Promise((resolve) => setTimeout(resolve, 75))
      expect(rollbackSettled).toBe(false)
      releaseSource.resolve()

      const [source, rollback] = await Promise.all([sourceOutcome, rollbackOutcome])
      expect(source.ok).toBe(true)
      expect(rollback.ok).toBe(false)
      if (rollback.ok) throw new Error('expected stale rollback rejection')
      expect(errorCode(rollback.error)).toBe('IMPORT_ROLLBACK_SUPERSEDED')

      const state = await pool.query(
        `SELECT r.current_calculation_id::text, r.projection_owner, r.visibility_state,
                c.source_batch_id::text AS source_batch_id,
                (SELECT count(*)::int FROM attendance_import_rollback_commands
                  WHERE org_id = $1 AND source_batch_id = $2::uuid) AS rollback_commands,
                (SELECT status FROM attendance_import_batches
                  WHERE org_id = $1 AND id = $2::uuid) AS old_batch_status
           FROM attendance_records r
           JOIN attendance_record_calculations c
             ON c.org_id = r.org_id AND c.id = r.current_calculation_id
          WHERE r.org_id = $1 AND r.id = $3::uuid`,
        [fixture.orgId, fixture.oldBatchId, fixture.recordId],
      )
      expect(state.rows).toHaveLength(1)
      expect(state.rows[0]).toMatchObject({
        projection_owner: 'w4',
        visibility_state: 'active',
        source_batch_id: newBatchId,
        rollback_commands: 0,
        old_batch_status: 'committed',
      })
    } finally {
      releaseSource.resolve()
      __setW4C3aSyncImportAfterPreconditionsForTests(null)
      if (previousAllowlist === undefined) {
        delete process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
      } else {
        process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = previousAllowlist
      }
    }
  }, 30000)

  it('rollback-first commits one reversal before a later source reactivates the target', async () => {
    const previousAllowlist = process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
    const fixture = await authoritativeRaceFixture('rollback-first')
    const newBatchId = crypto.randomUUID()
    process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = fixture.orgId
    const rollbackEntered = deferred()
    const releaseRollback = deferred()
    let sourceSettled = false
    __setW4C3aImportRollbackBeforeDmlForTests(async () => {
      rollbackEntered.resolve()
      await releaseRollback.promise
    })
    try {
      const rollbackOutcome = rollbackBoundary()
        .rollbackImportBatchV1({
          orgId: fixture.orgId,
          batchId: fixture.oldBatchId,
          actorId: fixture.actorId,
          tokenSubjectUserId: fixture.actorId,
        })
        .then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        )
      await rollbackEntered.promise
      const sourceOutcome = syncHost()
        .commitSyncImportPlanV1(
          hostInput({
            orgId: fixture.orgId,
            actorId: fixture.actorId,
            batchId: newBatchId,
            userId: fixture.userId,
            workDate: fixture.workDate,
            strategy: 'values',
          }),
        )
        .then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        )
        .finally(() => { sourceSettled = true })
      await new Promise((resolve) => setTimeout(resolve, 75))
      expect(sourceSettled).toBe(false)
      releaseRollback.resolve()

      const [rollback, source] = await Promise.all([rollbackOutcome, sourceOutcome])
      expect(rollback.ok).toBe(true)
      if (!rollback.ok) throw rollback.error
      expect(rollback.value).toMatchObject({
        kind: 'w4',
        affected: 1,
        restored: 0,
        retired: 1,
        status: 'rolled_back',
      })
      expect(source.ok).toBe(true)
      if (!source.ok) throw source.error

      const state = await pool.query(
        `SELECT r.current_calculation_id::text, r.projection_owner, r.visibility_state,
                c.source_batch_id::text AS source_batch_id,
                c.parent_preimage_snapshot,
                (SELECT count(*)::int FROM attendance_import_rollback_commands
                  WHERE org_id = $1 AND source_batch_id = $2::uuid) AS rollback_commands,
                (SELECT count(*)::int FROM attendance_import_rollback_restore_witnesses
                  WHERE org_id = $1 AND source_batch_id = $2::uuid) AS restore_witnesses,
                (SELECT count(*)::int FROM attendance_record_calculations
                  WHERE org_id = $1 AND attendance_record_id = $3::uuid
                    AND entrypoint = 'import_rollback') AS reversal_calculations,
                (SELECT id::text FROM attendance_record_calculations
                  WHERE org_id = $1 AND attendance_record_id = $3::uuid
                    AND entrypoint = 'import_rollback') AS reversal_calculation_id,
                (SELECT status FROM attendance_import_batches
                  WHERE org_id = $1 AND id = $2::uuid) AS old_batch_status
           FROM attendance_records r
           JOIN attendance_record_calculations c
             ON c.org_id = r.org_id AND c.id = r.current_calculation_id
          WHERE r.org_id = $1 AND r.id = $3::uuid`,
        [fixture.orgId, fixture.oldBatchId, fixture.recordId],
      )
      expect(state.rows).toHaveLength(1)
      expect(state.rows[0]).toMatchObject({
        projection_owner: 'w4',
        visibility_state: 'active',
        source_batch_id: newBatchId,
        rollback_commands: 1,
        restore_witnesses: 0,
        reversal_calculations: 1,
        old_batch_status: 'rolled_back',
      })
      expect(state.rows[0].parent_preimage_snapshot).toMatchObject({
        posture: 'present',
        currentCalculationId: state.rows[0].reversal_calculation_id,
        visibilityState: 'retired',
      })
    } finally {
      releaseRollback.resolve()
      __setW4C3aImportRollbackBeforeDmlForTests(null)
      if (previousAllowlist === undefined) {
        delete process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
      } else {
        process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = previousAllowlist
      }
    }
  }, 30000)

  it('rejects authoritative 5001 before batch/item DML on a real connection', async () => {
    const orgId = crypto.randomUUID()
    const actorId = `admin-limit-${run}`
    process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = orgId
    await pool.query(
      `INSERT INTO users (id, is_active, activation_status, permissions)
       VALUES ($1, true, 'activated', '["attendance:admin"]'::jsonb)`,
      [actorId],
    )
    await pool.query(
      `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)`,
      [actorId, orgId],
    )
    // Legal rollout path: legacy -> shadow -> eligible -> authoritative.
    await pool.query(
      `INSERT INTO attendance_calculation_rollout_state
         (org_id, state, engine_version, reason_code, actor_id, version, prior_state, scope)
       VALUES ($1, 'legacy', 'w4c3a-p06', 'TEST_FIXTURE', $2, 1, NULL, 'synthetic_staging')`,
      [orgId, actorId],
    )
    await pool.query(
      `UPDATE attendance_calculation_rollout_state
          SET state = 'shadow', prior_state = 'legacy', version = 2
        WHERE org_id = $1`,
      [orgId],
    )
    await pool.query(
      `UPDATE attendance_calculation_rollout_state
          SET state = 'eligible', prior_state = 'shadow', version = 3
        WHERE org_id = $1`,
      [orgId],
    )
    await pool.query(
      `UPDATE attendance_calculation_rollout_state
          SET state = 'authoritative', prior_state = 'eligible', version = 4
        WHERE org_id = $1`,
      [orgId],
    )

    const host = createAttendanceSyncImportHostV1({
      acquireConnection: async () => {
        const client = await pool.connect()
        return { client, release: () => client.release() }
      },
    })

    const items = Array.from({ length: 5001 }, (_, ordinal) => ({
      kind: 'apply' as const,
      ordinal,
      semanticOrdinal: ordinal,
      targetRef: JSON.stringify([orgId, `u-${ordinal}`, '2026-07-31']),
      previewSnapshot: {},
      rawEvidence: rawImportEvidenceV1(ordinal),
    }))
    const recordWrites = items.map((_item, ordinal) => ({
      ...hostInput({
        orgId,
        actorId,
        batchId: crypto.randomUUID(),
        userId: `u-${ordinal}`,
        workDate: '2026-07-31',
        strategy: 'staging',
      }).recordWrites[0],
      userId: `u-${ordinal}`,
      sourceOrdinals: [ordinal],
      sourceBatchId: crypto.randomUUID(),
    }))
    const batchId = crypto.randomUUID()

    await expect(
      host.commitSyncImportPlanV1({
        ...hostInput({
          orgId,
          actorId,
          batchId,
          userId: 'u-0',
          workDate: '2026-07-31',
          strategy: 'staging',
        }),
        items,
        recordWrites,
        batch: {
          ...hostInput({
            orgId,
            actorId,
            batchId,
            userId: 'u-0',
            workDate: '2026-07-31',
            strategy: 'staging',
          }).batch,
          sourceRowCount: 5001,
        },
      }),
    ).rejects.toThrow('ATTENDANCE_IMPORT_BATCH_LIMIT_EXCEEDED')

    const batches = await pool.query(
      `SELECT id FROM attendance_import_batches WHERE org_id = $1`,
      [orgId],
    )
    expect(batches.rows).toHaveLength(0)
    const itemsRows = await pool.query(
      `SELECT id FROM attendance_import_items WHERE org_id = $1`,
      [orgId],
    )
    expect(itemsRows.rows).toHaveLength(0)
    const jobs = await pool.query(
      `SELECT id FROM attendance_import_jobs WHERE org_id = $1`,
      [orgId],
    )
    expect(jobs.rows).toHaveLength(0)

    delete process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
  })
})
