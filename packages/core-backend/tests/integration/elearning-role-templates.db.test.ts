import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool, type PoolClient } from 'pg'

import {
  ELEARNING_ROLE_DOWN_ASSIGNED,
  ELEARNING_ROLE_IDS,
  ELEARNING_ROLE_PERMISSION_CODES,
  ELEARNING_ROLE_TEMPLATES,
  down,
  up,
} from '../../src/db/migrations/zzzz20260826140000_add_elearning_role_templates'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  throw new Error(
    'e-learning role template gate requires DATABASE_URL; refusing skip-shaped green',
  )
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 4 })
const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
const MIGRATION_NAME = 'zzzz20260826140000_add_elearning_role_templates'

const EXPECTED_ROLE_ROWS = [
  { id: 'plugin_elearning_admin', name: 'E-learning Admin' },
  { id: 'plugin_elearning_operator', name: 'E-learning Operator' },
  { id: 'plugin_elearning_viewer', name: 'E-learning Viewer' },
]

const EXPECTED_MAPPING_ROWS = [
  { role_id: 'plugin_elearning_admin', permission_code: 'elearning:admin' },
  { role_id: 'plugin_elearning_admin', permission_code: 'elearning:grade' },
  { role_id: 'plugin_elearning_admin', permission_code: 'elearning:read' },
  { role_id: 'plugin_elearning_admin', permission_code: 'elearning:stats' },
  { role_id: 'plugin_elearning_admin', permission_code: 'elearning:write' },
  { role_id: 'plugin_elearning_operator', permission_code: 'elearning:grade' },
  { role_id: 'plugin_elearning_operator', permission_code: 'elearning:read' },
  { role_id: 'plugin_elearning_operator', permission_code: 'elearning:stats' },
  { role_id: 'plugin_elearning_operator', permission_code: 'elearning:write' },
  { role_id: 'plugin_elearning_viewer', permission_code: 'elearning:read' },
]

async function waitUntilBlocked(
  observer: PoolClient,
  blockedPid: number,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await observer.query<{ blocked: boolean }>(
      `SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked`,
      [blockedPid],
    )
    if (result.rows[0]?.blocked === true) return
    await observer.query('SELECT pg_sleep(0.01)')
  }
  throw new Error('e-learning role upsert did not block behind the conflicting insert')
}

afterAll(async () => {
  await db.destroy()
})

describe('e-learning role template migration (real PostgreSQL)', () => {
  it('derives the exact role ids and least-privilege permission matrix', () => {
    expect(ELEARNING_ROLE_TEMPLATES).toEqual([
      {
        id: 'plugin_elearning_viewer',
        name: 'E-learning Viewer',
        permissions: ['elearning:read'],
      },
      {
        id: 'plugin_elearning_operator',
        name: 'E-learning Operator',
        permissions: [
          'elearning:read',
          'elearning:write',
          'elearning:grade',
          'elearning:stats',
        ],
      },
      {
        id: 'plugin_elearning_admin',
        name: 'E-learning Admin',
        permissions: [
          'elearning:read',
          'elearning:write',
          'elearning:grade',
          'elearning:stats',
          'elearning:admin',
        ],
      },
    ])
    expect(ELEARNING_ROLE_IDS).toEqual([
      'plugin_elearning_viewer',
      'plugin_elearning_operator',
      'plugin_elearning_admin',
    ])
    expect(ELEARNING_ROLE_PERMISSION_CODES).toEqual([
      'elearning:read',
      'elearning:write',
      'elearning:grade',
      'elearning:stats',
      'elearning:admin',
    ])
    expect(ELEARNING_ROLE_PERMISSION_CODES).not.toContain('plugin-elearning:admin')
  })

  it('converges exact grants, repairs reserved placeholders, and keeps rollback inert', async () => {
    const ledger = await sql<{ name: string }>`
      SELECT name
        FROM kysely_migration
       WHERE name = ${MIGRATION_NAME}
    `.execute(db)
    expect(ledger.rows).toEqual([{ name: MIGRATION_NAME }])

    const migratedRoles = await sql<{ id: string; name: string }>`
      SELECT id, name
        FROM roles
       WHERE id IN (${sql.join(ELEARNING_ROLE_IDS.map((id) => sql`${id}`))})
       ORDER BY id
    `.execute(db)
    expect(migratedRoles.rows).toEqual(EXPECTED_ROLE_ROWS)

    const migratedMappings = await sql<{ role_id: string; permission_code: string }>`
      SELECT role_id, permission_code
        FROM role_permissions
       WHERE role_id IN (${sql.join(ELEARNING_ROLE_IDS.map((id) => sql`${id}`))})
       ORDER BY role_id, permission_code
    `.execute(db)
    expect(migratedMappings.rows).toEqual(EXPECTED_MAPPING_ROWS)

    const rollback = new Error('rollback e-learning role template test')
    const sentinelRole = `el-role-sentinel-${randomUUID()}`
    const sentinelPermission = `el-role-sentinel:${randomUUID()}`
    const assignedUser = `el-role-user-${randomUUID()}`

    try {
      await db.transaction().execute(async (trx) => {
        await sql`
          INSERT INTO permissions (code, name, description)
          VALUES (${sentinelPermission}, 'E-learning role sentinel', 'test sentinel')
        `.execute(trx)
        await sql`
          INSERT INTO roles (id, name)
          VALUES (${sentinelRole}, 'E-learning role sentinel')
        `.execute(trx)
        await sql`
          INSERT INTO role_permissions (role_id, permission_code)
          VALUES (${sentinelRole}, ${sentinelPermission})
        `.execute(trx)

        await up(trx)
        await sql`
          UPDATE roles
             SET name = 'Arbitrary Viewer Name'
           WHERE id = 'plugin_elearning_viewer'
        `.execute(trx)
        const grantsBeforeConflict = await sql<{ permission_code: string }>`
          SELECT permission_code
            FROM role_permissions
           WHERE role_id = 'plugin_elearning_viewer'
           ORDER BY permission_code
        `.execute(trx)
        await expect(up(trx)).rejects.toThrow('e-learning role template identifier conflict')
        const grantsAfterConflict = await sql<{ permission_code: string }>`
          SELECT permission_code
            FROM role_permissions
           WHERE role_id = 'plugin_elearning_viewer'
           ORDER BY permission_code
        `.execute(trx)
        expect(grantsAfterConflict.rows).toEqual(grantsBeforeConflict.rows)
        await sql`
          UPDATE roles
             SET name = 'E-learning Viewer'
           WHERE id = 'plugin_elearning_viewer'
        `.execute(trx)

        await sql`
          UPDATE roles
             SET name = id
           WHERE id = 'plugin_elearning_viewer'
        `.execute(trx)
        await up(trx)
        await sql`
          INSERT INTO role_permissions (role_id, permission_code)
          VALUES ('plugin_elearning_operator', ${sentinelPermission})
        `.execute(trx)
        await up(trx)

        const roleRows = await sql<{ id: string; name: string }>`
          SELECT id, name
            FROM roles
           WHERE id IN (${sql.join(ELEARNING_ROLE_IDS.map((id) => sql`${id}`))})
           ORDER BY id
        `.execute(trx)
        expect(roleRows.rows).toEqual(EXPECTED_ROLE_ROWS)

        const mappingRows = await sql<{ role_id: string; permission_code: string }>`
          SELECT role_id, permission_code
            FROM role_permissions
           WHERE role_id IN (${sql.join(ELEARNING_ROLE_IDS.map((id) => sql`${id}`))})
           ORDER BY role_id, permission_code
        `.execute(trx)
        expect(mappingRows.rows).toEqual(EXPECTED_MAPPING_ROWS)
        expect(mappingRows.rows).not.toContainEqual({
          role_id: 'plugin_elearning_operator',
          permission_code: 'elearning:admin',
        })
        expect(mappingRows.rows).not.toContainEqual({
          role_id: 'plugin_elearning_viewer',
          permission_code: 'elearning:write',
        })

        await sql`
          INSERT INTO user_roles (user_id, role_id)
          VALUES (${assignedUser}, 'plugin_elearning_viewer')
        `.execute(trx)
        await expect(down(trx)).rejects.toThrow(ELEARNING_ROLE_DOWN_ASSIGNED)

        const stillPresent = await sql<{ count: string }>`
          SELECT count(*)::text AS count
            FROM roles
           WHERE id IN (${sql.join(ELEARNING_ROLE_IDS.map((id) => sql`${id}`))})
        `.execute(trx)
        expect(stillPresent.rows[0]?.count).toBe('3')

        await sql`
          DELETE FROM user_roles
           WHERE user_id = ${assignedUser}
             AND role_id = 'plugin_elearning_viewer'
        `.execute(trx)
        await down(trx)

        const retainedRoles = await sql<{ count: string }>`
          SELECT count(*)::text AS count
            FROM roles
           WHERE id IN (${sql.join(ELEARNING_ROLE_IDS.map((id) => sql`${id}`))})
        `.execute(trx)
        const retainedMappings = await sql<{ count: string }>`
          SELECT count(*)::text AS count
            FROM role_permissions
           WHERE role_id IN (${sql.join(ELEARNING_ROLE_IDS.map((id) => sql`${id}`))})
        `.execute(trx)
        const canonicalPermissions = await sql<{ count: string }>`
          SELECT count(*)::text AS count
            FROM permissions
           WHERE code IN (
             ${sql.join(ELEARNING_ROLE_PERMISSION_CODES.map((code) => sql`${code}`))}
           )
        `.execute(trx)
        const sentinel = await sql<{ count: string }>`
          SELECT count(*)::text AS count
            FROM role_permissions
           WHERE role_id = ${sentinelRole}
             AND permission_code = ${sentinelPermission}
        `.execute(trx)
        const sentinelRoleRow = await sql<{ id: string; name: string }>`
          SELECT id, name
            FROM roles
           WHERE id = ${sentinelRole}
        `.execute(trx)
        const sentinelPermissionRow = await sql<{ code: string; name: string }>`
          SELECT code, name
            FROM permissions
           WHERE code = ${sentinelPermission}
        `.execute(trx)

        expect(retainedRoles.rows[0]?.count).toBe('3')
        expect(retainedMappings.rows[0]?.count).toBe('10')
        expect(canonicalPermissions.rows[0]?.count).toBe('5')
        expect(sentinel.rows[0]?.count).toBe('1')
        expect(sentinelRoleRow.rows).toEqual([
          { id: sentinelRole, name: 'E-learning role sentinel' },
        ])
        expect(sentinelPermissionRow.rows).toEqual([
          { code: sentinelPermission, name: 'E-learning role sentinel' },
        ])

        throw rollback
      })
    } catch (error) {
      if (error !== rollback) throw error
    }
  })

  it('rejects a concurrently committed arbitrary canonical role name without granting it', async () => {
    const holder = await pool.connect()
    const observer = await pool.connect()
    let holderCommitted = false
    let upAttempt: Promise<void> | undefined
    try {
      await db.transaction().execute(async (trx) => {
        await sql`
          DELETE FROM role_permissions WHERE role_id = 'plugin_elearning_viewer'
        `.execute(trx)
        await sql`
          DELETE FROM roles WHERE id = 'plugin_elearning_viewer'
        `.execute(trx)
      })

      await holder.query('BEGIN')
      await holder.query(
        `INSERT INTO roles (id, name)
         VALUES ('plugin_elearning_viewer', 'Concurrent Arbitrary Viewer')`,
      )

      let publishPid: ((pid: number) => void) | undefined
      const pidReady = new Promise<number>((resolve) => {
        publishPid = resolve
      })
      upAttempt = db.transaction().execute(async (trx) => {
        const pid = await sql<{ pid: number }>`SELECT pg_backend_pid()::int AS pid`.execute(trx)
        const backendPid = pid.rows[0]?.pid
        if (backendPid === undefined) throw new Error('missing role migration backend pid')
        publishPid?.(backendPid)
        await up(trx)
      })

      await waitUntilBlocked(observer, await pidReady)
      await holder.query('COMMIT')
      holderCommitted = true
      await expect(upAttempt).rejects.toThrow('e-learning role template identifier conflict')

      const role = await sql<{ id: string; name: string }>`
        SELECT id, name FROM roles WHERE id = 'plugin_elearning_viewer'
      `.execute(db)
      const grants = await sql<{ permission_code: string }>`
        SELECT permission_code
          FROM role_permissions
         WHERE role_id = 'plugin_elearning_viewer'
      `.execute(db)
      expect(role.rows).toEqual([
        { id: 'plugin_elearning_viewer', name: 'Concurrent Arbitrary Viewer' },
      ])
      expect(grants.rows).toEqual([])
    } finally {
      if (!holderCommitted) {
        try {
          await holder.query('ROLLBACK')
        } catch {
          // Connection is already idle or closing.
        }
      }
      if (upAttempt) await upAttempt.catch(() => undefined)
      holder.release()
      observer.release()
      await db.transaction().execute(async (trx) => {
        await sql`
          DELETE FROM role_permissions WHERE role_id = 'plugin_elearning_viewer'
        `.execute(trx)
        await sql`
          DELETE FROM roles WHERE id = 'plugin_elearning_viewer'
        `.execute(trx)
        await up(trx)
      })
    }
  })
})
