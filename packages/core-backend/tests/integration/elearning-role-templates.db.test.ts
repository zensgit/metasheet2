import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterAll, describe, expect, it } from 'vitest'
import { CompiledQuery, Kysely, PostgresDialect, sql, type Transaction } from 'kysely'
import { Pool, type PoolClient } from 'pg'

import {
  ELEARNING_ROLE_DOWN_ASSIGNED,
  ELEARNING_ROLE_IDS,
  ELEARNING_ROLE_PERMISSION_CODES,
  ELEARNING_ROLE_TEMPLATES,
  down,
  up,
} from '../../src/db/migrations/zzzz20260826140000_add_elearning_role_templates'
import {
  STOCK_PREP_ROLE_TEMPLATES,
  STOCK_PREP_ROLE_TEMPLATE_DOWN_ASSIGNED,
  STOCK_PREP_ROLE_TEMPLATE_DOWN_GRANTED,
  STOCK_PREP_ROLE_TEMPLATE_IDS,
  down as stockPrepTemplatesDown,
  up as stockPrepTemplatesUp,
} from '../../src/db/migrations/zzzz20261010124500_seed_stock_prep_role_templates'

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

/*
 * S5a — the four built-in 备料 role templates (ADR adr-stock-prep-project-sheets-20261008 §11.2 /
 * §11.3, register R-39) and the legacy floor-role move script, against REAL PostgreSQL. Appended to
 * this file because it is the role-template migration's real-DB home and is already wired into the
 * required `test (20.x)` job (plugin-tests.yml, step "Run elearning V0.1 content/assessment schema
 * gate"). Every scenario runs inside ONE transaction that is rolled back, so the shared database is
 * left exactly as the migration chain made it.
 */
const S5A_MIGRATION_NAME = 'zzzz20261010124500_seed_stock_prep_role_templates'
const S5A_LEDGER = 'stock_prep_role_template_seeds'
const S5A_GRANT_TABLES = ['spreadsheet_permissions', 'meta_view_permissions', 'field_permissions', 'record_permissions', 'meta_history_audit_grants']
const S5A_EXPECTED = [
  { id: 'stock-prep_admin', name: '备料主管理员', codes: ['stock-prep:admin'] },
  { id: 'stock-prep_developer', name: '开发成员', codes: ['stock-prep:read'] },
  { id: 'stock-prep_frontline', name: '一线填写', codes: ['stock-prep:operate', 'stock-prep:read'] },
  { id: 'stock-prep_puller', name: '数据管理员（拉取人员）', codes: ['stock-prep:operate', 'stock-prep:pull', 'stock-prep:read'] },
]
const S5A_SCRIPT_PATH = path.resolve(__dirname, '../../../../scripts/ops/stock-preparation-migrate-legacy-operator-role.mjs')

type S5aScript = {
  run: (options: { client: { query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> }; apply?: boolean; deleteEmptyOldRole?: boolean; manageTransaction?: boolean }) => Promise<{ exitCode: number; membersMoved: number; sheetGrantsMoved: number; oldRoleDeleted: boolean; refusals: string[] }>
}

async function s5aRoleRows(trx: Transaction<unknown>, ids: readonly string[]) {
  const rows = await sql<{ id: string; name: string }>`
    SELECT id, name FROM roles WHERE id IN (${sql.join(ids.map((id) => sql`${id}`))}) ORDER BY id
  `.execute(trx)
  return rows.rows
}

async function s5aCodes(trx: Transaction<unknown>, roleId: string) {
  const rows = await sql<{ permission_code: string }>`
    SELECT permission_code FROM role_permissions WHERE role_id = ${roleId} ORDER BY permission_code
  `.execute(trx)
  return rows.rows.map((row) => row.permission_code)
}

/** The whole role, byte for byte: its roles row, its role_permissions rows and its user_roles rows. */
async function s5aRoleFingerprint(trx: Transaction<unknown>, roleId: string) {
  const role = await sql<{ row: string }>`SELECT row_to_json(r)::text AS row FROM roles r WHERE r.id = ${roleId}`.execute(trx)
  const codes = await sql<{ row: string }>`
    SELECT row_to_json(rp)::text AS row FROM role_permissions rp WHERE rp.role_id = ${roleId} ORDER BY rp.permission_code
  `.execute(trx)
  const members = await sql<{ row: string }>`
    SELECT row_to_json(ur)::text AS row FROM user_roles ur WHERE ur.role_id = ${roleId} ORDER BY ur.user_id
  `.execute(trx)
  return JSON.stringify([role.rows, codes.rows, members.rows])
}

async function s5aTableExists(trx: Transaction<unknown>, table: string) {
  const result = await sql<{ present: boolean }>`SELECT to_regclass(${table}::text) IS NOT NULL AS present`.execute(trx)
  return result.rows[0]?.present === true
}

/** Puts the four template ids back to "never seeded" inside the transaction (rolled back later). */
async function s5aResetTemplates(trx: Transaction<unknown>) {
  const idList = sql.join(STOCK_PREP_ROLE_TEMPLATE_IDS.map((id) => sql`${id}`))
  for (const table of S5A_GRANT_TABLES) {
    if (!(await s5aTableExists(trx, table))) continue
    await sql`DELETE FROM ${sql.table(table)} WHERE subject_type = 'role' AND subject_id IN (${idList})`.execute(trx)
  }
  await sql`DELETE FROM user_roles WHERE role_id IN (${idList})`.execute(trx)
  await sql`DELETE FROM role_permissions WHERE role_id IN (${idList})`.execute(trx)
  await sql`DELETE FROM roles WHERE id IN (${idList})`.execute(trx)
  await sql`DROP TABLE IF EXISTS stock_prep_role_template_seeds`.execute(trx)
}

async function s5aLedger(trx: Transaction<unknown>) {
  if (!(await s5aTableExists(trx, S5A_LEDGER))) return null
  const rows = await sql<{ role_id: string }>`SELECT role_id FROM stock_prep_role_template_seeds ORDER BY role_id`.execute(trx)
  return rows.rows.map((row) => row.role_id)
}

describe('S5a stock-prep role templates migration (real PostgreSQL)', () => {
  it('ran in this database: the four templates exist with exactly their codes and no member', async () => {
    const ledger = await sql<{ name: string }>`
      SELECT name FROM kysely_migration WHERE name = ${S5A_MIGRATION_NAME}
    `.execute(db)
    expect(ledger.rows).toEqual([{ name: S5A_MIGRATION_NAME }])

    const roles = await sql<{ id: string; name: string }>`
      SELECT id, name FROM roles
       WHERE id IN (${sql.join(STOCK_PREP_ROLE_TEMPLATE_IDS.map((id) => sql`${id}`))})
       ORDER BY id
    `.execute(db)
    expect(roles.rows).toEqual(S5A_EXPECTED.map(({ id, name }) => ({ id, name })))
    const mappings = await sql<{ role_id: string; permission_code: string }>`
      SELECT role_id, permission_code FROM role_permissions
       WHERE role_id IN (${sql.join(STOCK_PREP_ROLE_TEMPLATE_IDS.map((id) => sql`${id}`))})
       ORDER BY role_id, permission_code
    `.execute(db)
    expect(mappings.rows).toEqual(S5A_EXPECTED.flatMap(({ id, codes }) => codes.map((code) => ({ role_id: id, permission_code: code }))))
    expect(STOCK_PREP_ROLE_TEMPLATES).toHaveLength(4)
  })

  it('fresh seed, adoption of a hand-made stock-prep_puller, display-name clash, and down() refusals — rolled back', async () => {
    const rollback = new Error('rollback S5a role template test')
    const clashRole = `s5a-clash-${randomUUID()}`
    const pullerMembers = [`s5a-puller-${randomUUID()}`, `s5a-puller-${randomUUID()}`]
    const floorUser = `s5a-floor-${randomUUID()}`
    try {
      await db.transaction().execute(async (trx) => {
        await s5aResetTemplates(trx)

        // fresh
        await stockPrepTemplatesUp(trx)
        expect(await s5aRoleRows(trx, STOCK_PREP_ROLE_TEMPLATE_IDS)).toEqual(S5A_EXPECTED.map(({ id, name }) => ({ id, name })))
        for (const expected of S5A_EXPECTED) expect(await s5aCodes(trx, expected.id)).toEqual(expected.codes)
        const members = await sql<{ count: string }>`
          SELECT count(*)::text AS count FROM user_roles
           WHERE role_id IN (${sql.join(STOCK_PREP_ROLE_TEMPLATE_IDS.map((id) => sql`${id}`))})
        `.execute(trx)
        expect(members.rows[0]?.count).toBe('0')
        expect(await s5aLedger(trx)).toEqual([...STOCK_PREP_ROLE_TEMPLATE_IDS].sort())

        // down with nothing assigned removes all four and the ledger
        await stockPrepTemplatesDown(trx)
        expect(await s5aRoleRows(trx, STOCK_PREP_ROLE_TEMPLATE_IDS)).toEqual([])
        expect(await s5aLedger(trx)).toBeNull()

        // R63: the operator created stock-prep_puller by hand (own name, own codes, members);
        // another site role already carries a template display name.
        await sql`INSERT INTO roles (id, name) VALUES ('stock-prep_puller', 'S5a 现场手建的拉取人员')`.execute(trx)
        await sql`
          INSERT INTO role_permissions (role_id, permission_code)
          VALUES ('stock-prep_puller', 'stock-prep:read'), ('stock-prep_puller', 'stock-prep:pull')
        `.execute(trx)
        for (const member of pullerMembers) {
          await sql`INSERT INTO user_roles (user_id, role_id) VALUES (${member}, 'stock-prep_puller')`.execute(trx)
        }
        await sql`INSERT INTO roles (id, name) VALUES (${clashRole}, '开发成员')`.execute(trx)
        const pullerBefore = await s5aRoleFingerprint(trx, 'stock-prep_puller')
        const clashBefore = await s5aRoleFingerprint(trx, clashRole)

        await stockPrepTemplatesUp(trx)
        expect(await s5aRoleFingerprint(trx, 'stock-prep_puller')).toBe(pullerBefore)
        expect(await s5aRoleFingerprint(trx, clashRole)).toBe(clashBefore)
        expect(await s5aRoleRows(trx, ['stock-prep_developer'])).toEqual([{ id: 'stock-prep_developer', name: '开发成员（内置）' }])
        expect(await s5aCodes(trx, 'stock-prep_developer')).toEqual(['stock-prep:read'])
        expect(await s5aLedger(trx)).toEqual(['stock-prep_admin', 'stock-prep_developer', 'stock-prep_frontline'])

        // down refuses while a role it CREATED has a member …
        await sql`INSERT INTO user_roles (user_id, role_id) VALUES (${floorUser}, 'stock-prep_frontline')`.execute(trx)
        await expect(stockPrepTemplatesDown(trx)).rejects.toThrow(STOCK_PREP_ROLE_TEMPLATE_DOWN_ASSIGNED)
        await sql`DELETE FROM user_roles WHERE user_id = ${floorUser}`.execute(trx)
        // … or is the subject of a grant row …
        await sql`
          INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only)
          VALUES (${`s5a-sheet-${randomUUID()}`}, 'fld_s5a', 'role', 'stock-prep_frontline', true, true)
        `.execute(trx)
        await expect(stockPrepTemplatesDown(trx)).rejects.toThrow(STOCK_PREP_ROLE_TEMPLATE_DOWN_GRANTED)
        await sql`DELETE FROM field_permissions WHERE field_id = 'fld_s5a'`.execute(trx)
        expect(await s5aLedger(trx)).toEqual(['stock-prep_admin', 'stock-prep_developer', 'stock-prep_frontline'])

        // … but an ADOPTED role's members never block it, and it is never deleted.
        await stockPrepTemplatesDown(trx)
        expect(await s5aRoleRows(trx, STOCK_PREP_ROLE_TEMPLATE_IDS)).toEqual([{ id: 'stock-prep_puller', name: 'S5a 现场手建的拉取人员' }])
        expect(await s5aRoleFingerprint(trx, 'stock-prep_puller')).toBe(pullerBefore)
        expect(await s5aRoleFingerprint(trx, clashRole)).toBe(clashBefore)
        expect(await s5aLedger(trx)).toBeNull()

        throw rollback
      })
    } catch (error) {
      if (error !== rollback) throw error
    }
  })

  it('legacy stock-prep-operator → stock-prep_frontline move script: dry run, apply, rerun, delete — rolled back', async () => {
    const script = (await import(pathToFileURL(S5A_SCRIPT_PATH).href)) as S5aScript
    const rollback = new Error('rollback S5a move-script test')
    const suffix = randomUUID().replace(/-/g, '').slice(0, 12)
    const baseId = `base_s5a_${suffix}`
    const legacySheet = `sheet_s5a_legacy_${suffix}`
    const projectSheet = `sheet_s5a_project_${suffix}`
    const userA = `s5a-user-a-${suffix}`
    const userB = `s5a-user-b-${suffix}`
    const userZ = `s5a-user-z-${suffix}`
    try {
      await db.transaction().execute(async (trx) => {
        const client = {
          query: async (text: string, params: unknown[] = []) => {
            const result = await trx.executeQuery(CompiledQuery.raw(text, params))
            return { rows: result.rows as Array<Record<string, unknown>> }
          },
        }
        await s5aResetTemplates(trx)
        await sql`DELETE FROM user_roles WHERE role_id = 'stock-prep-operator'`.execute(trx)
        await sql`DELETE FROM spreadsheet_permissions WHERE subject_type = 'role' AND subject_id = 'stock-prep-operator'`.execute(trx)
        await sql`DELETE FROM role_permissions WHERE role_id = 'stock-prep-operator'`.execute(trx)
        await sql`DELETE FROM roles WHERE id = 'stock-prep-operator'`.execute(trx)

        // before the S5a migration: no stock-prep_frontline → refused, nothing written
        await sql`INSERT INTO roles (id, name) VALUES ('stock-prep-operator', 'S5a legacy floor')`.execute(trx)
        expect((await script.run({ client, apply: true, manageTransaction: false })).exitCode).toBe(2)

        await stockPrepTemplatesUp(trx)
        await sql`
          INSERT INTO role_permissions (role_id, permission_code)
          VALUES ('stock-prep-operator', 'stock-prep:read'), ('stock-prep-operator', 'stock-prep:operate')
        `.execute(trx)
        await sql`INSERT INTO user_roles (user_id, role_id) VALUES (${userA}, 'stock-prep-operator'), (${userB}, 'stock-prep-operator'), (${userB}, 'stock-prep_frontline')`.execute(trx)
        await sql`INSERT INTO meta_bases (id, name, owner_id) VALUES (${baseId}, 'S5a base', ${userA})`.execute(trx)
        await sql`INSERT INTO meta_sheets (id, base_id, name) VALUES (${legacySheet}, ${baseId}, 'S5a legacy'), (${projectSheet}, ${baseId}, 'S5a project')`.execute(trx)
        await sql`
          INSERT INTO spreadsheet_permissions (sheet_id, user_id, subject_type, subject_id, perm_code)
          VALUES
            (${legacySheet}, NULL, 'role', 'stock-prep-operator', 'spreadsheet:write'),
            (${legacySheet}, ${userZ}, 'user', ${userZ}, 'spreadsheet:write'),
            (${legacySheet}, NULL, 'member-group', 'stock-prep-operator', 'spreadsheet:read'),
            (${projectSheet}, NULL, 'role', 'stock-prep_puller', 'spreadsheet:write')
        `.execute(trx)
        const grantRows = async () => (await sql<{ row: string }>`
          SELECT row_to_json(p)::text AS row FROM spreadsheet_permissions p
           WHERE p.sheet_id IN (${legacySheet}, ${projectSheet})
           ORDER BY p.sheet_id, p.subject_type, p.subject_id, p.perm_code
        `.execute(trx)).rows.map((r) => JSON.parse(r.row) as Record<string, unknown>)
        const memberRows = async (roleId: string) => (await sql<{ user_id: string }>`
          SELECT user_id FROM user_roles WHERE role_id = ${roleId} ORDER BY user_id
        `.execute(trx)).rows.map((r) => r.user_id)
        const grantsBefore = await grantRows()
        const legacyGrantBefore = grantsBefore.find((g) => g.subject_type === 'role' && g.subject_id === 'stock-prep-operator')
        const pullerBefore = await s5aRoleFingerprint(trx, 'stock-prep_puller')

        // dry run: nothing changes
        const dry = await script.run({ client, apply: false, manageTransaction: false })
        expect(dry.exitCode).toBe(0)
        expect(await grantRows()).toEqual(grantsBefore)
        expect(await memberRows('stock-prep-operator')).toEqual([userA, userB].sort())

        // apply: memberships and the ROLE-subject grant move; user / member-group / other-role rows do not
        const applied = await script.run({ client, apply: true, manageTransaction: false })
        expect(applied).toMatchObject({ exitCode: 0, membersMoved: 2, sheetGrantsMoved: 1, oldRoleDeleted: false })
        expect(await memberRows('stock-prep-operator')).toEqual([])
        expect(await memberRows('stock-prep_frontline')).toEqual([userA, userB].sort())
        const grantsAfter = await grantRows()
        expect(grantsAfter.filter((g) => g.subject_type === 'role' && g.subject_id === 'stock-prep-operator')).toEqual([])
        expect(grantsAfter.find((g) => g.subject_type === 'role' && g.subject_id === 'stock-prep_frontline'))
          .toEqual({ ...legacyGrantBefore, subject_id: 'stock-prep_frontline' })
        const notMoved = (g: Record<string, unknown>) => !(g.subject_type === 'role' && (g.subject_id === 'stock-prep-operator' || g.subject_id === 'stock-prep_frontline'))
        expect(grantsAfter.filter(notMoved)).toEqual(grantsBefore.filter(notMoved))
        expect(await s5aRoleFingerprint(trx, 'stock-prep_puller')).toBe(pullerBefore)
        expect(await s5aCodes(trx, 'stock-prep-operator')).toEqual(['stock-prep:operate', 'stock-prep:read'])

        // rerun: a no-op
        const again = await script.run({ client, apply: true, manageTransaction: false })
        expect(again).toMatchObject({ exitCode: 0, membersMoved: 0, sheetGrantsMoved: 0, oldRoleDeleted: false })
        expect(await grantRows()).toEqual(grantsAfter)

        // delete the emptied legacy role (and only it)
        const deleted = await script.run({ client, apply: true, deleteEmptyOldRole: true, manageTransaction: false })
        expect(deleted).toMatchObject({ exitCode: 0, oldRoleDeleted: true })
        expect(await s5aRoleRows(trx, ['stock-prep-operator'])).toEqual([])
        expect(await s5aCodes(trx, 'stock-prep-operator')).toEqual([])
        expect(await s5aCodes(trx, 'stock-prep_frontline')).toEqual(['stock-prep:operate', 'stock-prep:read'])

        throw rollback
      })
    } catch (error) {
      if (error !== rollback) throw error
    }
  })
})
