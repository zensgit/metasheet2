import crypto from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { up as w4c0Up } from '../../src/db/migrations/zzzz20260725120000_w4c0_attendance_segment_calculation_durable_storage'
import { up as w4c3aUp } from '../../src/db/migrations/zzzz20260730120000_w4c3a_durable_legacy_execution_plan'
import {
  LEGACY_IMPORT_MISSING_RECORD_PRECONDITION_FINGERPRINT_V1,
  type LegacyImportRecordWritePlanV1,
} from '../../src/attendance/w4c3a-legacy-execution-plan'
import { applyAttendanceLegacyRecordEffectsV1 } from '../../src/attendance/w4c3a-legacy-plan-record-effects'
import type { VerifiedAttendanceLegacyPlanV1 } from '../../src/attendance/w4c3a-legacy-plan-worker'
import type { AttendanceW4TransactionClientV1 } from '../../src/attendance/w4c0-identity'

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

function recordWrite(input: {
  orgId: string
  userId: string
  workDate: string
  recordId: string
  sourceBatchId: string
  targetRevision: number
  existing: boolean
  status: string
  timezone: string
  compatibilityMetadata: unknown
}): LegacyImportRecordWritePlanV1 {
  return {
    recordWriteId: crypto.randomUUID(),
    orgId: input.orgId,
    userId: input.userId,
    workDate: input.workDate,
    sourceOrdinals: [0],
    mergeMode: 'merge',
    firstInAt: `${input.workDate}T01:05:00.000Z`,
    lastOutAt: `${input.workDate}T09:10:00.000Z`,
    workMinutes: 485,
    lateMinutes: 5,
    earlyLeaveMinutes: 0,
    status: input.status,
    isWorkday: true,
    timezone: input.timezone,
    targetRevision: input.targetRevision,
    existingRecordPreconditionFingerprint: input.existing
      ? 'a'.repeat(64)
      : LEGACY_IMPORT_MISSING_RECORD_PRECONDITION_FINGERPRINT_V1,
    expectedSourceOwnership: input.existing ? input.sourceBatchId : null,
    recordId: input.recordId,
    compatibilityMetadata: input.compatibilityMetadata,
    policySnapshot: { forbidden: 'policy' },
    profileSnapshot: { forbidden: 'profile' },
    multiPunchSnapshot: { forbidden: 'multi' },
    attributionSnapshot: { forbidden: 'attribution' },
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
      timezone text NOT NULL DEFAULT 'UTC',
      first_in_at timestamptz,
      last_out_at timestamptz,
      work_minutes integer NOT NULL DEFAULT 0,
      late_minutes integer NOT NULL DEFAULT 0,
      early_leave_minutes integer NOT NULL DEFAULT 0,
      status varchar(64) NOT NULL DEFAULT 'normal',
      is_workday boolean,
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

it('sentinel: DATABASE_URL is set (real-DB lane must not silently skip)', () => {
  expect(dbUrl).toBeTruthy()
})

describeIfDatabase('W4C-3a fixed record effects (real PostgreSQL)', () => {
  const scratchName = `ms2_w4c3a_effects_${run}`
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
  }, 120000)

  afterAll(async () => {
    for (const current of [pool, kyselyPool, adminPool]) {
      current?.on('error', () => undefined)
    }
    await db?.destroy()
    await pool?.end()
    if (adminPool) {
      await adminPool.query(`DROP DATABASE IF EXISTS ${scratchName}`)
      await adminPool.end()
    }
  })

  it('applies frozen existing and missing branches and lets revision triggers observe both writes', async () => {
    const client = await pool.connect()
    const orgId = `w4c3a-effects-org-${run}`
    const existingUserId = `w4c3a-effects-existing-${run}`
    const missingUserId = `w4c3a-effects-missing-${run}`
    const existingWorkDate = '2026-07-30'
    const missingWorkDate = '2026-07-31'
    const existingRecordId = crypto.randomUUID()
    const missingRecordId = crypto.randomUUID()
    const existingSourceBatchId = crypto.randomUUID()
    const appliedSourceBatchId = crypto.randomUUID()

    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO attendance_records (
           id, org_id, user_id, work_date, timezone, first_in_at, last_out_at,
           work_minutes, late_minutes, early_leave_minutes, status,
           is_workday, meta, source_batch_id, updated_at
         ) VALUES (
           $1,$2,$3,$4::date,'UTC',NULL,NULL,0,0,0,'normal',true,
           '{"before":true}'::jsonb,$5,now()
         )`,
        [
          existingRecordId,
          orgId,
          existingUserId,
          existingWorkDate,
          existingSourceBatchId,
        ],
      )
      const revisionBefore = await client.query(
        `SELECT revision::text AS revision
           FROM attendance_record_target_revisions
          WHERE org_id = $1 AND user_id = $2 AND work_date = $3::date`,
        [orgId, existingUserId, existingWorkDate],
      )
      expect(revisionBefore.rows).toEqual([{ revision: '1' }])

      await applyAttendanceLegacyRecordEffectsV1(
        trx(client),
        plan([
          recordWrite({
            orgId,
            userId: existingUserId,
            workDate: existingWorkDate,
            recordId: existingRecordId,
            sourceBatchId: appliedSourceBatchId,
            targetRevision: 1,
            existing: true,
            status: 'late',
            timezone: 'Asia/Taipei',
            compatibilityMetadata: { frozen: 'existing' },
          }),
          recordWrite({
            orgId,
            userId: missingUserId,
            workDate: missingWorkDate,
            recordId: missingRecordId,
            sourceBatchId: appliedSourceBatchId,
            targetRevision: 0,
            existing: false,
            status: 'normal',
            timezone: 'Asia/Shanghai',
            compatibilityMetadata: { frozen: 'missing' },
          }),
        ]),
      )

      const records = await client.query(
        `SELECT id::text AS id, user_id, work_date::text AS work_date,
                timezone, first_in_at, last_out_at, work_minutes,
                late_minutes, early_leave_minutes, status, is_workday,
                meta, source_batch_id::text AS source_batch_id
           FROM attendance_records
          WHERE org_id = $1
            AND user_id = ANY($2::text[])
          ORDER BY user_id`,
        [orgId, [existingUserId, missingUserId]],
      )
      expect(records.rows).toEqual([
        {
          id: existingRecordId,
          user_id: existingUserId,
          work_date: existingWorkDate,
          timezone: 'Asia/Taipei',
          first_in_at: new Date(`${existingWorkDate}T01:05:00.000Z`),
          last_out_at: new Date(`${existingWorkDate}T09:10:00.000Z`),
          work_minutes: 485,
          late_minutes: 5,
          early_leave_minutes: 0,
          status: 'late',
          is_workday: true,
          meta: { frozen: 'existing' },
          source_batch_id: null,
        },
        {
          id: missingRecordId,
          user_id: missingUserId,
          work_date: missingWorkDate,
          timezone: 'Asia/Shanghai',
          first_in_at: new Date(`${missingWorkDate}T01:05:00.000Z`),
          last_out_at: new Date(`${missingWorkDate}T09:10:00.000Z`),
          work_minutes: 485,
          late_minutes: 5,
          early_leave_minutes: 0,
          status: 'normal',
          is_workday: true,
          meta: { frozen: 'missing' },
          source_batch_id: appliedSourceBatchId,
        },
      ])

      const revisions = await client.query(
        `SELECT user_id, revision::text AS revision
           FROM attendance_record_target_revisions
          WHERE org_id = $1
            AND user_id = ANY($2::text[])
          ORDER BY user_id`,
        [orgId, [existingUserId, missingUserId]],
      )
      expect(revisions.rows).toEqual([
        { user_id: existingUserId, revision: '2' },
        { user_id: missingUserId, revision: '1' },
      ])

      const rolledBack = await client.query(
        `DELETE FROM attendance_records
          WHERE org_id = $1
            AND source_batch_id = $2::uuid
        RETURNING id::text AS id`,
        [orgId, appliedSourceBatchId],
      )
      expect(rolledBack.rows).toEqual([{ id: missingRecordId }])
      const retainedExisting = await client.query(
        `SELECT id::text AS id, source_batch_id::text AS source_batch_id
           FROM attendance_records
          WHERE id = $1::uuid AND org_id = $2`,
        [existingRecordId, orgId],
      )
      expect(retainedExisting.rows).toEqual([
        { id: existingRecordId, source_batch_id: null },
      ])
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })
})
