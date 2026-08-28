/**
 * E-learning L2 delegated administration gate against real PostgreSQL.
 * DATABASE_URL is mandatory; missing infrastructure must fail, never skip.
 */
import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool, type PoolClient } from 'pg'

import {
  ELEARNING_ADMIN_SCOPE_ACTIVE_UNIQ,
  ELEARNING_ADMIN_SCOPE_STATE_TRIGGER,
  ELEARNING_ADMIN_SCOPES_TABLE,
  ELEARNING_OBJECT_ACL_COURSE_ACTIVE_UNIQ,
  ELEARNING_OBJECT_ACL_PLAN_ACTIVE_UNIQ,
  ELEARNING_OBJECT_ACL_STATE_TRIGGER,
  ELEARNING_OBJECT_ACL_TABLE,
} from '../../src/db/migrations/zzzz20260826200000_create_elearning_admin_scope_acl'
import {
  assertElearningRulesWithinAdminScope,
  assertElearningUsersWithinAdminScope,
  authorizeElearningObjectAction,
  ElearningAdminAccessError,
  replaceElearningAdminScopes,
  replaceElearningObjectAcl,
  type ElearningAdminAccessDb,
  type ElearningAdminAccessQueryable,
} from '../../src/services/elearning-admin-access'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  throw new Error(
    'e-learning admin-access DB gate requires DATABASE_URL; refusing skip-shaped green',
  )
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 6 })
const NS = `el-admin-${process.pid}-${Date.now().toString(36)}`

async function exec(target: Pool | PoolClient, sql: string, params?: unknown[]) {
  const result = await target.query(sql, params as never)
  return {
    rows: result.rows as Array<Record<string, unknown>>,
    rowCount: result.rowCount,
  }
}

class PoolDb implements ElearningAdminAccessDb {
  async query(sql: string, params?: unknown[]) {
    return exec(pool, sql, params)
  }

  async transaction<T>(
    handler: (tx: ElearningAdminAccessQueryable) => Promise<T>,
  ): Promise<T> {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const value = await handler({ query: (sql, params) => exec(client, sql, params) })
      await client.query('COMMIT')
      return value
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }
}

const db = new PoolDb()
const ORG_A = `${NS}-org-a`
const ORG_B = `${NS}-org-b`
const OWNER = `${NS}-owner`
const GLOBAL_ADMIN = `${NS}-global-admin`
const COLLABORATOR = `${NS}-collaborator`
const MANAGER = `${NS}-manager`
const ROOT_USER = `${NS}-root-user`
const CHILD_USER = `${NS}-child-user`
const OUTSIDE_USER = `${NS}-outside-user`
const ORG_B_USER = `${NS}-org-b-user`

const INTEGRATION_A = randomUUID()
const INTEGRATION_B = randomUUID()
const ROOT_A = randomUUID()
const CHILD_A = randomUUID()
const ROOT_OUTSIDE = randomUUID()
const ROOT_ORG_B = randomUUID()
const COURSE_A = randomUUID()
const COURSE_B = randomUUID()
const PLAN_A = randomUUID()

function expectCode(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(ElearningAdminAccessError)
  expect((error as ElearningAdminAccessError).code).toBe(code)
  expect(`${(error as Error).message}\n${(error as Error).stack ?? ''}`)
    .not.toContain(NS)
}

async function expectSqlState(
  expected: string,
  action: (client: PoolClient) => Promise<unknown>,
): Promise<void> {
  const client = await pool.connect()
  let caught: unknown
  try {
    await client.query('BEGIN')
    await client.query('SAVEPOINT negative')
    try {
      await action(client)
    } catch (error) {
      caught = error
    }
    await client.query('ROLLBACK TO SAVEPOINT negative')
    await client.query('COMMIT')
  } finally {
    client.release()
  }
  expect(caught).toBeDefined()
  expect((caught as { code?: string }).code).toBe(expected)
}

async function seedUser(userId: string, orgId: string): Promise<void> {
  await pool.query(
    `INSERT INTO users (
       id, email, name, password_hash, role, permissions,
       is_active, is_admin, activation_status, local_password_set,
       must_change_password, created_at, updated_at
     ) VALUES (
       $1, $2, $1, 'x', 'user', '[]'::jsonb,
       TRUE, FALSE, 'activated', TRUE, FALSE, now(), now()
     )`,
    [userId, `${randomUUID()}@elearning-admin.test`],
  )
  await pool.query(
    `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)`,
    [userId, orgId],
  )
}

async function seedDirectoryUser(
  userId: string,
  integrationId: string,
  departmentId: string,
): Promise<void> {
  const accountId = randomUUID()
  const external = `${NS}-${randomUUID()}`
  await pool.query(
    `INSERT INTO directory_accounts (
       id, integration_id, provider, external_user_id, external_key,
       name, is_active
     ) VALUES ($1, $2, 'dingtalk', $3, $3, $4, TRUE)`,
    [accountId, integrationId, external, userId],
  )
  await pool.query(
    `INSERT INTO directory_account_departments (
       directory_account_id, directory_department_id, is_primary
     ) VALUES ($1, $2, TRUE)`,
    [accountId, departmentId],
  )
  await pool.query(
    `INSERT INTO directory_account_links (
       id, directory_account_id, local_user_id, link_status
     ) VALUES ($1, $2, $3, 'linked')`,
    [randomUUID(), accountId, userId],
  )
}

beforeAll(async () => {
  for (const [userId, orgId] of [
    [OWNER, ORG_A],
    [GLOBAL_ADMIN, ORG_A],
    [COLLABORATOR, ORG_A],
    [MANAGER, ORG_A],
    [ROOT_USER, ORG_A],
    [CHILD_USER, ORG_A],
    [OUTSIDE_USER, ORG_A],
    [ORG_B_USER, ORG_B],
  ] as const) {
    await seedUser(userId, orgId)
  }

  await pool.query(
    `INSERT INTO directory_integrations (
       id, org_id, provider, name, status, corp_id
     ) VALUES
       ($1, $2, 'dingtalk', $3, 'active', $4),
       ($5, $6, 'dingtalk', $7, 'active', $8)`,
    [
      INTEGRATION_A,
      ORG_A,
      `${NS}-integration-a`,
      `${NS}-corp-a`,
      INTEGRATION_B,
      ORG_B,
      `${NS}-integration-b`,
      `${NS}-corp-b`,
    ],
  )
  await pool.query(
    `INSERT INTO directory_departments (
       id, integration_id, provider, external_department_id,
       external_parent_department_id, name, is_active
     ) VALUES
       ($1, $2, 'dingtalk', 'root-a', NULL, 'Root A', TRUE),
       ($3, $2, 'dingtalk', 'child-a', 'root-a', 'Child A', TRUE),
       ($4, $2, 'dingtalk', 'root-outside', NULL, 'Outside', TRUE),
       ($5, $6, 'dingtalk', 'root-org-b', NULL, 'Org B', TRUE)`,
    [ROOT_A, INTEGRATION_A, CHILD_A, ROOT_OUTSIDE, ROOT_ORG_B, INTEGRATION_B],
  )
  await seedDirectoryUser(ROOT_USER, INTEGRATION_A, ROOT_A)
  await seedDirectoryUser(CHILD_USER, INTEGRATION_A, CHILD_A)
  await seedDirectoryUser(OUTSIDE_USER, INTEGRATION_A, ROOT_OUTSIDE)
  await seedDirectoryUser(ORG_B_USER, INTEGRATION_B, ROOT_ORG_B)

  await pool.query(
    `INSERT INTO elearning_courses (id, org_id, title, status, created_by)
     VALUES
       ($1, $2, 'Admin ACL course A', 'active', $3),
       ($4, $5, 'Admin ACL course B', 'active', $6)`,
    [COURSE_A, ORG_A, OWNER, COURSE_B, ORG_B, ORG_B_USER],
  )
  await pool.query(
    `INSERT INTO elearning_training_plans (
       id, org_id, title, status, created_by
     ) VALUES ($1, $2, 'Admin ACL plan A', 'active', $3)`,
    [PLAN_A, ORG_A, OWNER],
  )
})

afterAll(async () => {
  await pool.end()
})

describe('e-learning delegated administration schema', () => {
  it('installs closed same-org FK/index/trigger contracts', async () => {
    const tables = await pool.query(
      `SELECT tablename
       FROM pg_tables
       WHERE schemaname = current_schema()
         AND tablename = ANY($1::text[])
       ORDER BY tablename`,
      [[ELEARNING_ADMIN_SCOPES_TABLE, ELEARNING_OBJECT_ACL_TABLE]],
    )
    expect(tables.rows.map((row) => row.tablename)).toEqual([
      ELEARNING_ADMIN_SCOPES_TABLE,
      ELEARNING_OBJECT_ACL_TABLE,
    ])

    const indexes = await pool.query(
      `SELECT indexname
       FROM pg_indexes
       WHERE schemaname = current_schema()
         AND indexname = ANY($1::text[])
       ORDER BY indexname`,
      [[
        ELEARNING_ADMIN_SCOPE_ACTIVE_UNIQ,
        ELEARNING_OBJECT_ACL_COURSE_ACTIVE_UNIQ,
        ELEARNING_OBJECT_ACL_PLAN_ACTIVE_UNIQ,
      ]],
    )
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      ELEARNING_ADMIN_SCOPE_ACTIVE_UNIQ,
      ELEARNING_OBJECT_ACL_COURSE_ACTIVE_UNIQ,
      ELEARNING_OBJECT_ACL_PLAN_ACTIVE_UNIQ,
    ])

    const triggers = await pool.query(
      `SELECT tgname
       FROM pg_trigger
       WHERE tgrelid = ANY($1::regclass[])
         AND NOT tgisinternal
         AND tgname = ANY($2::text[])
       ORDER BY tgname`,
      [[ELEARNING_ADMIN_SCOPES_TABLE, ELEARNING_OBJECT_ACL_TABLE], [
        ELEARNING_ADMIN_SCOPE_STATE_TRIGGER,
        ELEARNING_OBJECT_ACL_STATE_TRIGGER,
      ]],
    )
    expect(triggers.rows.map((row) => row.tgname)).toEqual([
      ELEARNING_ADMIN_SCOPE_STATE_TRIGGER,
      ELEARNING_OBJECT_ACL_STATE_TRIGGER,
    ])

    const constraints = await pool.query(
      `SELECT conname
       FROM pg_constraint
       WHERE conrelid = ANY($1::regclass[])
       ORDER BY conname`,
      [[ELEARNING_ADMIN_SCOPES_TABLE, ELEARNING_OBJECT_ACL_TABLE]],
    )
    const names = constraints.rows.map((row) => row.conname)
    expect(names).toEqual(expect.arrayContaining([
      'elearning_admin_scopes_user_org_fk',
      'elearning_admin_scopes_integration_org_fk',
      'elearning_admin_scopes_department_fk',
      'elearning_object_acl_object_xor_chk',
      'elearning_object_acl_action_chk',
      'elearning_object_acl_course_fk',
      'elearning_object_acl_training_plan_fk',
      'elearning_object_acl_grantee_org_fk',
    ]))
  })

  it('rejects cross-org scope, object, grantee, invalid-action, and XOR rows', async () => {
    await expectSqlState('23503', (client) => client.query(
      `INSERT INTO elearning_admin_scopes (
         org_id, user_id, directory_integration_id, directory_provider,
         directory_department_id, include_children, granted_by
       ) VALUES ($1, $2, $3, 'dingtalk', $4, TRUE, $5)`,
      [ORG_A, MANAGER, INTEGRATION_B, ROOT_ORG_B, OWNER],
    ))
    await expectSqlState('23503', (client) => client.query(
      `INSERT INTO elearning_object_acl (
         org_id, course_id, grantee_user_id, action, granted_by
       ) VALUES ($1, $2, $3, 'track', $4)`,
      [ORG_A, COURSE_B, COLLABORATOR, OWNER],
    ))
    await expectSqlState('23503', (client) => client.query(
      `INSERT INTO elearning_object_acl (
         org_id, course_id, grantee_user_id, action, granted_by
       ) VALUES ($1, $2, $3, 'track', $4)`,
      [ORG_A, COURSE_A, ORG_B_USER, OWNER],
    ))
    await expectSqlState('23514', (client) => client.query(
      `INSERT INTO elearning_object_acl (
         org_id, course_id, grantee_user_id, action, granted_by
       ) VALUES ($1, $2, $3, 'edit', $4)`,
      [ORG_A, COURSE_A, COLLABORATOR, OWNER],
    ))
    await expectSqlState('23514', (client) => client.query(
      `INSERT INTO elearning_object_acl (
         org_id, course_id, training_plan_id, grantee_user_id,
         action, granted_by
       ) VALUES ($1, $2, $3, $4, 'track', $5)`,
      [ORG_A, COURSE_A, PLAN_A, COLLABORATOR, OWNER],
    ))
  })
})

describe('e-learning delegated admin scope evaluation', () => {
  it('replaces scopes idempotently and preserves changed/revoked rows as history', async () => {
    await expect(replaceElearningAdminScopes(db, {
      orgId: ORG_A,
      actorId: OWNER,
      targetUserId: MANAGER,
      reason: 'initial root scope',
      scopes: [{ departmentId: ROOT_A, includeChildren: true }],
    })).resolves.toMatchObject({ duplicate: false, scopeCount: 1 })
    await expect(replaceElearningAdminScopes(db, {
      orgId: ORG_A,
      actorId: OWNER,
      targetUserId: MANAGER,
      reason: 'replayed root scope',
      scopes: [{ departmentId: ROOT_A, includeChildren: true }],
    })).resolves.toMatchObject({ duplicate: true, scopeCount: 1 })
    await expect(replaceElearningAdminScopes(db, {
      orgId: ORG_A,
      actorId: OWNER,
      targetUserId: MANAGER,
      reason: 'restrict root scope',
      scopes: [{ departmentId: ROOT_A, includeChildren: false }],
    })).resolves.toMatchObject({ duplicate: false, scopeCount: 1 })
    await expect(replaceElearningAdminScopes(db, {
      orgId: ORG_A,
      actorId: OWNER,
      targetUserId: MANAGER,
      reason: 'remove delegated scope',
      scopes: [],
    })).resolves.toMatchObject({ duplicate: false, scopeCount: 0 })

    const history = await pool.query(
      `SELECT include_children, revoked_at IS NOT NULL AS revoked
       FROM elearning_admin_scopes
       WHERE org_id = $1 AND user_id = $2
       ORDER BY created_at ASC, id ASC`,
      [ORG_A, MANAGER],
    )
    expect(history.rows).toEqual([
      { include_children: true, revoked: true },
      { include_children: false, revoked: true },
    ])
  })

  it('covers descendants only through include_children and denies every uncovered user', async () => {
    await replaceElearningAdminScopes(db, {
      orgId: ORG_A,
      actorId: OWNER,
      targetUserId: MANAGER,
      reason: 'expand root scope',
      scopes: [{ departmentId: ROOT_A, includeChildren: true }],
    })
    await expect(assertElearningUsersWithinAdminScope(db, {
      orgId: ORG_A,
      actorId: MANAGER,
      isGlobalAdmin: false,
      userIds: [ROOT_USER, CHILD_USER],
    })).resolves.toBeUndefined()
    await expect(assertElearningUsersWithinAdminScope(db, {
      orgId: ORG_A,
      actorId: MANAGER,
      isGlobalAdmin: false,
      userIds: [OUTSIDE_USER],
    })).rejects.toMatchObject({ code: 'target_out_of_scope' })

    await replaceElearningAdminScopes(db, {
      orgId: ORG_A,
      actorId: OWNER,
      targetUserId: MANAGER,
      reason: 'exact root only',
      scopes: [{ departmentId: ROOT_A, includeChildren: false }],
    })
    await expect(assertElearningUsersWithinAdminScope(db, {
      orgId: ORG_A,
      actorId: MANAGER,
      isGlobalAdmin: false,
      userIds: [ROOT_USER],
    })).resolves.toBeUndefined()
    await expect(assertElearningUsersWithinAdminScope(db, {
      orgId: ORG_A,
      actorId: MANAGER,
      isGlobalAdmin: false,
      userIds: [CHILD_USER],
    })).rejects.toMatchObject({ code: 'target_out_of_scope' })
  })

  it('denies dynamic scope rules and proves department expansion structurally', async () => {
    for (const rule of [
      { subjectType: 'all', subjectRef: null, includeChildren: false },
      { subjectType: 'position', subjectRef: 'engineer', includeChildren: false },
      { subjectType: 'role', subjectRef: 'manager', includeChildren: false },
    ] as const) {
      await expect(assertElearningRulesWithinAdminScope(db, {
        orgId: ORG_A,
        actorId: MANAGER,
        isGlobalAdmin: false,
        rules: [rule],
      })).rejects.toMatchObject({ code: 'target_out_of_scope' })
    }
    await expect(assertElearningRulesWithinAdminScope(db, {
      orgId: ORG_A,
      actorId: MANAGER,
      isGlobalAdmin: false,
      rules: [{
        subjectType: 'department',
        subjectRef: ROOT_A,
        includeChildren: false,
      }],
    })).resolves.toBeUndefined()
    await expect(assertElearningRulesWithinAdminScope(db, {
      orgId: ORG_A,
      actorId: MANAGER,
      isGlobalAdmin: false,
      rules: [{
        subjectType: 'department',
        subjectRef: ROOT_A,
        includeChildren: true,
      }],
    })).rejects.toMatchObject({ code: 'target_out_of_scope' })

    await replaceElearningAdminScopes(db, {
      orgId: ORG_A,
      actorId: OWNER,
      targetUserId: MANAGER,
      reason: 'expand root again',
      scopes: [{ departmentId: ROOT_A, includeChildren: true }],
    })
    await expect(assertElearningRulesWithinAdminScope(db, {
      orgId: ORG_A,
      actorId: MANAGER,
      isGlobalAdmin: false,
      rules: [{
        subjectType: 'department',
        subjectRef: CHILD_A,
        includeChildren: true,
      }],
    })).resolves.toBeUndefined()
    await expect(assertElearningRulesWithinAdminScope(db, {
      orgId: ORG_A,
      actorId: MANAGER,
      isGlobalAdmin: false,
      rules: [{
        subjectType: 'department',
        subjectRef: ROOT_OUTSIDE,
        includeChildren: false,
      }],
    })).rejects.toMatchObject({ code: 'target_out_of_scope' })
  })

  it('enforces append-only scope identity and one-way complete revocation in PostgreSQL', async () => {
    await replaceElearningAdminScopes(db, {
      orgId: ORG_A,
      actorId: OWNER,
      targetUserId: MANAGER,
      reason: 'scope state guard fixture',
      scopes: [{ departmentId: ROOT_OUTSIDE, includeChildren: false }],
    })
    const row = await pool.query(
      `SELECT id FROM elearning_admin_scopes
       WHERE org_id = $1 AND user_id = $2
         AND directory_department_id = $3 AND revoked_at IS NULL`,
      [ORG_A, MANAGER, ROOT_OUTSIDE],
    )
    const id = row.rows[0]?.id as string
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    await expectSqlState('P0001', (client) => client.query(
      `DELETE FROM elearning_admin_scopes WHERE org_id = $1 AND id = $2`,
      [ORG_A, id],
    ))
    await expectSqlState('P0001', (client) => client.query(
      `UPDATE elearning_admin_scopes SET include_children = TRUE
       WHERE org_id = $1 AND id = $2`,
      [ORG_A, id],
    ))
    await replaceElearningAdminScopes(db, {
      orgId: ORG_A,
      actorId: OWNER,
      targetUserId: MANAGER,
      reason: 'one-way scope revoke fixture',
      scopes: [],
    })
    await expectSqlState('P0001', (client) => client.query(
      `UPDATE elearning_admin_scopes
       SET revocation_reason = 'second revocation'
       WHERE org_id = $1 AND id = $2`,
      [ORG_A, id],
    ))
  })
})

describe('e-learning object collaboration ACL', () => {
  it('allows owner/global-admin grants but no grant-by-delegation', async () => {
    await expect(replaceElearningObjectAcl(db, {
      orgId: ORG_A,
      actorId: OWNER,
      isGlobalAdmin: false,
      object: { courseId: COURSE_A },
      granteeUserId: COLLABORATOR,
      reason: 'track collaborator',
      actions: ['track'],
    })).resolves.toMatchObject({ duplicate: false, actions: ['track'] })
    await expect(replaceElearningObjectAcl(db, {
      orgId: ORG_A,
      actorId: OWNER,
      isGlobalAdmin: false,
      object: { courseId: COURSE_A },
      granteeUserId: COLLABORATOR,
      reason: 'same collaborator',
      actions: ['track'],
    })).resolves.toMatchObject({ duplicate: true, actions: ['track'] })

    let caught: unknown
    try {
      await replaceElearningObjectAcl(db, {
        orgId: ORG_A,
        actorId: COLLABORATOR,
        isGlobalAdmin: false,
        object: { courseId: COURSE_A },
        granteeUserId: MANAGER,
        reason: 'delegated grant is forbidden',
        actions: ['scope'],
      })
    } catch (error) {
      caught = error
    }
    expectCode(caught, 'forbidden')

    await expect(replaceElearningObjectAcl(db, {
      orgId: ORG_A,
      actorId: GLOBAL_ADMIN,
      isGlobalAdmin: true,
      object: { trainingPlanId: PLAN_A },
      granteeUserId: COLLABORATOR,
      reason: 'plan assignment collaborator',
      actions: ['assign'],
    })).resolves.toMatchObject({
      objectType: 'training_plan',
      actions: ['assign'],
    })
  })

  it('authorizes only the exact active action and revocation removes access', async () => {
    await expect(authorizeElearningObjectAction(db, {
      orgId: ORG_A,
      actorId: COLLABORATOR,
      isGlobalAdmin: false,
      object: { courseId: COURSE_A },
      action: 'track',
    })).resolves.toBeUndefined()
    await expect(authorizeElearningObjectAction(db, {
      orgId: ORG_A,
      actorId: COLLABORATOR,
      isGlobalAdmin: false,
      object: { courseId: COURSE_A },
      action: 'assign',
    })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(authorizeElearningObjectAction(db, {
      orgId: ORG_A,
      actorId: COLLABORATOR,
      isGlobalAdmin: false,
      object: { trainingPlanId: PLAN_A },
      action: 'track',
    })).rejects.toMatchObject({ code: 'forbidden' })

    await replaceElearningObjectAcl(db, {
      orgId: ORG_A,
      actorId: OWNER,
      isGlobalAdmin: false,
      object: { courseId: COURSE_A },
      granteeUserId: COLLABORATOR,
      reason: 'revoke course collaborator',
      actions: [],
    })
    await expect(authorizeElearningObjectAction(db, {
      orgId: ORG_A,
      actorId: COLLABORATOR,
      isGlobalAdmin: false,
      object: { courseId: COURSE_A },
      action: 'track',
    })).rejects.toMatchObject({ code: 'forbidden' })

    const history = await pool.query(
      `SELECT action, revoked_at IS NOT NULL AS revoked
       FROM elearning_object_acl
       WHERE org_id = $1 AND course_id = $2 AND grantee_user_id = $3`,
      [ORG_A, COURSE_A, COLLABORATOR],
    )
    expect(history.rows).toEqual([{ action: 'track', revoked: true }])
  })

  it('enforces append-only identity and one-way complete revocation in PostgreSQL', async () => {
    const active = await replaceElearningObjectAcl(db, {
      orgId: ORG_A,
      actorId: OWNER,
      isGlobalAdmin: false,
      object: { courseId: COURSE_A },
      granteeUserId: MANAGER,
      reason: 'state guard fixture',
      actions: ['scope'],
    })
    expect(active.duplicate).toBe(false)
    const row = await pool.query(
      `SELECT id FROM elearning_object_acl
       WHERE org_id = $1 AND course_id = $2 AND grantee_user_id = $3
         AND action = 'scope' AND revoked_at IS NULL`,
      [ORG_A, COURSE_A, MANAGER],
    )
    const id = row.rows[0]?.id as string
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    await expectSqlState('P0001', (client) => client.query(
      `DELETE FROM elearning_object_acl WHERE org_id = $1 AND id = $2`,
      [ORG_A, id],
    ))
    await expectSqlState('P0001', (client) => client.query(
      `UPDATE elearning_object_acl SET action = 'track'
       WHERE org_id = $1 AND id = $2`,
      [ORG_A, id],
    ))
    await replaceElearningObjectAcl(db, {
      orgId: ORG_A,
      actorId: OWNER,
      isGlobalAdmin: false,
      object: { courseId: COURSE_A },
      granteeUserId: MANAGER,
      reason: 'one-way revoke fixture',
      actions: [],
    })
    await expectSqlState('P0001', (client) => client.query(
      `UPDATE elearning_object_acl
       SET revocation_reason = 'second revocation'
       WHERE org_id = $1 AND id = $2`,
      [ORG_A, id],
    ))
  })
})
