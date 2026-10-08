import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import {
  ATTENDANCE_LEGACY_MEMBERSHIP_AUDIT_INTEGRITY_ERROR,
  ATTENDANCE_LEGACY_MEMBERSHIP_AUDIT_SCHEMA_NOT_READY,
  auditAttendanceLegacyMembershipOverlaps,
} from '../../src/services/AttendanceLegacyMembershipOverlapAudit'
import { up as membershipMigrationUp } from '../../src/db/migrations/zzzz20260723140000_create_attendance_calculation_group_memberships'
import {
  attachOwnedPoolTerminationHandler,
  dropScratchDatabase,
  formatScratchDropOutcome,
  type OwnedPoolTerminationHandler,
} from '../helpers/scratch-database'

const serverUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = serverUrl ? describe : describe.skip

describeIfDatabase('legacy attendance membership overlap audit (isolated real DB)', () => {
  const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
  const tsxCli = resolve(repoRoot, 'node_modules/tsx/dist/cli.mjs')
  const auditCli = resolve(repoRoot, 'scripts/ops/attendance-legacy-membership-overlap-audit.ts')
  const databaseName = `attendance_legacy_audit_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  const adminUrl = new URL(serverUrl || 'postgresql://postgres@localhost/postgres')
  adminUrl.pathname = '/postgres'
  const scratchUrl = new URL(adminUrl)
  scratchUrl.pathname = `/${databaseName}`
  const adminPool = new Pool({ connectionString: adminUrl.toString() })
  let pool: Pool
  let terminationHandler: OwnedPoolTerminationHandler

  function runAuditCli(orgId: string) {
    return spawnSync(process.execPath, [tsxCli, auditCli, '--org', orgId], {
      cwd: repoRoot,
      env: {
        ...process.env,
        DATABASE_URL: scratchUrl.toString(),
        ATTENDANCE_TEST_DATABASE_URL: scratchUrl.toString(),
      },
      encoding: 'utf8',
      timeout: 30_000,
    })
  }

  const orgA = 'org-a'
  const orgB = 'org-b'
  const userId = 'user-a'
  const raceUserId = 'user-race'
  const groupA = randomUUID()
  const groupB = randomUUID()
  const groupForeign = randomUUID()

  beforeAll(async () => {
    await adminPool.query(`CREATE DATABASE ${databaseName}`)
    pool = new Pool({ connectionString: scratchUrl.toString(), max: 6 })
    terminationHandler = attachOwnedPoolTerminationHandler(pool)
  })

  afterAll(async () => {
    try {
      await pool?.end().catch(() => {})
      const outcome = await dropScratchDatabase(adminPool, databaseName)
      console.log(formatScratchDropOutcome('attendance-legacy-membership-overlap-audit', outcome))
    } finally {
      terminationHandler?.detach()
    }
    await adminPool.end()
  })

  it('fails closed on a fresh database, then audits an upgraded legacy shape deterministically', async () => {
    await expect(
      auditAttendanceLegacyMembershipOverlaps(orgA, (statement, params) => pool.query(statement, params)),
    ).rejects.toMatchObject({ code: ATTENDANCE_LEGACY_MEMBERSHIP_AUDIT_SCHEMA_NOT_READY })
    const freshDatabaseCli = runAuditCli(orgA)
    expect(freshDatabaseCli.status, freshDatabaseCli.stderr).toBe(3)
    expect(freshDatabaseCli.stderr).toContain(ATTENDANCE_LEGACY_MEMBERSHIP_AUDIT_SCHEMA_NOT_READY)

    await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto')
    await pool.query('CREATE EXTENSION IF NOT EXISTS btree_gist')
    await pool.query(`
      CREATE TABLE users (
        id text PRIMARY KEY,
        is_active boolean NOT NULL
      );
      CREATE TABLE user_orgs (
        user_id text NOT NULL,
        org_id text NOT NULL,
        is_active boolean NOT NULL,
        PRIMARY KEY (user_id, org_id)
      );
      CREATE TABLE attendance_groups (
        id uuid PRIMARY KEY,
        org_id text NOT NULL,
        name text NOT NULL
      );
      CREATE TABLE attendance_group_members (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id text NOT NULL,
        group_id uuid NOT NULL REFERENCES attendance_groups(id) ON DELETE CASCADE,
        user_id text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (org_id, group_id, user_id)
      )
    `)

    await pool.query(
      `INSERT INTO users (id, is_active) VALUES ($1, true), ($2, true)`,
      [userId, raceUserId],
    )
    await pool.query(
      `INSERT INTO user_orgs (user_id, org_id, is_active)
       VALUES ($1, $2, true), ($1, $3, true), ($4, $2, true)`,
      [userId, orgA, orgB, raceUserId],
    )
    await pool.query(
      `INSERT INTO attendance_groups (id, org_id, name)
       VALUES ($1, $4, 'A'), ($2, $4, 'B'), ($3, $5, 'Foreign')`,
      [groupA, groupB, groupForeign, orgA, orgB],
    )
    await pool.query(
      `INSERT INTO attendance_group_members (org_id, group_id, user_id)
       VALUES ($1, $2, $3), ($1, $4, $3), ($5, $6, $3)`,
      [orgA, groupA, userId, groupB, orgB, groupForeign],
    )

    const migrationPool = new Pool({ connectionString: scratchUrl.toString(), max: 2 })
    const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: migrationPool }) })
    try {
      await membershipMigrationUp(db)
    } finally {
      await db.destroy()
    }

    const runQuery = (statement: string, params?: unknown[]) => pool.query(statement, params)
    const first = await auditAttendanceLegacyMembershipOverlaps(orgA, runQuery)
    const second = await auditAttendanceLegacyMembershipOverlaps(orgA, runQuery)
    const foreign = await auditAttendanceLegacyMembershipOverlaps(orgB, runQuery)

    expect(second).toEqual(first)
    expect(first).toMatchObject({
      orgId: orgA,
      scannedRows: 2,
      conflictCount: 1,
      zeroConflicts: false,
      conflicts: [{ userId, remediation: { posture: 'manual_transfer_required' } }],
    })
    expect(foreign).toMatchObject({ orgId: orgB, scannedRows: 1, conflictCount: 0, zeroConflicts: true })

    const conflictCli = runAuditCli(orgA)
    expect(conflictCli.status, conflictCli.stderr).toBe(4)
    expect(JSON.parse(conflictCli.stdout)).toEqual(first)
    const cleanCli = runAuditCli(orgB)
    expect(cleanCli.status, cleanCli.stderr).toBe(0)
    expect(JSON.parse(cleanCli.stdout)).toEqual(foreign)

    await pool.query(
      `INSERT INTO attendance_group_members (org_id, group_id, user_id)
       VALUES ($1, $2, $3)`,
      [orgA, groupForeign, userId],
    )
    await expect(auditAttendanceLegacyMembershipOverlaps(orgA, runQuery)).rejects.toMatchObject({
      code: ATTENDANCE_LEGACY_MEMBERSHIP_AUDIT_INTEGRITY_ERROR,
      status: 409,
    })
    const crossOrgCli = runAuditCli(orgA)
    expect(crossOrgCli.status, crossOrgCli.stderr).toBe(3)
    expect(crossOrgCli.stderr).toContain(ATTENDANCE_LEGACY_MEMBERSHIP_AUDIT_INTEGRITY_ERROR)

    const concurrent = await Promise.allSettled([
      pool.query(
        `INSERT INTO attendance_calculation_group_memberships (
           org_id, user_id, group_id, effective_from, effective_to,
           assigned_by, assigned_reason, assigned_correlation_id
         ) VALUES ($1, $2, $3, '2026-08-01', NULL, 'qa', 'race-a', 'race-a')`,
        [orgA, raceUserId, groupA],
      ),
      pool.query(
        `INSERT INTO attendance_calculation_group_memberships (
           org_id, user_id, group_id, effective_from, effective_to,
           assigned_by, assigned_reason, assigned_correlation_id
         ) VALUES ($1, $2, $3, '2026-08-01', NULL, 'qa', 'race-b', 'race-b')`,
        [orgA, raceUserId, groupB],
      ),
    ])
    expect(concurrent.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1)
    const rejected = concurrent.find((entry) => entry.status === 'rejected')
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: {
        code: '23P01',
        constraint: 'attendance_calc_group_memberships_no_overlap',
      },
    })
  })
})
