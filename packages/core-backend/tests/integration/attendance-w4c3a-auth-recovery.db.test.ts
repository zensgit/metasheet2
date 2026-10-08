/**
 * P1-F: full-import authorization recovery matrix.
 *
 * Proves the reconstructed job-row context matches governing full-import
 * recheck semantics, and that subjectScope is structural (not consumed by the
 * permission SQL).
 */
import crypto from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool, type PoolClient } from 'pg'
import {
  authorizeAttendanceLegacyPlanFullImportFromJobV1,
  recheckAttendanceFullImportAuthorizationInTransactionV1,
} from '../../src/attendance/w4c3a-legacy-plan-enqueue'
import {
  createAuthorizedAttendanceWriteContextV1,
} from '../../src/attendance/w4c0-authorization'
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

describeIfDatabase('W4C-3a authorization recovery matrix (real PostgreSQL)', () => {
  const scratchName = `ms2_w4c3a_auth_${run}`
  const ORG = crypto.randomUUID()
  const OTHER_ORG = crypto.randomUUID()
  const ADMIN = `w4c3a-auth-admin-${run}`
  const LOST = `w4c3a-auth-lost-${run}`
  const SCOPED = `w4c3a-auth-scoped-${run}`
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

    // Active full-import actor: platform admin role.
    await pool.query(
      `INSERT INTO users (id) VALUES ($1), ($2), ($3)`,
      [ADMIN, LOST, SCOPED],
    )
    await pool.query(
      `INSERT INTO user_orgs (user_id, org_id) VALUES ($1, $2), ($3, $2)`,
      [ADMIN, ORG, LOST],
    )
    await pool.query(
      `INSERT INTO user_orgs (user_id, org_id) VALUES ($1, $2)`,
      [SCOPED, ORG],
    )
    await pool.query(
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'admin')`,
      [ADMIN],
    )
    await pool.query(
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'attendance')`,
      [SCOPED],
    )
    await pool.query(
      `INSERT INTO user_namespace_admissions (user_id, namespace, enabled)
       VALUES ($1, 'attendance', true)`,
      [SCOPED],
    )
    await pool.query(
      `INSERT INTO user_permissions (user_id, permission_code)
       VALUES ($1, 'attendance:import')`,
      [SCOPED],
    )
    // LOST has no admin role and no attendance permission.
  }, 60_000)

  afterAll(async () => {
    await pool?.end().catch(() => undefined)
    if (adminPool) {
      await adminPool.query(`DROP DATABASE IF EXISTS ${scratchName}`).catch(() => undefined)
      await adminPool.end().catch(() => undefined)
    }
  })

  it('active admin is authorized; permission loss fails closed', async () => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const ok = await authorizeAttendanceLegacyPlanFullImportFromJobV1(trx(client), {
        orgId: ORG,
        actorId: ADMIN,
        actorPosture: 'platform_admin',
        tokenSubjectUserId: ADMIN,
        sourceRef: 'attendance-import',
      })
      expect(ok).toBe(true)

      const lost = await authorizeAttendanceLegacyPlanFullImportFromJobV1(trx(client), {
        orgId: ORG,
        actorId: LOST,
        actorPosture: 'platform_admin',
        tokenSubjectUserId: LOST,
        sourceRef: 'attendance-import',
      })
      expect(lost).toBe(false)

      // Deactivate admin → fail closed.
      await client.query(`UPDATE users SET is_active = false WHERE id = $1`, [ADMIN])
      const inactive = await authorizeAttendanceLegacyPlanFullImportFromJobV1(
        trx(client),
        {
          orgId: ORG,
          actorId: ADMIN,
          actorPosture: 'platform_admin',
          tokenSubjectUserId: ADMIN,
          sourceRef: 'attendance-import',
        },
      )
      expect(inactive).toBe(false)
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })

  it('subjectScope is structural: same actorId yields same recheck under different scopes', async () => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      // Ensure admin is active for this isolation.
      await client.query(
        `UPDATE users SET is_active = true, activation_status = 'activated' WHERE id = $1`,
        [ADMIN],
      )

      const selfCtx = createAuthorizedAttendanceWriteContextV1({
        orgId: ORG,
        actorId: ADMIN,
        actorPosture: 'platform_admin',
        tokenSubjectUserId: ADMIN,
        sourceRef: 'attendance-import',
        capability: 'import',
        subjectScope: { kind: 'self', userId: ADMIN },
      })
      const explicitCtx = createAuthorizedAttendanceWriteContextV1({
        orgId: ORG,
        actorId: ADMIN,
        actorPosture: 'platform_admin',
        tokenSubjectUserId: ADMIN,
        sourceRef: 'attendance-import',
        capability: 'import',
        subjectScope: { kind: 'explicit_users', userIds: [ADMIN, LOST] },
      })

      // Both must succeed — permission SQL binds actorId only.
      await expect(
        recheckAttendanceFullImportAuthorizationInTransactionV1(trx(client), selfCtx),
      ).resolves.toBeUndefined()
      await expect(
        recheckAttendanceFullImportAuthorizationInTransactionV1(
          trx(client),
          explicitCtx,
        ),
      ).resolves.toBeUndefined()

      // Recovery helper matches the same actorId success.
      await expect(
        authorizeAttendanceLegacyPlanFullImportFromJobV1(trx(client), {
          orgId: ORG,
          actorId: ADMIN,
          actorPosture: 'platform_admin',
          tokenSubjectUserId: ADMIN,
          sourceRef: 'attendance-import',
        }),
      ).resolves.toBe(true)
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })

  it('binds a scoped full-import actor to its active org membership', async () => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await expect(
        authorizeAttendanceLegacyPlanFullImportFromJobV1(trx(client), {
          orgId: ORG,
          actorId: SCOPED,
          actorPosture: 'attendance_admin',
          tokenSubjectUserId: SCOPED,
          sourceRef: 'attendance-import',
        }),
      ).resolves.toBe(true)
      await expect(
        authorizeAttendanceLegacyPlanFullImportFromJobV1(trx(client), {
          orgId: OTHER_ORG,
          actorId: SCOPED,
          actorPosture: 'attendance_admin',
          tokenSubjectUserId: SCOPED,
          sourceRef: 'attendance-import',
        }),
      ).resolves.toBe(false)
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })
})
