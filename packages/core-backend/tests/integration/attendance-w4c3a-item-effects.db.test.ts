import crypto from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool, type PoolClient } from 'pg'
import { canonicalAttendanceJsonV1 } from '../../src/attendance/w4c0-fingerprints'
import type { AttendanceW4TransactionClientV1 } from '../../src/attendance/w4c0-identity'
import type {
  LegacyImportItemPlanV1,
  LegacyImportRecordWritePlanV1,
} from '../../src/attendance/w4c3a-legacy-execution-plan'
import { applyAttendanceLegacyItemEffectsV1 } from '../../src/attendance/w4c3a-legacy-plan-item-effects'
import type { VerifiedAttendanceLegacyPlanV1 } from '../../src/attendance/w4c3a-legacy-plan-worker'
import { rawImportEvidenceV1 } from '../utils/attendance-w4c3a-raw-evidence'

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

function recordWrite(input: {
  orgId: string
  userId: string
  workDate: string
  recordId: string
  sourceBatchId: string
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
    targetRevision: 0,
    existingRecordPreconditionFingerprint: 'a'.repeat(64),
    expectedSourceOwnership: null,
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

function plan(input: {
  orgId: string
  batchId: string
  items: readonly LegacyImportItemPlanV1[]
  recordWrites: readonly LegacyImportRecordWritePlanV1[]
}): VerifiedAttendanceLegacyPlanV1 {
  return {
    manifest: {
      orgId: input.orgId,
      batchId: input.batchId,
    },
    chunks: [],
    items: input.items,
    recordWrites: input.recordWrites,
    groupEffects: [],
  } as unknown as VerifiedAttendanceLegacyPlanV1
}

it('sentinel: DATABASE_URL is set (real-DB lane must not silently skip)', () => {
  expect(dbUrl).toBeTruthy()
})

describeIfDatabase('W4C-3a fixed item effects (real PostgreSQL)', () => {
  const scratchName = `ms2_w4c3a_item_effects_${run}`
  let adminPool: Pool
  let pool: Pool

  beforeAll(async () => {
    const adminUrl = new URL(dbUrl as string)
    adminUrl.pathname = '/postgres'
    adminPool = new Pool({ connectionString: adminUrl.toString() })
    await adminPool.query(`DROP DATABASE IF EXISTS ${scratchName}`)
    await adminPool.query(`CREATE DATABASE ${scratchName}`)

    const scratchUrl = new URL(dbUrl as string)
    scratchUrl.pathname = `/${scratchName}`
    pool = new Pool({ connectionString: scratchUrl.toString() })
    await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto')
    await pool.query(`
      CREATE TABLE attendance_import_batches (
        id uuid PRIMARY KEY,
        org_id text NOT NULL
      )`)
    await pool.query(`
      CREATE TABLE attendance_import_items (
        id uuid PRIMARY KEY,
        batch_id uuid NOT NULL REFERENCES attendance_import_batches(id),
        org_id text NOT NULL,
        user_id text,
        work_date date,
        record_id uuid,
        preview_snapshot jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      )`)
  }, 120000)

  afterAll(async () => {
    for (const current of [pool, adminPool]) {
      current?.on('error', () => undefined)
    }
    await pool?.end()
    if (adminPool) {
      await adminPool.query(`DROP DATABASE IF EXISTS ${scratchName}`)
      await adminPool.end()
    }
  })

  it('persists apply and skip items in frozen order with exact nullable fields', async () => {
    const client = await pool.connect()
    const orgId = `w4c3a-item-org-${run}`
    const userId = `w4c3a-item-user-${run}`
    const skippedUserId = `w4c3a-item-skipped-${run}`
    const workDate = '2026-07-30'
    const skippedWorkDate = '2026-07-31'
    const batchId = crypto.randomUUID()
    const recordId = crypto.randomUUID()
    const applyItemId = crypto.randomUUID()
    const skipItemId = crypto.randomUUID()
    const write = recordWrite({
      orgId,
      userId,
      workDate,
      recordId,
      sourceBatchId: batchId,
    })

    try {
      await client.query('BEGIN')
      await client.query(
        'INSERT INTO attendance_import_batches (id, org_id) VALUES ($1, $2)',
        [batchId, orgId],
      )
      await applyAttendanceLegacyItemEffectsV1(
        trx(client),
        plan({
          orgId,
          batchId,
          recordWrites: [write],
          items: [
            {
              kind: 'apply',
              ordinal: 0,
              semanticOrdinal: 0,
              itemId: applyItemId,
              targetRef: canonicalAttendanceJsonV1([
                orgId,
                userId,
                workDate,
              ]),
              previewSnapshot: { kind: 'apply', nested: { value: 1 } },
              recordWriteRef: write.recordWriteId,
              rawEvidence: rawImportEvidenceV1(0),
            },
            {
              kind: 'skip',
              ordinal: 1,
              semanticOrdinal: null,
              itemId: skipItemId,
              resolvedUserId: skippedUserId,
              resolvedWorkDate: skippedWorkDate,
              reasonCode: 'invalid_row',
              warnings: [],
              previewSnapshot: { kind: 'skip', nested: { value: 2 } },
              rawEvidence: rawImportEvidenceV1(1),
            },
          ],
        }),
      )

      const persisted = await client.query(
        `SELECT id::text AS id, batch_id::text AS batch_id, org_id, user_id,
                work_date::text AS work_date, record_id::text AS record_id,
                preview_snapshot
           FROM attendance_import_items
          WHERE batch_id = $1
          ORDER BY CASE id WHEN $2::uuid THEN 0 ELSE 1 END`,
        [batchId, applyItemId],
      )
      expect(persisted.rows).toEqual([
        {
          id: applyItemId,
          batch_id: batchId,
          org_id: orgId,
          user_id: userId,
          work_date: workDate,
          record_id: recordId,
          preview_snapshot: { kind: 'apply', nested: { value: 1 } },
        },
        {
          id: skipItemId,
          batch_id: batchId,
          org_id: orgId,
          user_id: skippedUserId,
          work_date: skippedWorkDate,
          record_id: null,
          preview_snapshot: { kind: 'skip', nested: { value: 2 } },
        },
      ])
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })
})
