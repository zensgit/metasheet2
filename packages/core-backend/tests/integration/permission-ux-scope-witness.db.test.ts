/**
 * Real PostgreSQL witness for delegated_role_admin_scopes.include_children.
 *
 * The privilege reads change only that boolean. Access generation and every other grant
 * fact stay put, and the witness moves both true -> false and false -> true.
 *
 * The stock-prep read executes the exported STOCK_PREP_MEMBERS_SCOPED_USERS_SQL on a
 * rolled-back parent/child/grandchild/unrelated/member-group fixture. Parameters are
 * the actor id, the namespace stock-prep, and the candidate user ids.
 *
 * The transaction is rolled back. This file does not import a router. Run it with
 * vitest.permission-ux-witness.config.ts so token trust is off before imports.
 * Codex owns the isolated PG16. Do not point this file at a shared database from here.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { Pool as PgPool } from 'pg'
import type { PoolClient } from 'pg'
import {
  assessSecurityActionPrivilege,
  readPrivilegeInputs,
} from '../../src/auth/security-action-privilege'
import type { Queryable } from '../../src/multitable/automation-durable-dispatcher'
import {
  STOCK_PREP_MEMBERS_NAMESPACE,
  STOCK_PREP_MEMBERS_SCOPED_USERS_SQL,
} from '../../src/services/stock-preparation-members'

if (process.env.RBAC_TOKEN_TRUST !== 'false' || process.env.RBAC_BYPASS !== 'false') {
  throw new Error('permission-ux scope witness must load under the trust-off config')
}
if (process.env.EXPECT_DB === '1') {
  if (!process.env.DATABASE_URL) throw new Error('EXPECT_DB=1 requires DATABASE_URL')
}

let pool: PgPool | null = null
function getPool(): PgPool {
  pool ??= new PgPool({ connectionString: process.env.DATABASE_URL, max: 1 })
  return pool
}
afterAll(async () => {
  await pool?.end()
})

function executorOf(client: PoolClient): Queryable {
  return { query: async (sql, params) => client.query(sql, params) }
}

async function withRollback<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
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

type FixedFacts = {
  is_admin: boolean
  role: string
  permissions: string
  access_generation: string
  namespace: string
  department_id: string
  created_by: string | null
  created_at: string
  updated_at: string
  scope_count: number
  role_count: number
  direct_count: number
  admission_count: number
  group_scope_count: number
  challenge_count: number
}

async function fixedFacts(client: PoolClient, userId: string): Promise<FixedFacts> {
  const rows = (await client.query<FixedFacts>(
    `SELECT u.is_admin,
            u.role,
            u.permissions::text AS permissions,
            u.access_generation::text AS access_generation,
            s.namespace,
            s.directory_department_id::text AS department_id,
            s.created_by,
            s.created_at::text AS created_at,
            s.updated_at::text AS updated_at,
            (SELECT count(*)::int FROM delegated_role_admin_scopes WHERE admin_user_id = u.id) AS scope_count,
            (SELECT count(*)::int FROM user_roles WHERE user_id = u.id) AS role_count,
            (SELECT count(*)::int FROM user_permissions WHERE user_id = u.id) AS direct_count,
            (SELECT count(*)::int FROM user_namespace_admissions WHERE user_id = u.id) AS admission_count,
            (SELECT count(*)::int FROM delegated_role_admin_member_groups WHERE admin_user_id = u.id) AS group_scope_count,
            (SELECT count(*)::int FROM security_action_challenges WHERE user_id = u.id) AS challenge_count
       FROM users u
       JOIN delegated_role_admin_scopes s ON s.admin_user_id = u.id
      WHERE u.id = $1`,
    [userId],
  )).rows
  expect(rows).toHaveLength(1)
  return rows[0]
}

describe('include_children privilege witness (real PostgreSQL)', () => {
  it('stores include_children as boolean NOT NULL DEFAULT true on both delegated scope tables', async () => {
    await withRollback(async (client) => {
      const columns = (await client.query<{ table_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
        `SELECT table_name, data_type, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND column_name = 'include_children'
            AND table_name IN ('delegated_role_admin_scopes', 'delegated_role_scope_template_departments')
          ORDER BY table_name`,
      )).rows
      expect(columns.map((column) => column.table_name)).toEqual([
        'delegated_role_admin_scopes',
        'delegated_role_scope_template_departments',
      ])
      for (const column of columns) {
        expect(column.data_type).toBe('boolean')
        expect(column.is_nullable).toBe('NO')
        expect(String(column.column_default)).toMatch(/true/i)
        expect(String(column.column_default)).not.toMatch(/false/i)
      }
    })
  })

  it('changes the witness in both directions when only include_children changes', async () => {
    await withRollback(async (client) => {
      const userId = 'ux-scope-' + randomUUID()
      await client.query(
        `INSERT INTO users(id, username, name, password_hash, is_active, is_admin, role, permissions, activation_status, local_password_set, access_generation)
         VALUES ($1, $1, $1, 'synthetic-unused', true, false, 'user', '[]'::jsonb, 'activated', false, 11)`,
        [userId],
      )
      const tag = 'ux-scope-' + randomUUID()
      const integrationId = (await client.query<{ id: string }>(
        `INSERT INTO directory_integrations (org_id, provider, name, status, corp_id, config)
         VALUES ($1, 'dingtalk', $2, 'active', $3, '{}'::jsonb) RETURNING id`,
        ['ux-scope-org-' + tag, tag, 'corp-' + tag],
      )).rows[0].id
      const departmentId = (await client.query<{ id: string }>(
        `INSERT INTO directory_departments (integration_id, provider, external_department_id, name, is_active, raw)
         VALUES ($1, 'dingtalk', $2, $2, true, '{}'::jsonb) RETURNING id`,
        [integrationId, tag],
      )).rows[0].id
      await client.query(
        `INSERT INTO delegated_role_admin_scopes (admin_user_id, namespace, directory_department_id, created_by)
         VALUES ($1, 'stock-prep', $2, $1)`,
        [userId, departmentId],
      )
      const defaulted = (await client.query<{ include_children: boolean }>(
        'SELECT include_children FROM delegated_role_admin_scopes WHERE admin_user_id = $1',
        [userId],
      )).rows
      expect(defaulted).toEqual([{ include_children: true }])

      const executor = executorOf(client)
      const facts = await fixedFacts(client, userId)
      expect(facts.access_generation).toBe('11')
      expect(facts.scope_count).toBe(1)
      expect(facts.role_count).toBe(0)
      expect(facts.direct_count).toBe(0)
      expect(facts.admission_count).toBe(0)
      expect(facts.group_scope_count).toBe(0)
      expect(facts.challenge_count).toBe(0)

      const readAt = async (includeChildren: boolean) => {
        const inputs = await readPrivilegeInputs(executor, userId)
        const assessment = await assessSecurityActionPrivilege(executor, userId)
        expect(inputs.delegatedDepartmentScopes).toEqual([['stock-prep', departmentId, includeChildren]])
        expect(assessment.privilegeClass).toBe('high')
        expect(assessment.reasons).toEqual(['delegated_admin_scope'])
        expect(assessment.witness).toMatch(/^[0-9a-f]{64}$/)
        expect(await fixedFacts(client, userId)).toEqual(facts)
        return assessment.witness
      }

      const witnessTrue = await readAt(true)
      await client.query(
        `UPDATE delegated_role_admin_scopes
            SET include_children = false
          WHERE admin_user_id = $1
            AND namespace = 'stock-prep'
            AND directory_department_id = $2`,
        [userId, departmentId],
      )
      const witnessFalse = await readAt(false)
      expect(witnessFalse).not.toBe(witnessTrue)
      await client.query(
        `UPDATE delegated_role_admin_scopes
            SET include_children = true
          WHERE admin_user_id = $1
            AND namespace = 'stock-prep'
            AND directory_department_id = $2`,
        [userId, departmentId],
      )
      const witnessTrueAgain = await readAt(true)
      expect(witnessTrueAgain).toBe(witnessTrue)
      expect(witnessTrueAgain).not.toBe(witnessFalse)
    })
  })

  it('executes STOCK_PREP_MEMBERS_SCOPED_USERS_SQL for exact, descendant, union, and member-group scope', async () => {
    expect(STOCK_PREP_MEMBERS_NAMESPACE).toBe('stock-prep')
    await withRollback(async (client) => {
      const tag = randomUUID()
      const actorId = `ux-sql-actor-${tag}`
      const parentUserId = `ux-sql-parent-${tag}`
      const childUserId = `ux-sql-child-${tag}`
      const grandchildUserId = `ux-sql-grandchild-${tag}`
      const unrelatedUserId = `ux-sql-unrelated-${tag}`
      const groupUserId = `ux-sql-group-${tag}`
      const omittedChildUserId = `ux-sql-omitted-${tag}`
      const candidateUserIds = [parentUserId, childUserId, grandchildUserId, unrelatedUserId, groupUserId]
      for (const userId of [actorId, ...candidateUserIds, omittedChildUserId]) {
        await client.query(
          `INSERT INTO users(id, username, name, password_hash, is_active, is_admin, role, permissions, activation_status, local_password_set, access_generation)
           VALUES ($1, $1, $1, 'synthetic-unused', true, false, 'user', '[]'::jsonb, 'activated', false, 11)`,
          [userId],
        )
      }

      const integrationId = (await client.query<{ id: string }>(
        `INSERT INTO directory_integrations (org_id, provider, name, status, corp_id, config)
         VALUES ($1, 'dingtalk', $2, 'active', $3, '{}'::jsonb) RETURNING id`,
        [`ux-sql-org-${tag}`, `ux-sql-${tag}`, `corp-${tag}`],
      )).rows[0].id

      const external = {
        parent: `ux-sql-ext-a-${tag}`,
        child: `ux-sql-ext-b-${tag}`,
        grandchild: `ux-sql-ext-c-${tag}`,
        unrelated: `ux-sql-ext-d-${tag}`,
      }
      async function department(externalDepartmentId: string, parentExternalId: string | null): Promise<string> {
        return (await client.query<{ id: string }>(
          `INSERT INTO directory_departments
             (integration_id, provider, external_department_id, external_parent_department_id, name, is_active, raw)
           VALUES ($1, 'dingtalk', $2, $3, $2, true, '{}'::jsonb) RETURNING id`,
          [integrationId, externalDepartmentId, parentExternalId],
        )).rows[0].id
      }
      const parentDepartmentId = await department(external.parent, null)
      const childDepartmentId = await department(external.child, external.parent)
      const grandchildDepartmentId = await department(external.grandchild, external.child)
      const unrelatedDepartmentId = await department(external.unrelated, null)

      async function linkUser(userId: string, departmentId: string): Promise<void> {
        const accountId = (await client.query<{ id: string }>(
          `INSERT INTO directory_accounts
             (integration_id, provider, external_user_id, external_key, name, is_active, raw)
           VALUES ($1, 'dingtalk', $2, $2, $2, true, '{}'::jsonb) RETURNING id`,
          [integrationId, `ux-sql-account-${userId}`],
        )).rows[0].id
        await client.query(
          `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status, match_strategy)
           VALUES ($1, $2, 'linked', 'manual')`,
          [accountId, userId],
        )
        await client.query(
          `INSERT INTO directory_account_departments (directory_account_id, directory_department_id, is_primary)
           VALUES ($1, $2, true)`,
          [accountId, departmentId],
        )
      }
      await linkUser(parentUserId, parentDepartmentId)
      await linkUser(childUserId, childDepartmentId)
      await linkUser(grandchildUserId, grandchildDepartmentId)
      await linkUser(unrelatedUserId, unrelatedDepartmentId)
      await linkUser(omittedChildUserId, childDepartmentId)

      const groupId = (await client.query<{ id: string }>(
        'INSERT INTO platform_member_groups (name) VALUES ($1) RETURNING id',
        [`ux-sql-group-${tag}`],
      )).rows[0].id
      await client.query(
        'INSERT INTO platform_member_group_members (group_id, user_id) VALUES ($1, $2)',
        [groupId, groupUserId],
      )

      async function visible(): Promise<string[]> {
        const rows = (await client.query<{ user_id: string }>(
          STOCK_PREP_MEMBERS_SCOPED_USERS_SQL,
          [actorId, 'stock-prep', candidateUserIds],
        )).rows
        return rows.map((row) => row.user_id).sort()
      }

      await client.query(
        `INSERT INTO delegated_role_admin_scopes
           (admin_user_id, namespace, directory_department_id, include_children, created_by)
         VALUES ($1, 'stock-prep', $2, false, $1)`,
        [actorId, parentDepartmentId],
      )
      const exact = await visible()
      expect(exact).toEqual([parentUserId].sort())
      expect(exact).not.toContain(childUserId)
      expect(exact).not.toContain(grandchildUserId)
      expect(exact).not.toContain(omittedChildUserId)

      await client.query(
        `UPDATE delegated_role_admin_scopes
            SET include_children = true
          WHERE admin_user_id = $1
            AND namespace = 'stock-prep'
            AND directory_department_id = $2`,
        [actorId, parentDepartmentId],
      )
      expect(await visible()).toEqual([grandchildUserId, parentUserId, childUserId].sort())

      await client.query(
        `INSERT INTO delegated_role_admin_scopes
           (admin_user_id, namespace, directory_department_id, include_children, created_by)
         VALUES ($1, 'stock-prep', $2, false, $1)`,
        [actorId, childDepartmentId],
      )
      const unioned = await visible()
      expect(unioned).toEqual([grandchildUserId, parentUserId, childUserId].sort())
      expect(unioned).toContain(grandchildUserId)
      expect(unioned).not.toContain(unrelatedUserId)
      expect(unioned).not.toContain(groupUserId)

      await client.query('DELETE FROM delegated_role_admin_scopes WHERE admin_user_id = $1', [actorId])
      await client.query(
        `INSERT INTO delegated_role_admin_member_groups (admin_user_id, namespace, group_id, created_by)
         VALUES ($1, 'stock-prep', $2, $1)`,
        [actorId, groupId],
      )
      expect(await visible()).toEqual([groupUserId])
    })
  })
})
