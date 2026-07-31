import crypto from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { up as w4c0Up } from '../../src/db/migrations/zzzz20260725120000_w4c0_attendance_segment_calculation_durable_storage'
import { up as w4c3aUp } from '../../src/db/migrations/zzzz20260730120000_w4c3a_durable_legacy_execution_plan'
import {
  computeLegacyImportRecordPreconditionFingerprintV1,
  LEGACY_IMPORT_MISSING_RECORD_PRECONDITION_FINGERPRINT_V1,
  type LegacyImportRecordWritePlanV1,
} from '../../src/attendance/w4c3a-legacy-execution-plan'
import { lockAndRecheckAttendanceLegacyRecordPreconditionsV1 } from '../../src/attendance/w4c3a-legacy-plan-preconditions'
import { applyAttendanceLegacyRecordEffectsV1 } from '../../src/attendance/w4c3a-legacy-plan-record-effects'
import { acquireAttendanceLegacyPlanClass11V1 } from '../../src/attendance/w4c3a-legacy-plan-processor'
import type { VerifiedAttendanceLegacyPlanV1 } from '../../src/attendance/w4c3a-legacy-plan-worker'
import {
  createVerifiedAttendanceCalculationTargetIdentityV1,
  createVerifiedAttendanceOrgIdentityV1,
  resolveSegmentCalculationPosture,
  type AttendanceW4TransactionClientV1,
} from '../../src/attendance/w4c0-identity'

const dbUrl =
  process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip
const run = crypto.randomUUID().replace(/-/g, '').slice(0, 12)

function trx(client: PoolClient): AttendanceW4TransactionClientV1 {
  return {
    query: (text, values) =>
      client.query(text, values as unknown[]) as unknown as Promise<{
        rows: Array<Record<string, unknown>>
      }>,
  }
}

function plan(
  recordWrites: readonly LegacyImportRecordWritePlanV1[],
): VerifiedAttendanceLegacyPlanV1 {
  return {
    manifest: {},
    chunks: [],
    items: [],
    recordWrites,
    groupEffects: [],
  } as unknown as VerifiedAttendanceLegacyPlanV1
}

function branchPlan(
  recordWrites: readonly LegacyImportRecordWritePlanV1[],
  operationalBranch: 'strict_targeted' | 'operational_only_batch_limit',
): VerifiedAttendanceLegacyPlanV1 {
  return {
    manifest: {
      orgId: recordWrites[0]?.orgId,
      operationalBranch,
    },
    chunks: [],
    items: [],
    recordWrites,
    groupEffects: [],
  } as unknown as VerifiedAttendanceLegacyPlanV1
}

function writePlan(input: {
  orgId: string
  userId: string
  workDate: string
  recordId: string
  sourceBatchId: string
  targetRevision: number
  fingerprint: string
  expectedSourceOwnership: string | null
}): LegacyImportRecordWritePlanV1 {
  return {
    recordWriteId: crypto.randomUUID(),
    orgId: input.orgId,
    userId: input.userId,
    workDate: input.workDate,
    sourceOrdinals: [0],
    mergeMode: 'merge',
    firstInAt: null,
    lastOutAt: null,
    workMinutes: null,
    lateMinutes: null,
    earlyLeaveMinutes: null,
    status: null,
    isWorkday: null,
    timezone: 'Asia/Taipei',
    targetRevision: input.targetRevision,
    existingRecordPreconditionFingerprint: input.fingerprint,
    expectedSourceOwnership: input.expectedSourceOwnership,
    recordId: input.recordId,
    compatibilityMetadata: {},
    policySnapshot: {},
    profileSnapshot: {},
    multiPunchSnapshot: {},
    attributionSnapshot: {},
    sourceBatchId: input.sourceBatchId,
    resultSlots: {},
  }
}

async function createBase(pool: Pool): Promise<void> {
  await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto')
  await pool.query(`
    CREATE TABLE attendance_records (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id text NOT NULL,
      work_date date NOT NULL,
      first_in_at timestamptz,
      last_out_at timestamptz,
      work_minutes integer NOT NULL DEFAULT 0,
      late_minutes integer NOT NULL DEFAULT 0,
      early_leave_minutes integer NOT NULL DEFAULT 0,
      status varchar(64) NOT NULL DEFAULT 'normal',
      is_workday boolean,
      timezone text,
      meta jsonb,
      source_batch_id uuid,
      org_id text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (org_id, user_id, work_date)
    )`)
  await pool.query(`
    CREATE TABLE attendance_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id text NOT NULL,
      work_date date NOT NULL,
      request_type varchar(30) NOT NULL,
      status varchar(20) NOT NULL DEFAULT 'pending',
      org_id text NOT NULL
    )`)
  await pool.query(`
    CREATE TABLE attendance_import_jobs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      batch_id uuid NOT NULL,
      created_by text NOT NULL,
      idempotency_key text,
      status varchar(20) NOT NULL DEFAULT 'queued',
      progress integer NOT NULL DEFAULT 0,
      total integer NOT NULL DEFAULT 0,
      error text,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      started_at timestamptz,
      finished_at timestamptz
    )`)
  await pool.query(`
    CREATE TABLE attendance_groups (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      name text NOT NULL,
      code text,
      timezone text NOT NULL DEFAULT 'UTC',
      rule_set_id text
    )`)
  await pool.query(`
    CREATE TABLE attendance_group_members (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      group_id uuid NOT NULL,
      user_id text NOT NULL
    )`)
}

async function waitUntilLockBlocked(pool: Pool, pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = await pool.query(
      `SELECT wait_event_type, wait_event
         FROM pg_stat_activity
        WHERE pid = $1`,
      [pid],
    )
    if (state.rows[0]?.wait_event_type === 'Lock') return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`backend ${pid} did not block on a lock`)
}

describeIfDatabase('W4C-3a record precondition locks (real PostgreSQL)', () => {
  const scratchName = `ms2_w4c3a_pre_${run}`
  const orgId = crypto.randomUUID()
  const existingUserId = crypto.randomUUID()
  const missingUserId = crypto.randomUUID()
  const existingWorkDate = '2026-07-30'
  const missingWorkDate = '2026-07-31'
  const existingRecordId = crypto.randomUUID()
  const missingRecordId = crypto.randomUUID()
  const sourceBatchId = crypto.randomUUID()
  let adminPool: Pool
  let pool: Pool
  let kyselyPool: Pool
  let db: Kysely<unknown>
  let existingWrite: LegacyImportRecordWritePlanV1
  let missingWrite: LegacyImportRecordWritePlanV1

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

    await pool.query(
      `INSERT INTO attendance_records (
         id, org_id, user_id, work_date, first_in_at, last_out_at,
         work_minutes, late_minutes, early_leave_minutes, status,
         is_workday, meta, source_batch_id
       ) VALUES (
         $1,$2,$3,$4::date,'2026-07-30T01:00:00.000Z',
         '2026-07-30T09:00:00.000Z',480,0,0,'normal',true,
         '{"source":"import"}'::jsonb,$5
       )`,
      [
        existingRecordId,
        orgId,
        existingUserId,
        existingWorkDate,
        sourceBatchId,
      ],
    )
    await pool.query(
      `INSERT INTO attendance_record_target_revisions (
         org_id, user_id, work_date, revision
       ) VALUES ($1,$2,$3::date,0)
       ON CONFLICT (org_id, user_id, work_date) DO NOTHING`,
      [orgId, missingUserId, missingWorkDate],
    )

    existingWrite = writePlan({
      orgId,
      userId: existingUserId,
      workDate: existingWorkDate,
      recordId: existingRecordId,
      sourceBatchId,
      targetRevision: 1,
      fingerprint: computeLegacyImportRecordPreconditionFingerprintV1({
        exists: true,
        id: existingRecordId,
        orgId,
        userId: existingUserId,
        workDate: existingWorkDate,
        firstInAt: '2026-07-30T01:00:00.000Z',
        lastOutAt: '2026-07-30T09:00:00.000Z',
        workMinutes: 480,
        lateMinutes: 0,
        earlyLeaveMinutes: 0,
        status: 'normal',
        isWorkday: true,
        meta: { source: 'import' },
        sourceBatchId,
      }),
      expectedSourceOwnership: sourceBatchId,
    })
    missingWrite = writePlan({
      orgId,
      userId: missingUserId,
      workDate: missingWorkDate,
      recordId: missingRecordId,
      sourceBatchId,
      targetRevision: 0,
      fingerprint: LEGACY_IMPORT_MISSING_RECORD_PRECONDITION_FINGERPRINT_V1,
      expectedSourceOwnership: null,
    })
  }, 120000)

  afterAll(async () => {
    for (const current of [pool, kyselyPool, adminPool]) {
      current?.on('error', () => undefined)
    }
    await db?.destroy()
    await pool?.end()
    await adminPool
      ?.query(`DROP DATABASE IF EXISTS ${scratchName} WITH (FORCE)`)
      .catch(() => undefined)
    await adminPool?.end()
  })

  it('rejects an existing-row plan after a concurrent update commits first', async () => {
    const writer = await pool.connect()
    const worker = await pool.connect()
    try {
      await writer.query('BEGIN')
      await writer.query(
        `UPDATE attendance_records
            SET work_minutes = 481
          WHERE org_id = $1 AND user_id = $2 AND work_date = $3::date`,
        [orgId, existingUserId, existingWorkDate],
      )
      await worker.query('BEGIN')
      const pid = Number(
        (await worker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,
      )
      const result = lockAndRecheckAttendanceLegacyRecordPreconditionsV1(
        trx(worker),
        plan([existingWrite]),
      )
      await waitUntilLockBlocked(pool, pid)
      await writer.query('COMMIT')
      await expect(result).resolves.toBe(false)
      await worker.query('ROLLBACK')
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined)
      await worker.query('ROLLBACK').catch(() => undefined)
      writer.release()
      worker.release()
    }
  })

  it('rejects a missing-row plan after a concurrent insert commits first', async () => {
    const writer = await pool.connect()
    const worker = await pool.connect()
    try {
      await writer.query('BEGIN')
      await writer.query(
        `INSERT INTO attendance_records (
           id, org_id, user_id, work_date, work_minutes, status, source_batch_id
         ) VALUES ($1,$2,$3,$4::date,0,'normal',$5)`,
        [missingRecordId, orgId, missingUserId, missingWorkDate, sourceBatchId],
      )
      await worker.query('BEGIN')
      const pid = Number(
        (await worker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,
      )
      const result = lockAndRecheckAttendanceLegacyRecordPreconditionsV1(
        trx(worker),
        plan([missingWrite]),
      )
      await waitUntilLockBlocked(pool, pid)
      await writer.query('COMMIT')
      await expect(result).resolves.toBe(false)
      await worker.query('ROLLBACK')
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined)
      await worker.query('ROLLBACK').catch(() => undefined)
      writer.release()
      worker.release()
    }
  })

  it('holds the existing business row before its revision until worker commit', async () => {
    const worker = await pool.connect()
    const writer = await pool.connect()
    try {
      await pool.query(
        `UPDATE attendance_records
            SET work_minutes = 480
          WHERE org_id = $1 AND user_id = $2 AND work_date = $3::date`,
        [orgId, existingUserId, existingWorkDate],
      )
      const revision = await pool.query(
        `SELECT revision::int AS revision
           FROM attendance_record_target_revisions
          WHERE org_id = $1 AND user_id = $2 AND work_date = $3::date`,
        [orgId, existingUserId, existingWorkDate],
      )
      const currentWrite = {
        ...existingWrite,
        targetRevision: Number(revision.rows[0].revision),
      }
      await worker.query('BEGIN')
      await expect(
        lockAndRecheckAttendanceLegacyRecordPreconditionsV1(
          trx(worker),
          plan([currentWrite]),
        ),
      ).resolves.toBe(true)

      await writer.query('BEGIN')
      const pid = Number(
        (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,
      )
      const update = writer.query(
        `UPDATE attendance_records
            SET work_minutes = 482
          WHERE org_id = $1 AND user_id = $2 AND work_date = $3::date`,
        [orgId, existingUserId, existingWorkDate],
      )
      await waitUntilLockBlocked(pool, pid)
      await worker.query('COMMIT')
      await expect(update).resolves.toMatchObject({ rowCount: 1 })
      await writer.query('ROLLBACK')
    } finally {
      await worker.query('ROLLBACK').catch(() => undefined)
      await writer.query('ROLLBACK').catch(() => undefined)
      worker.release()
      writer.release()
    }
  })

  it('holds the missing target revision before absence recheck until worker commit', async () => {
    await pool.query(
      `DELETE FROM attendance_records
        WHERE org_id = $1 AND user_id = $2 AND work_date = $3::date`,
      [orgId, missingUserId, missingWorkDate],
    )
    const revision = await pool.query(
      `SELECT revision::int AS revision
         FROM attendance_record_target_revisions
        WHERE org_id = $1 AND user_id = $2 AND work_date = $3::date`,
      [orgId, missingUserId, missingWorkDate],
    )
    const currentWrite = {
      ...missingWrite,
      targetRevision: Number(revision.rows[0].revision),
    }
    const worker = await pool.connect()
    const writer = await pool.connect()
    try {
      await worker.query('BEGIN')
      await expect(
        lockAndRecheckAttendanceLegacyRecordPreconditionsV1(
          trx(worker),
          plan([currentWrite]),
        ),
      ).resolves.toBe(true)

      await writer.query('BEGIN')
      const pid = Number(
        (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,
      )
      const insert = writer.query(
        `INSERT INTO attendance_records (
           id, org_id, user_id, work_date, work_minutes, status, source_batch_id
         ) VALUES ($1,$2,$3,$4::date,0,'normal',$5)`,
        [
          crypto.randomUUID(),
          orgId,
          missingUserId,
          missingWorkDate,
          sourceBatchId,
        ],
      )
      await waitUntilLockBlocked(pool, pid)
      await worker.query('COMMIT')
      await expect(insert).resolves.toMatchObject({ rowCount: 1 })
      await writer.query('ROLLBACK')
    } finally {
      await worker.query('ROLLBACK').catch(() => undefined)
      await writer.query('ROLLBACK').catch(() => undefined)
      worker.release()
      writer.release()
    }
  })

  it('serializes two operational-bulk workers on one org sentinel', async () => {
    const first = await pool.connect()
    const second = await pool.connect()
    const bulkPlan = branchPlan(
      [existingWrite],
      'operational_only_batch_limit',
    )
    try {
      await first.query('BEGIN')
      await acquireAttendanceLegacyPlanClass11V1(trx(first), bulkPlan, [])

      await second.query('BEGIN')
      const secondPid = Number(
        (await second.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,
      )
      const secondAcquire = acquireAttendanceLegacyPlanClass11V1(
        trx(second),
        bulkPlan,
        [],
      )
      void secondAcquire.catch(() => undefined)
      await waitUntilLockBlocked(pool, secondPid)

      const held = await pool.query(
        `SELECT granted, count(*)::int AS n
           FROM pg_locks
          WHERE locktype = 'advisory'
            AND pid IN ($1, $2)
          GROUP BY granted
          ORDER BY granted`,
        [
          Number((await first.query('SELECT pg_backend_pid() AS pid')).rows[0].pid),
          secondPid,
        ],
      )
      expect(held.rows).toEqual([
        { granted: false, n: 1 },
        { granted: true, n: 1 },
      ])

      await first.query('COMMIT')
      await expect(secondAcquire).resolves.toBeUndefined()
      await second.query('COMMIT')
    } finally {
      await first.query('ROLLBACK').catch(() => undefined)
      await second.query('ROLLBACK').catch(() => undefined)
      first.release()
      second.release()
    }
  })

  it.each([
    ['operational-bulk first', 'operational_only_batch_limit', 'strict_targeted'],
    ['strict-targeted first', 'strict_targeted', 'operational_only_batch_limit'],
  ] as const)(
    'serializes one shared preimage across branches: %s',
    async (_label, firstBranch, secondBranch) => {
      await pool.query(
        `UPDATE attendance_records
            SET work_minutes = 480,
                first_in_at = '2026-07-30T01:00:00.000Z',
                last_out_at = '2026-07-30T09:00:00.000Z',
                late_minutes = 0,
                early_leave_minutes = 0,
                status = 'normal',
                is_workday = true,
                meta = '{"source":"import"}'::jsonb,
                source_batch_id = $4::uuid
          WHERE org_id = $1 AND user_id = $2 AND work_date = $3::date`,
        [orgId, existingUserId, existingWorkDate, sourceBatchId],
      )
      const current = await pool.query(
        `SELECT revision::int AS revision
           FROM attendance_record_target_revisions
          WHERE org_id = $1 AND user_id = $2 AND work_date = $3::date`,
        [orgId, existingUserId, existingWorkDate],
      )
      const currentWrite: LegacyImportRecordWritePlanV1 = {
        ...existingWrite,
        targetRevision: Number(current.rows[0].revision),
        workMinutes: 481,
        lateMinutes: 0,
        earlyLeaveMinutes: 0,
        status: 'normal',
        isWorkday: true,
      }
      const firstPlan = branchPlan([currentWrite], firstBranch)
      const secondPlan = branchPlan([currentWrite], secondBranch)
      const posture = await resolveSegmentCalculationPosture(
        trx(pool as unknown as PoolClient),
        orgId,
      )
      const verifiedOrg = createVerifiedAttendanceOrgIdentityV1({
        orgKey: orgId,
        posture,
      })
      const target = createVerifiedAttendanceCalculationTargetIdentityV1({
        org: verifiedOrg,
        userId: existingUserId,
        workDate: existingWorkDate,
      })
      const identities = [target]
      const class11Identities = (
        branch: typeof firstBranch,
      ) => (branch === 'strict_targeted' ? identities : [])

      const first = await pool.connect()
      const second = await pool.connect()
      try {
        await first.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
        await acquireAttendanceLegacyPlanClass11V1(
          trx(first),
          firstPlan,
          class11Identities(firstBranch),
        )
        await expect(
          lockAndRecheckAttendanceLegacyRecordPreconditionsV1(
            trx(first),
            firstPlan,
          ),
        ).resolves.toBe(true)

        await second.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
        await acquireAttendanceLegacyPlanClass11V1(
          trx(second),
          secondPlan,
          class11Identities(secondBranch),
        )
        const secondPid = Number(
          (await second.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,
        )
        const secondRecheck =
          lockAndRecheckAttendanceLegacyRecordPreconditionsV1(
            trx(second),
            secondPlan,
          )
        void secondRecheck.catch(() => undefined)
        await waitUntilLockBlocked(pool, secondPid)

        await applyAttendanceLegacyRecordEffectsV1(trx(first), firstPlan)
        await first.query('COMMIT')
        await expect(secondRecheck).rejects.toMatchObject({ code: '40001' })
        await second.query('ROLLBACK')

        const fresh = await pool.connect()
        try {
          await fresh.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
          await acquireAttendanceLegacyPlanClass11V1(
            trx(fresh),
            secondPlan,
            class11Identities(secondBranch),
          )
          await expect(
            lockAndRecheckAttendanceLegacyRecordPreconditionsV1(
              trx(fresh),
              secondPlan,
            ),
          ).resolves.toBe(false)
          await fresh.query('ROLLBACK')
        } finally {
          await fresh.query('ROLLBACK').catch(() => undefined)
          fresh.release()
        }
      } finally {
        await first.query('ROLLBACK').catch(() => undefined)
        await second.query('ROLLBACK').catch(() => undefined)
        first.release()
        second.release()
      }
    },
    30000,
  )
})
