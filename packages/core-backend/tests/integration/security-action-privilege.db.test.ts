/**
 * Privilege classification for security actions against real Postgres: the one-statement grant read
 * matches the live schema, every grant source classifies as high on its own, the second subject's
 * rows never reach the first subject, the classifier sees at least every code the authorization
 * aggregator sees, the permission cache is not consulted, and every read failure refuses.
 *
 * Real PG transactions only; no provider or network calls. Every case except the cache case runs
 * inside one transaction that is rolled back, so no row outlives it.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { Pool as PgPool } from 'pg'
import type { PoolClient } from 'pg'
import {
  assessSecurityActionPrivilege,
  classifyPrivilege,
  collectPrivilegeCodes,
  computePrivilegeWitness,
  HIGH_PRIVILEGE_REASONS,
  PRIVILEGE_GRANT_SOURCE_TABLES,
  PrivilegeInputsUnavailableError,
  readPrivilegeInputs,
} from '../../src/auth/security-action-privilege'
import type { HighPrivilegeReason, PrivilegeInputs } from '../../src/auth/security-action-privilege'
import type { Queryable } from '../../src/multitable/automation-durable-dispatcher'
import { isAdminLevelPermissionCode } from '../../src/rbac/role-assignment'
import { invalidateUserPerms, isAdmin, listUserPermissions } from '../../src/rbac/service'

const suite = process.env.DATABASE_URL ? describe : describe.skip
if (process.env.EXPECT_DB === '1')
  it('requires a real DB', () => expect(process.env.DATABASE_URL).toBeTruthy())

let pool: PgPool | null = null
function getPool(): PgPool {
  pool ??= new PgPool({ connectionString: process.env.DATABASE_URL, max: 2 })
  return pool
}
afterAll(async () => {
  await pool?.end()
})

type Runner = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>

function executorOf(client: PoolClient): Queryable {
  return { query: async (sql, params) => client.query(sql, params) }
}

function runnerOf(client: PoolClient): Runner {
  return async (sql, params) => client.query(sql, params)
}

async function withRollback<T>(fn: (client: PoolClient) => Promise<T>, isolation = 'READ COMMITTED'): Promise<T> {
  const client = await getPool().connect()
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${isolation}`)
    await client.query("SET LOCAL lock_timeout = '5s'")
    return await fn(client)
  } finally {
    try {
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  }
}

type UserSeed = { isAdmin?: boolean; role?: string; legacy?: unknown }

async function seedUser(client: PoolClient, seed: UserSeed = {}): Promise<string> {
  const id = 'p04a-' + randomUUID()
  await client.query(
    `INSERT INTO users(id,username,name,password_hash,is_active,is_admin,role,permissions,activation_status,local_password_set)
     VALUES ($1,$1,$1,'synthetic-unused',true,$2,$3,$4::jsonb,'activated',false)`,
    [id, seed.isAdmin === true, seed.role ?? 'user', JSON.stringify(seed.legacy ?? [])],
  )
  return id
}

async function ensurePermission(client: PoolClient, code: string): Promise<void> {
  await client.query('INSERT INTO permissions(code,name) VALUES($1,$1) ON CONFLICT DO NOTHING', [code])
}

async function grantRole(client: PoolClient, userId: string, roleId: string, codes: readonly string[] = []): Promise<void> {
  await client.query('INSERT INTO roles(id,name) VALUES($1,$1) ON CONFLICT DO NOTHING', [roleId])
  await client.query('INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)', [userId, roleId])
  for (const code of codes) {
    await ensurePermission(client, code)
    await client.query('INSERT INTO role_permissions(role_id,permission_code) VALUES($1,$2) ON CONFLICT DO NOTHING', [roleId, code])
  }
}

async function grantDirect(client: PoolClient, userId: string, code: string): Promise<void> {
  await ensurePermission(client, code)
  await client.query('INSERT INTO user_permissions(user_id,permission_code) VALUES($1,$2)', [userId, code])
}

async function admit(client: PoolClient, userId: string, namespace: string, enabled: boolean): Promise<void> {
  await client.query('INSERT INTO user_namespace_admissions(user_id,namespace,enabled) VALUES($1,$2,$3)', [userId, namespace, enabled])
}

async function seedDirectory(client: PoolClient, org: string): Promise<{ integrationId: string; departmentIds: [string, string] }> {
  const tag = 'p04a-' + randomUUID()
  const integrationId = (await client.query<{ id: string }>(
    `INSERT INTO directory_integrations (org_id, provider, name, status, corp_id, config)
     VALUES ($1, 'dingtalk', $2, 'active', $3, '{}'::jsonb) RETURNING id`,
    [org, tag, 'corp-' + tag],
  )).rows[0].id
  const departmentIds: string[] = []
  for (const suffix of ['a', 'b']) {
    departmentIds.push((await client.query<{ id: string }>(
      `INSERT INTO directory_departments (integration_id, provider, external_department_id, name, is_active, raw)
       VALUES ($1, 'dingtalk', $2, $2, true, '{}'::jsonb) RETURNING id`,
      [integrationId, `${tag}-${suffix}`],
    )).rows[0].id)
  }
  return { integrationId, departmentIds: [departmentIds[0], departmentIds[1]] }
}

async function departmentScope(client: PoolClient, userId: string, namespace: string, departmentId: string): Promise<void> {
  await client.query(
    'INSERT INTO delegated_role_admin_scopes (admin_user_id, namespace, directory_department_id, created_by) VALUES ($1, $2, $3, $1)',
    [userId, namespace, departmentId],
  )
}

async function memberGroup(client: PoolClient): Promise<string> {
  return (await client.query<{ id: string }>(
    'INSERT INTO platform_member_groups (name) VALUES ($1) RETURNING id',
    ['p04a-group-' + randomUUID()],
  )).rows[0].id
}

async function memberGroupScope(client: PoolClient, userId: string, namespace: string, groupId: string): Promise<void> {
  await client.query(
    'INSERT INTO delegated_role_admin_member_groups (admin_user_id, namespace, group_id, created_by) VALUES ($1, $2, $3, $1)',
    [userId, namespace, groupId],
  )
}

/** A second subject holding every grant source, so a subject filter that leaks shows up on the first subject. */
async function seedSecondSubjectWithEverySource(client: PoolClient): Promise<string> {
  const other = await seedUser(client, { isAdmin: true, role: 'admin', legacy: ['*:*'] })
  await grantRole(client, other, 'admin')
  await grantRole(client, other, 'p04a-x_admin', ['users:write'])
  await grantDirect(client, other, '*:*')
  await admit(client, other, 'attendance', true)
  const directory = await seedDirectory(client, 'p04a-org-' + other)
  await departmentScope(client, other, 'attendance', directory.departmentIds[0])
  await memberGroupScope(client, other, 'attendance', await memberGroup(client))
  return other
}

async function expectUnavailable(promise: Promise<unknown>, reason: PrivilegeInputsUnavailableError['reason']): Promise<void> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(PrivilegeInputsUnavailableError)
    expect(error).toMatchObject({ reason, status: 503, code: 'SECURITY_ACTION_UNAVAILABLE' })
    return
  }
  throw new Error(`expected ${reason}`)
}

/** The classifier sees at least every code the authorization aggregator sees on the same transaction. */
async function expectSupersetOfAggregator(client: PoolClient, userId: string, inputs: PrivilegeInputs): Promise<void> {
  const run = runnerOf(client)
  const codes = collectPrivilegeCodes(inputs)
  const classification = classifyPrivilege(inputs)
  const effective = await listUserPermissions(userId, run)
  for (const code of effective) expect(codes).toContain(code.trim())
  if (await isAdmin(userId, run as never)) expect(classification.reasons).toContain('platform_admin_role')
  if (effective.some((code) => isAdminLevelPermissionCode(code))) expect(classification.privilegeClass).toBe('high')
}

suite('security action privilege classification (real PostgreSQL)', () => {
  it('reads a standard user from the live schema, echoes the inserted rows and ignores the second subject', async () => {
    await withRollback(async (client) => {
      const user = await seedUser(client, { legacy: ['spreadsheet:read'] })
      const role = 'p04a-role-' + user
      await grantRole(client, user, role, ['approvals:read'])
      await grantDirect(client, user, 'tasks:write')
      await admit(client, user, 'attendance', true)
      const other = await seedSecondSubjectWithEverySource(client)

      const inputs = await readPrivilegeInputs(executorOf(client), user)
      expect(inputs).toMatchObject({
        userId: user,
        isAdmin: false,
        role: 'user',
        roleIds: [role],
        directCodes: ['tasks:write'],
        rolePermissions: [[role, 'approvals:read']],
        legacyPermissions: ['spreadsheet:read'],
        admissions: [['attendance', true]],
        delegatedDepartmentScopes: [],
        delegatedMemberGroupScopes: [],
      })
      expect(classifyPrivilege(inputs)).toEqual({ privilegeClass: 'standard', reasons: [] })
      const assessment = await assessSecurityActionPrivilege(executorOf(client), user)
      expect(assessment.privilegeClass).toBe('standard')
      expect(assessment.witness).toMatch(/^[0-9a-f]{64}$/)
      expect(assessment.witness).toBe(computePrivilegeWitness(inputs))
      await expectSupersetOfAggregator(client, user, inputs)

      const otherAssessment = await assessSecurityActionPrivilege(executorOf(client), other)
      expect(otherAssessment.reasons).toEqual([...HIGH_PRIVILEGE_REASONS])
    })
  })

  const singleSource: Array<[HighPrivilegeReason, string, (client: PoolClient, user: string) => Promise<void>, UserSeed?]> = [
    ['platform_admin_flag', 'the is_admin column', async () => undefined, { isAdmin: true }],
    ['platform_admin_role_column', 'the role column', async () => undefined, { role: 'admin' }],
    ['platform_admin_role', 'the admin role', async (client, user) => grantRole(client, user, 'admin')],
    ['delegated_admin_role', 'a delegated admin role', async (client, user) => grantRole(client, user, 'p04a-attendance_admin')],
    ['delegated_admin_scope', 'a department scope row', async (client, user) => {
      const directory = await seedDirectory(client, 'p04a-org-' + user)
      await departmentScope(client, user, 'attendance', directory.departmentIds[0])
    }],
    ['delegated_admin_scope', 'a member group scope row', async (client, user) => memberGroupScope(client, user, 'attendance', await memberGroup(client))],
    ['admin_level_code', 'a direct wildcard code', async (client, user) => grantDirect(client, user, '*:*')],
    ['admin_level_code', 'a nested legacy wildcard', async () => undefined, { legacy: [['*:*']] }],
    ['admin_level_code', 'an inherited admin code without an enabled admission', async (client, user) => {
      await grantRole(client, user, 'p04a-operator-' + user, ['attendance:admin'])
      await admit(client, user, 'attendance', false)
    }],
    ['sensitive_authority_code', 'an inherited users:write code', async (client, user) => grantRole(client, user, 'p04a-operator-' + user, ['users:write'])],
    ['sensitive_authority_code', 'a direct roles:write code', async (client, user) => grantDirect(client, user, 'roles:write')],
    ['sensitive_authority_code', 'a legacy permissions:write code', async () => undefined, { legacy: ['permissions:write'] }],
  ]

  it.each(singleSource)('classifies a user as high privilege for %s when the only grant is %s', async (reason, _label, grant, seed) => {
    await withRollback(async (client) => {
      const user = await seedUser(client, seed)
      await grant(client, user)
      const other = await seedSecondSubjectWithEverySource(client)
      const inputs = await readPrivilegeInputs(executorOf(client), user)
      expect(classifyPrivilege(inputs)).toEqual({ privilegeClass: 'high', reasons: [reason] })
      expect((await assessSecurityActionPrivilege(executorOf(client), user)).reasons).toEqual([reason])
      await expectSupersetOfAggregator(client, user, inputs)
      expect((await assessSecurityActionPrivilege(executorOf(client), other)).reasons).toEqual([...HIGH_PRIVILEGE_REASONS])
    })
  })

  it('classifies a user as standard whose only scope rows are domain-specific scope rows', async () => {
    await withRollback(async (client) => {
      const user = await seedUser(client)
      const org = 'p04a-org-' + user
      await client.query('INSERT INTO user_orgs(user_id,org_id,is_active) VALUES($1,$2,true)', [user, org])
      const directory = await seedDirectory(client, org)
      await client.query(
        `INSERT INTO elearning_admin_scopes (org_id, user_id, directory_integration_id, directory_provider, directory_department_id, include_children, granted_by)
         VALUES ($1, $2, $3, 'dingtalk', $4, TRUE, $2)`,
        [org, user, directory.integrationId, directory.departmentIds[0]],
      )
      await client.query(
        `INSERT INTO attendance_scheduler_scopes (org_id, subject_type, subject_ref, actions, scope, is_active)
         VALUES ($1, 'user', $2, ARRAY['import','dispatch']::text[], '{}'::jsonb, true)`,
        [org, user],
      )
      const assessment = await assessSecurityActionPrivilege(executorOf(client), user)
      expect(assessment).toMatchObject({ privilegeClass: 'standard', reasons: [] })
    })
  })

  it('classifies from the rows and not from the permission cache', async () => {
    const user = 'p04a-' + randomUUID()
    const role = 'p04a-role-' + user
    const baseCode = `permission:${user}`
    const addedCode = `admin:${user}`
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO users(id,username,name,password_hash,is_active,is_admin,role,permissions,activation_status,local_password_set)
         VALUES ($1,$1,$1,'synthetic-unused',true,false,'user','[]'::jsonb,'activated',false)`,
        [user],
      )
      await grantRole(client, user, role, [baseCode])
      await client.query('COMMIT')

      invalidateUserPerms(user)
      const cached = await listUserPermissions(user)
      expect(cached).toContain(baseCode)

      await client.query('BEGIN')
      await ensurePermission(client, addedCode)
      await client.query('INSERT INTO role_permissions(role_id,permission_code) VALUES($1,$2)', [role, addedCode])
      await client.query('COMMIT')

      const stillCached = await listUserPermissions(user)
      expect(stillCached).toContain(baseCode)
      expect(stillCached).not.toContain(addedCode)

      await withRollback(async (fresh) => {
        expect(await listUserPermissions(user, runnerOf(fresh))).toContain(addedCode)
        const assessment = await assessSecurityActionPrivilege(executorOf(fresh), user)
        expect(assessment.privilegeClass).toBe('high')
        expect(assessment.reasons).toEqual(['admin_level_code'])
      })
    } finally {
      try {
        await client.query('ROLLBACK').catch(() => undefined)
        await client.query('DELETE FROM role_permissions WHERE role_id = $1', [role])
        await client.query('DELETE FROM user_roles WHERE user_id = $1', [user])
        await client.query('DELETE FROM roles WHERE id = $1', [role])
        await client.query('DELETE FROM permissions WHERE code = ANY($1::text[])', [[baseCode, addedCode]])
        await client.query('DELETE FROM users WHERE id = $1', [user])
        invalidateUserPerms(user)
      } finally {
        client.release()
      }
    }
  })

  describe('refuses when a grant source cannot be read', () => {
    const hidden = [
      ...PRIVILEGE_GRANT_SOURCE_TABLES.map((table) => [`table ${table}`, `ALTER TABLE ${table} RENAME TO ${table}__p04a_hidden`] as const),
      ['column users.is_admin', 'ALTER TABLE users RENAME COLUMN is_admin TO is_admin__p04a_hidden'] as const,
    ]
    it.each(hidden)('refuses with read_failed when %s is unavailable, even with optional schema degradation enabled', async (_label, ddl) => {
      const previous = process.env.RBAC_OPTIONAL
      process.env.RBAC_OPTIONAL = '1'
      try {
        await withRollback(async (client) => {
          const user = await seedUser(client, { isAdmin: true })
          await client.query(ddl)
          await expectUnavailable(readPrivilegeInputs(executorOf(client), user), 'read_failed')
        })
      } finally {
        if (previous === undefined) delete process.env.RBAC_OPTIONAL
        else process.env.RBAC_OPTIONAL = previous
      }
    })
  })

  describe('requires an ongoing read committed transaction', () => {
    it.each(['REPEATABLE READ', 'SERIALIZABLE'])('refuses with transaction_required under %s', async (isolation) => {
      await withRollback(async (client) => {
        const user = await seedUser(client, { isAdmin: true })
        await expectUnavailable(readPrivilegeInputs(executorOf(client), user), 'transaction_required')
      }, isolation)
    })

    it('refuses with transaction_required on an autocommit client', async () => {
      const client = await getPool().connect()
      try {
        await expectUnavailable(readPrivilegeInputs(executorOf(client), 'p04a-' + randomUUID()), 'transaction_required')
      } finally {
        client.release()
      }
    })

    it('refuses with transaction_required after a bare BEGIN on a repeatable-read-default connection', async () => {
      const base = process.env.DATABASE_URL as string
      const sep = base.includes('?') ? '&' : '?'
      const rrPool = new PgPool({
        connectionString: `${base}${sep}options=${encodeURIComponent('-c default_transaction_isolation=repeatable\\ read')}`,
        max: 1,
      })
      const client = await rrPool.connect()
      try {
        await client.query('BEGIN')
        await expectUnavailable(readPrivilegeInputs(executorOf(client), 'p04a-' + randomUUID()), 'transaction_required')
        await client.query('ROLLBACK')
      } finally {
        client.release()
        await rrPool.end()
      }
    })
  })

  it('changes the witness on every grant input change and only on the subject\'s own rows', async () => {
    await withRollback(async (client) => {
      const user = await seedUser(client, { legacy: ['a:read', 'b:read'] })
      const roleA = 'p04a-role-a-' + user
      const roleB = 'p04a-role-b-' + user
      await grantRole(client, user, roleA, ['approvals:read'])
      await grantRole(client, user, roleB)
      await grantDirect(client, user, 'tasks:write')
      await admit(client, user, 'attendance', true)
      const directory = await seedDirectory(client, 'p04a-org-' + user)
      await departmentScope(client, user, 'attendance', directory.departmentIds[0])
      const groupA = await memberGroup(client)
      const groupB = await memberGroup(client)
      await memberGroupScope(client, user, 'attendance', groupA)
      const other = await seedSecondSubjectWithEverySource(client)

      const executor = executorOf(client)
      let previous = computePrivilegeWitness(await readPrivilegeInputs(executor, user))
      expect(computePrivilegeWitness(await readPrivilegeInputs(executor, user))).toBe(previous)

      await grantRole(client, other, 'p04a-role-only-other-' + other, ['tasks:read'])
      await grantDirect(client, other, 'tasks:read')
      await client.query('UPDATE users SET permissions = $2::jsonb WHERE id = $1', [other, JSON.stringify(['*:*', 'x'])])
      expect(computePrivilegeWitness(await readPrivilegeInputs(executor, user))).toBe(previous)

      const changes: Array<[string, () => Promise<unknown>]> = [
        ['a role is added', () => grantRole(client, user, 'p04a-role-c-' + user)],
        ['a direct code is added', () => grantDirect(client, user, 'tasks:read')],
        ['a code moves between two held roles', async () => {
          await client.query('DELETE FROM role_permissions WHERE role_id = $1 AND permission_code = $2', [roleA, 'approvals:read'])
          await client.query('INSERT INTO role_permissions(role_id,permission_code) VALUES($1,$2)', [roleB, 'approvals:read'])
        }],
        ['the legacy array is reordered', () => client.query('UPDATE users SET permissions = $2::jsonb WHERE id = $1', [user, JSON.stringify(['b:read', 'a:read'])])],
        ['an admission flips', () => client.query('UPDATE user_namespace_admissions SET enabled = false WHERE user_id = $1', [user])],
        ['a department scope is replaced', () => client.query(
          'UPDATE delegated_role_admin_scopes SET directory_department_id = $2 WHERE admin_user_id = $1', [user, directory.departmentIds[1]],
        )],
        ['a member group scope is replaced', () => client.query(
          'UPDATE delegated_role_admin_member_groups SET group_id = $2 WHERE admin_user_id = $1', [user, groupB],
        )],
        ['the is_admin flag flips', () => client.query('UPDATE users SET is_admin = true WHERE id = $1', [user])],
        ['the role column changes', () => client.query("UPDATE users SET role = 'manager' WHERE id = $1", [user])],
      ]
      for (const [label, change] of changes) {
        await change()
        const next = computePrivilegeWitness(await readPrivilegeInputs(executor, user))
        expect(next, label).not.toBe(previous)
        previous = next
      }
    })
  })

  it('refuses with subject_missing for a user that does not exist', async () => {
    await withRollback(async (client) => {
      await expectUnavailable(readPrivilegeInputs(executorOf(client), 'p04a-' + randomUUID()), 'subject_missing')
    })
  })
})
