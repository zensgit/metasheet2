/**
 * P2-G: real SQL count legs for OD-W4C-60 group/batch result semantics.
 */
import crypto from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool, type PoolClient } from 'pg'
import { applyAttendanceLegacyGroupEffectsV1 } from '../../src/attendance/w4c3a-legacy-plan-group-effects'
import {
  buildAttendanceLegacyFirstExecutionBatchMetaV1,
} from '../../src/attendance/w4c3a-legacy-plan-batch-effects'
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
  orgId: string,
  groupEffects: VerifiedAttendanceLegacyPlanV1['groupEffects'],
  compatibilityMetadata: unknown = {},
): VerifiedAttendanceLegacyPlanV1 {
  return {
    manifest: {
      orgId,
      batchId: crypto.randomUUID(),
      createdBy: 'admin',
      batch: {
        kind: 'normal',
        source: 'manual',
        ruleSetId: null,
        mappingSnapshot: {},
        sourceRowCount: 0,
        status: 'committed',
        idempotencyKey: null,
        visibilityRule: 'org',
        engine: 'standard',
        chunkConfig: {},
        recordUpsertStrategy: 'unnest',
        itemsInsertStrategy: 'unnest',
        mappingProfileId: null,
        compatibilityMetadata,
        groupSync: null,
        itemReturnPolicy: { returnItems: false, itemsLimit: null },
        skippedSamplePolicy: { limit: 50 },
        resultSlots: {
          groupCreated: 'ensure_group_returned_row_count',
          groupMembersAdded: 'ensure_member_inserted_row_count',
        },
      },
    },
    chunks: [],
    items: [],
    recordWrites: [],
    groupEffects,
  } as unknown as VerifiedAttendanceLegacyPlanV1
}

describeIfDatabase('W4C-3a group effect SQL counts (real PostgreSQL)', () => {
  const scratchName = `ms2_w4c3a_geff_${run}`
  const orgId = `w4c3a-geff-org-${run}`
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
      CREATE TABLE attendance_groups (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id text NOT NULL,
        name text NOT NULL,
        code text,
        timezone text NOT NULL DEFAULT 'UTC',
        rule_set_id uuid,
        description text,
        created_at timestamptz DEFAULT now(),
        updated_at timestamptz DEFAULT now(),
        UNIQUE (org_id, name)
      )`)
    await pool.query(`
      CREATE TABLE attendance_group_members (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id text NOT NULL,
        group_id uuid NOT NULL,
        user_id text NOT NULL,
        created_at timestamptz DEFAULT now(),
        updated_at timestamptz DEFAULT now(),
        UNIQUE (org_id, group_id, user_id)
      )`)
  }, 60_000)

  afterAll(async () => {
    await pool?.end().catch(() => undefined)
    if (adminPool) {
      await adminPool.query(`DROP DATABASE IF EXISTS ${scratchName}`).catch(() => undefined)
      await adminPool.end().catch(() => undefined)
    }
  })

  it('conflict-updated ensure_group returns groupCreated=1; empty effects remain 0', async () => {
    const existingId = crypto.randomUUID()
    const name = `Sales ${run}`
    await pool.query(
      `INSERT INTO attendance_groups (id, org_id, name, timezone)
       VALUES ($1, $2, $3, 'UTC')`,
      [existingId, orgId, name],
    )
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      // Frozen ensure_group against an existing name (conflict-update path).
      const withEnsure = plan(orgId, [
        {
          kind: 'ensure_group',
          groupId: existingId,
          normalizedName: name.toLowerCase(),
          displayName: name,
          code: null,
          timezone: 'Asia/Taipei',
          ruleSetId: null,
          groupExistedAtPrepare: true,
        },
      ])
      const created = await applyAttendanceLegacyGroupEffectsV1(
        trx(client),
        withEnsure,
      )
      expect(created.groupCreated).toBe(1)
      expect(created.groupMembersAdded).toBe(0)

      // Existing frozen-map group with no ensure_group effect → 0.
      const noEnsure = plan(orgId, [])
      const none = await applyAttendanceLegacyGroupEffectsV1(trx(client), noEnsure)
      expect(none).toEqual({ groupCreated: 0, groupMembersAdded: 0 })
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })

  it('membership conflict returns groupMembersAdded=0; compatibilityMetadata cannot override counters', async () => {
    const groupId = crypto.randomUUID()
    const memberId = crypto.randomUUID()
    const userId = `member-${run}`
    await pool.query(
      `INSERT INTO attendance_groups (id, org_id, name, timezone)
       VALUES ($1, $2, $3, 'UTC')`,
      [groupId, orgId, `Ops ${run}`],
    )
    await pool.query(
      `INSERT INTO attendance_group_members (org_id, group_id, user_id)
       VALUES ($1, $2, $3)`,
      [orgId, groupId, userId],
    )
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const withMember = plan(
        orgId,
        [
          {
            kind: 'ensure_member',
            memberId,
            groupRef: groupId,
            userId,
            membershipExistedAtPrepare: true,
          },
        ],
        { groupCreated: 42, groupMembersAdded: 99, extra: true },
      )
      const result = await applyAttendanceLegacyGroupEffectsV1(
        trx(client),
        withMember,
      )
      expect(result.groupCreated).toBe(0)
      expect(result.groupMembersAdded).toBe(0)
      const meta = buildAttendanceLegacyFirstExecutionBatchMetaV1(
        withMember,
        result,
      )
      expect(meta.groupCreated).toBe(0)
      expect(meta.groupMembersAdded).toBe(0)
      expect(meta.extra).toBe(true)
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })
})
