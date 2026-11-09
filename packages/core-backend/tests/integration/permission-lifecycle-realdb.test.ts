import { restorePermissionLifecycleEnv } from '../utils/permission-lifecycle-setup'
import { startPermissionCacheProbe } from '../utils/permission-lifecycle-cache-probe'
import {
  createPermissionLifecycleDirectory,
  deletePermissionLifecycleDirectory,
  linkPermissionLifecycleDepartmentUser,
  type PermissionLifecycleDirectory,
} from '../utils/permission-lifecycle-directory'
import {
  dropPermissionLifecycleAdmissionFault,
  dropPermissionLifecycleMemberGroupInsertFault,
  dropPermissionLifecycleScopeInsertGate,
  holdNamespaceAdmissionLock,
  holdScopeInsertLock,
  installPermissionLifecycleAdmissionFault,
  installPermissionLifecycleMemberGroupInsertFault,
  installPermissionLifecycleScopeInsertGate,
  waitForAdvisoryLockWaiterPid,
  writerHoldsAdvisoryLockBesides,
} from '../utils/permission-lifecycle-fault'
import {
  mountPermissionLifecyclePreflight,
  PERMISSION_LIFECYCLE_PREFLIGHT_PATH,
} from '../utils/permission-lifecycle-preflight'
import { randomBytes, randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { authService } from '../../src/auth/AuthService'
import { query, transaction } from '../../src/db/pg'
import { authenticate } from '../../src/middleware/auth'
import { rbacGuard } from '../../src/rbac/rbac'
import { inspectUserPermissionGrants, listUserPermissions } from '../../src/rbac/service'
import { adminUsersRouter } from '../../src/routes/admin-users'
import { permissionsRouter } from '../../src/routes/permissions'

if (process.env.RBAC_BYPASS !== 'false' || process.env.RBAC_TOKEN_TRUST !== 'false') {
  throw new Error('permission lifecycle suite requires RBAC_BYPASS=false and RBAC_TOKEN_TRUST=false')
}
if (process.env.PRODUCT_MODE !== 'plm-workbench') {
  throw new Error('permission lifecycle suite requires PRODUCT_MODE=plm-workbench')
}
if (process.env.EXPECT_DB === '1' && !process.env.DATABASE_URL) {
  throw new Error('EXPECT_DB=1 but DATABASE_URL is missing; refusing a skip-shaped green')
}

const BUSINESS_PATH = PERMISSION_LIFECYCLE_PREFLIGHT_PATH
const STOCK_PREP_ADMIN_ROLE_ID = 'stock-prep_admin'
const PROTECTED_ROLE_IDS = [
  'admin',
  'stock-prep',
  'stock-prep_admin',
  'stock-prep_puller',
  'stock-prep_developer',
  'stock-prep_frontline',
] as const

const runHex = randomBytes(6).toString('hex')
const operatorRoleId = `stock-prep_lc${runHex}`
const holderRoleId = `stock-prep_hold${runHex}`
const otherAdminRoleId = `lcns${runHex}_admin`
const otherNamespace = `lcns${runHex}`
const orgId = `lc-${runHex}`
const adminId = randomUUID()
const subjectId = randomUUID()
const targetId = randomUUID()
const outsiderId = randomUUID()
const delegateId = randomUUID()
const childUserId = randomUUID()
const outsideUserId = randomUUID()
const directUserId = randomUUID()
const legacyUserId = randomUUID()
const wildcardUserId = randomUUID()
const controlUserId = randomUUID()
const bypassUserId = randomUUID()
const rollbackUserId = randomUUID()
const raceUserId = randomUUID()
const cacheUserId = randomUUID()
const fixtureRoleIds = [operatorRoleId, holderRoleId, otherAdminRoleId]
const ownedUserIds = [
  adminId,
  subjectId,
  targetId,
  outsiderId,
  delegateId,
  childUserId,
  outsideUserId,
  directUserId,
  legacyUserId,
  wildcardUserId,
  controlUserId,
  bypassUserId,
  rollbackUserId,
  raceUserId,
  cacheUserId,
]

function uuidSortedAgainst(anchor: string, side: 'before' | 'after'): string {
  const hex = '0123456789abcdef'
  const source = anchor.toLowerCase()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(source)) {
    throw new Error('anchor is not a uuid')
  }
  const reserved = new Set(ownedUserIds)
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '-' || index === 14) continue
    const digit = hex.indexOf(source[index] ?? '')
    const moved = side === 'before' ? digit - 1 : digit + 1
    if (moved < 0 || moved > 15) continue
    const chars = source.split('')
    chars[index] = hex[moved] ?? ''
    const candidate = chars.join('')
    const ordered = side === 'before' ? candidate < source : candidate > source
    if (!ordered || reserved.has(candidate)) continue
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(candidate)) continue
    return candidate
  }
  throw new Error(`no uuid sorts ${side} the actor`)
}

const actorBeforeTargetId = uuidSortedAgainst(adminId, 'after')
ownedUserIds.push(actorBeforeTargetId)
const targetBeforeActorId = uuidSortedAgainst(adminId, 'before')
ownedUserIds.push(targetBeforeActorId)
const extraGroupIds: string[] = []
const ownedTemplateIds: string[] = []
let directory: PermissionLifecycleDirectory | null = null

if (
  (PROTECTED_ROLE_IDS as readonly string[]).includes(operatorRoleId)
  || operatorRoleId.endsWith('_admin')
) {
  throw new Error('refusing to use a built-in or delegated-admin role id for the operator fixture')
}

interface HttpResult {
  status: number
  body: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function errorCode(body: unknown): string | undefined {
  if (!isRecord(body) || !isRecord(body.error)) return undefined
  return typeof body.error.code === 'string' ? body.error.code : undefined
}

function responseDiagnostic(result: HttpResult): string {
  const ok = isRecord(result.body) && 'ok' in result.body
    ? String(result.body.ok === true)
    : 'absent'
  return `status ${result.status} code ${errorCode(result.body) ?? 'none'} ok ${ok}`
}

function expectShape(value: unknown, shape: unknown, label: string): void {
  const mismatches: string[] = []
  const walk = (actual: unknown, expected: unknown, path: string): void => {
    if (isRecord(expected)) {
      if (!isRecord(actual)) {
        mismatches.push(`${path || label} is not an object`)
        return
      }
      for (const key of Object.keys(expected)) {
        if (!Object.prototype.hasOwnProperty.call(actual, key)) {
          mismatches.push(`${path}${key} is absent`)
          continue
        }
        walk(actual[key], expected[key], `${path}${key}.`)
      }
      return
    }
    if (actual !== expected) {
      mismatches.push(`${path.slice(0, -1) || label} does not match the expected literal`)
    }
  }
  walk(value, shape, '')
  if (mismatches.length > 0) {
    throw new Error(`${label} shape mismatch: ${mismatches.join('; ')}`)
  }
}

const PREFLIGHT_OK_SHAPE = {
  ok: true,
  data: {
    ready: false,
    checks: {
      confirmationLedger: {
        ready: false,
        present: false,
        mode: 'confirmation_decision_missing',
      },
    },
  },
} as const

function assertStatus(result: HttpResult, status: number): void {
  expect(result.status, responseDiagnostic(result)).toBe(status)
}

function assertError(result: HttpResult, status: number, code: string): void {
  assertStatus(result, status)
  expect(errorCode(result.body)).toBe(code)
}

function assertOk(result: HttpResult): void {
  assertStatus(result, 200)
  if (!isRecord(result.body) || result.body.ok !== true) {
    throw new Error(`expected an ok envelope: ${responseDiagnostic(result)}`)
  }
}

const app = express()
app.use(express.json())
app.use(adminUsersRouter())
app.use(permissionsRouter())
app.get(
  '/api/rbac/stock-prep/read-probe',
  authenticate,
  rbacGuard('stock-prep', 'read'),
  (_req, res) => {
    res.status(200).json({ ok: true })
  },
)
mountPermissionLifecyclePreflight(app)

let adminToken = ''
let subjectToken = ''
let ownedGroupId: string | null = null

function mintToken(id: string): string {
  return authService.createToken({
    id,
    email: `${id}@example.test`,
    name: 'synthetic',
    role: 'user',
    tenantId: orgId,
    permissions: [],
    created_at: new Date(),
    updated_at: new Date(),
  })
}

async function post(path: string, token: string, body: Record<string, unknown>): Promise<HttpResult> {
  const response = await request(app).post(path).auth(token, { type: 'bearer' }).send(body)
  return { status: response.status, body: response.body }
}

async function patch(path: string, token: string, body: Record<string, unknown>): Promise<HttpResult> {
  const response = await request(app).patch(path).auth(token, { type: 'bearer' }).send(body)
  return { status: response.status, body: response.body }
}

function rolePath(userId: string, action: 'assign' | 'unassign'): string {
  return `/api/admin/users/${userId}/roles/${action}`
}

function admissionPath(userId: string): string {
  return `/api/admin/users/${userId}/namespaces/stock-prep/admission`
}

async function business(token: string = subjectToken): Promise<HttpResult> {
  const response = await request(app).get(BUSINESS_PATH).auth(token, { type: 'bearer' })
  const result: HttpResult = { status: response.status, body: response.body }
  if (result.status === 403) {
    expectShape(result.body, { ok: false, error: { code: 'FORBIDDEN' } }, 'preflight')
  }
  if (result.status === 200) {
    expectShape(result.body, PREFLIGHT_OK_SHAPE, 'preflight')
  }
  return result
}

async function requireOneRow(sql: string, params: unknown[], label: string): Promise<void> {
  const found = await query(sql, params)
  if (found.rows.length !== 1) {
    throw new Error(`${label} is absent; refusing to create or rewrite it`)
  }
}

function groupIdFrom(body: unknown): string {
  if (!isRecord(body) || !isRecord(body.data) || !isRecord(body.data.item)) {
    throw new Error('member group response did not include data.item')
  }
  const id = body.data.item.id
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`member group response data.item.id is ${typeof id === 'string' ? 'empty' : typeof id}`)
  }
  return id
}

function rememberTemplateId(body: unknown): string {
  const templateId = groupIdFrom(body)
  ownedTemplateIds.push(templateId)
  return templateId
}

async function cleanupOwnedFixtures(): Promise<void> {
  const groupIds = [ownedGroupId, ...extraGroupIds].filter((id): id is string => Boolean(id))
  await transaction(async (client) => {
    await client.query('DELETE FROM role_permissions WHERE role_id = ANY($1::text[])', [fixtureRoleIds])
    await client.query(
      `DELETE FROM user_roles
        WHERE user_id::text = ANY($1::text[])
           OR role_id = ANY($2::text[])`,
      [ownedUserIds, fixtureRoleIds],
    )
    await client.query(
      'DELETE FROM user_permissions WHERE user_id::text = ANY($1::text[])',
      [ownedUserIds],
    )
    await client.query(
      'DELETE FROM user_namespace_admissions WHERE user_id::text = ANY($1::text[])',
      [ownedUserIds],
    )
    await client.query(
      'DELETE FROM user_orgs WHERE user_id::text = ANY($1::text[])',
      [ownedUserIds],
    )
    const namedTemplates = await client.query(
      'SELECT id::text AS id FROM delegated_role_scope_templates WHERE name LIKE $1',
      [`plc-${runHex}-%`],
    )
    const templateIds = [...new Set([
      ...ownedTemplateIds,
      ...namedTemplates.rows.map((row) => row.id),
    ])]
    if (templateIds.length > 0) {
      await client.query(
        `DELETE FROM audit_logs
          WHERE resource_type = 'delegated-admin-scope-template'
            AND (
              action_details->>'templateId' = ANY($1::text[])
              OR EXISTS (
                SELECT 1
                FROM unnest($1::text[]) AS owned(id)
                WHERE audit_logs.resource_id = 'template:' || owned.id
                   OR left(audit_logs.resource_id, length('template:' || owned.id) + 1) = 'template:' || owned.id || ':'
                   OR right(audit_logs.resource_id, length(':template:' || owned.id)) = ':template:' || owned.id
              )
            )`,
        [templateIds],
      )
    }
    await client.query(
      `DELETE FROM delegated_role_scope_template_member_groups
        WHERE template_id IN (SELECT id FROM delegated_role_scope_templates WHERE name LIKE $1)`,
      [`plc-${runHex}-%`],
    )
    await client.query(
      `DELETE FROM delegated_role_scope_template_departments
        WHERE template_id IN (SELECT id FROM delegated_role_scope_templates WHERE name LIKE $1)`,
      [`plc-${runHex}-%`],
    )
    await client.query('DELETE FROM delegated_role_scope_templates WHERE name LIKE $1', [`plc-${runHex}-%`])
    await client.query(
      'DELETE FROM delegated_role_admin_scopes WHERE admin_user_id::text = ANY($1::text[])',
      [ownedUserIds],
    )
    await client.query(
      `DELETE FROM delegated_role_admin_member_groups
        WHERE admin_user_id::text = ANY($1::text[])
           OR group_id::text = ANY($2::text[])`,
      [ownedUserIds, groupIds],
    )
    await client.query(
      `DELETE FROM platform_member_group_members
        WHERE user_id::text = ANY($1::text[])
           OR group_id::text = ANY($2::text[])`,
      [ownedUserIds, groupIds],
    )
    if (groupIds.length > 0) {
      await client.query('DELETE FROM platform_member_groups WHERE id::text = ANY($1::text[])', [groupIds])
    }
    if (directory) {
      await deletePermissionLifecycleDirectory(client, directory.integrationId)
    }
    // UUID actors store user_id NULL. Match this run's resource_id values and the
    // action_details keys that carry those owned ids. roleId is limited to the
    // per-run operator role; stock-prep_admin stays out of that comparison.
    const auditResourceIds = [
      `${subjectId}:${operatorRoleId}`,
      `${targetId}:${operatorRoleId}`,
      `${outsiderId}:${operatorRoleId}`,
      `${subjectId}:${STOCK_PREP_ADMIN_ROLE_ID}`,
      `${subjectId}:stock-prep`,
      `${adminId}:stock-prep`,
      `${targetId}:stock-prep`,
      `${outsiderId}:stock-prep`,
    ]
    for (const groupId of groupIds) {
      auditResourceIds.push(
        `group:${groupId}`,
        `${groupId}:${adminId}`,
        `${groupId}:${subjectId}`,
        `${groupId}:${targetId}`,
        `${groupId}:${outsiderId}`,
        `${subjectId}:stock-prep:group:${groupId}`,
        `${rollbackUserId}:stock-prep:group:${groupId}`,
      )
    }
    await client.query(
      `DELETE FROM audit_logs
        WHERE resource_id = ANY($1::text[])
           OR action_details->>'userId' = ANY($2::text[])
           OR action_details->>'adminUserId' = ANY($2::text[])
           OR action_details->>'groupId' = ANY($3::text[])
           OR action_details->>'roleId' = ANY($4::text[])
           OR action_details->>'operatorRoleId' = ANY($4::text[])`,
      [auditResourceIds, ownedUserIds, groupIds, fixtureRoleIds],
    )
    await client.query('DELETE FROM users WHERE id::text = ANY($1::text[])', [ownedUserIds])
    await client.query(
      'DELETE FROM roles WHERE id = ANY($1::text[]) AND NOT (id = ANY($2::text[]))',
      [fixtureRoleIds, [...PROTECTED_ROLE_IDS]],
    )
  })
}

describe.sequential('permission lifecycle real database', () => {
  beforeAll(async () => {
    expect(process.env.EXPECT_DB).toBe('1')
    expect(process.env.RBAC_BYPASS).toBe('false')
    expect(process.env.RBAC_TOKEN_TRUST).toBe('false')
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is required')
    }

    await requireOneRow('SELECT id FROM roles WHERE id = $1', ['admin'], 'built-in role admin')
    await requireOneRow(
      'SELECT id FROM roles WHERE id = $1',
      [STOCK_PREP_ADMIN_ROLE_ID],
      'built-in role stock-prep_admin',
    )
    await requireOneRow(
      'SELECT code FROM permissions WHERE code = $1',
      ['stock-prep:read'],
      'catalogue permission stock-prep:read',
    )
    await requireOneRow(
      'SELECT code FROM permissions WHERE code = $1',
      ['stock-prep:operate'],
      'catalogue permission stock-prep:operate',
    )

    for (const id of ownedUserIds) {
      const isPlatformAdmin = id === adminId || id === bypassUserId
      await query(
        `INSERT INTO users (
           id, username, email, name, password_hash, role, is_admin, is_active,
           activation_status, must_change_password, local_password_set
         ) VALUES ($1, $1, $2, 'synthetic', 'synthetic', $3, $4, true, 'activated', false, true)`,
        [id, `${id}@example.test`, isPlatformAdmin ? 'admin' : 'user', isPlatformAdmin],
      )
    }
    await query(
      'INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2), ($3, $2)',
      [adminId, 'admin', bypassUserId],
    )
    await query(
      'INSERT INTO roles (id, name) VALUES ($1, $2), ($3, $4), ($5, $6)',
      [
        operatorRoleId,
        `lifecycle ${runHex}`,
        holderRoleId,
        `lifecycle hold ${runHex}`,
        otherAdminRoleId,
        `lifecycle ns ${runHex}`,
      ],
    )
    await query(
      'INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, $2), ($3, $4)',
      [operatorRoleId, 'stock-prep:read', holderRoleId, 'stock-prep:operate'],
    )
    directory = await createPermissionLifecycleDirectory(runHex)
    await linkPermissionLifecycleDepartmentUser(directory, childUserId, directory.childDepartmentId)
    await linkPermissionLifecycleDepartmentUser(directory, outsideUserId, directory.outsideDepartmentId)
    for (const id of ownedUserIds) {
      await query(
        'INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)',
        [id, orgId],
      )
    }

    adminToken = mintToken(adminId)
    subjectToken = mintToken(subjectId)
  })

  afterAll(async () => {
    try {
      await dropPermissionLifecycleAdmissionFault(runHex)
      await dropPermissionLifecycleScopeInsertGate(runHex)
      await dropPermissionLifecycleMemberGroupInsertFault(runHex)
      await cleanupOwnedFixtures()
    } finally {
      restorePermissionLifecycleEnv()
    }
  })

  it('keeps role assignment and namespace admission separate across revoke and regrant', async () => {
    assertOk(await post(rolePath(subjectId, 'assign'), adminToken, { roleId: operatorRoleId }))
    expect((await business()).status).toBe(403)

    const grants = await inspectUserPermissionGrants(subjectId)
    expect(grants.inherited).toContain('stock-prep:read')
    expect(grants.effective).not.toContain('stock-prep:read')

    assertOk(await patch(admissionPath(subjectId), adminToken, { enabled: true }))
    expect((await business()).status).toBe(200)
    expect((await business()).status).toBe(200)

    const unassigned = await post(rolePath(subjectId, 'unassign'), adminToken, { roleId: operatorRoleId })
    assertOk(unassigned)
    expect((await business()).status).toBe(403)
    expect(await listUserPermissions(subjectId)).not.toContain('stock-prep:read')

    assertOk(await post(rolePath(subjectId, 'assign'), adminToken, { roleId: operatorRoleId }))
    expect((await business()).status).toBe(403)
    expect(await listUserPermissions(subjectId)).not.toContain('stock-prep:read')

    assertOk(await patch(admissionPath(subjectId), adminToken, { enabled: true }))
    expect((await business()).status).toBe(200)
    assertOk(await patch(admissionPath(subjectId), adminToken, { enabled: false }))
    expect((await business()).status).toBe(403)
    expect(await listUserPermissions(subjectId)).not.toContain('stock-prep:read')
  })

  it('clears delegated member-group scope on last role revoke and does not restore it', async () => {
    assertOk(await post(rolePath(subjectId, 'assign'), adminToken, { roleId: STOCK_PREP_ADMIN_ROLE_ID }))
    assertOk(await patch(admissionPath(subjectId), adminToken, { enabled: true }))

    const delegationPath = `/api/admin/role-delegation/users/${targetId}/roles/assign`
    assertError(
      await post(delegationPath, subjectToken, { roleId: operatorRoleId }),
      403,
      'ROLE_DELEGATION_SCOPE_REQUIRED',
    )

    const created = await post('/api/admin/role-delegation/member-groups', adminToken, { name: `lc${runHex}` })
    assertOk(created)
    ownedGroupId = groupIdFrom(created.body)
    assertOk(await post(
      `/api/admin/role-delegation/users/${targetId}/member-groups/assign`,
      adminToken,
      { groupId: ownedGroupId },
    ))
    assertOk(await post(
      `/api/admin/role-delegation/users/${subjectId}/scope-groups/assign`,
      adminToken,
      { namespace: 'stock-prep', groupId: ownedGroupId },
    ))

    assertError(
      await post(
        `/api/admin/role-delegation/users/${outsiderId}/roles/assign`,
        subjectToken,
        { roleId: operatorRoleId },
      ),
      403,
      'ROLE_DELEGATION_USER_OUT_OF_SCOPE',
    )
    assertOk(await post(delegationPath, subjectToken, { roleId: operatorRoleId }))

    assertOk(await post(rolePath(subjectId, 'unassign'), adminToken, { roleId: STOCK_PREP_ADMIN_ROLE_ID }))
    const remaining = await query(
      'SELECT 1 FROM delegated_role_admin_member_groups WHERE admin_user_id = $1',
      [subjectId],
    )
    expect(remaining.rowCount).toBe(0)

    assertOk(await post(rolePath(subjectId, 'assign'), adminToken, { roleId: STOCK_PREP_ADMIN_ROLE_ID }))
    assertOk(await patch(admissionPath(subjectId), adminToken, { enabled: true }))
    assertError(
      await post(delegationPath, subjectToken, { roleId: operatorRoleId }),
      403,
      'ROLE_DELEGATION_SCOPE_REQUIRED',
    )
  })

  function requireDirectory(): PermissionLifecycleDirectory {
    if (!directory) throw new Error('directory fixture missing')
    return directory
  }

  async function roleHeld(userId: string, roleId: string): Promise<boolean> {
    const result = await query('SELECT 1 FROM user_roles WHERE user_id = $1 AND role_id = $2', [userId, roleId])
    return (result.rowCount ?? 0) > 0
  }

  async function scopeCount(userId: string, namespace: string): Promise<number> {
    const result = await query<{ n: number }>(
      `SELECT count(*)::int AS n
       FROM delegated_role_admin_scopes
       WHERE admin_user_id = $1 AND namespace = $2`,
      [userId, namespace],
    )
    return result.rows[0]?.n ?? 0
  }

  async function groupScopeCount(userId: string, namespace: string): Promise<number> {
    const result = await query<{ n: number }>(
      `SELECT count(*)::int AS n
       FROM delegated_role_admin_member_groups
       WHERE admin_user_id = $1 AND namespace = $2`,
      [userId, namespace],
    )
    return result.rows[0]?.n ?? 0
  }

  async function admissionEnabled(userId: string, namespace: string): Promise<boolean> {
    const result = await query<{ enabled: boolean }>(
      'SELECT enabled FROM user_namespace_admissions WHERE user_id = $1 AND namespace = $2',
      [userId, namespace],
    )
    return result.rows[0]?.enabled === true
  }

  async function ownedRevokeSnapshot(userId: string): Promise<{
    roles: unknown[]
    admissions: unknown[]
    departmentScopes: unknown[]
    groupScopes: unknown[]
  }> {
    const read = async (sql: string): Promise<unknown[]> => {
      const result = await query<{ row: unknown }>(sql, [userId])
      return result.rows.map((item) => item.row)
    }
    const [roles, admissions, departmentScopes, groupScopes] = await Promise.all([
      read(`SELECT row_to_json(t) AS row FROM (
        SELECT * FROM user_roles WHERE user_id = $1 ORDER BY role_id
      ) t`),
      read(`SELECT row_to_json(t) AS row FROM (
        SELECT * FROM user_namespace_admissions WHERE user_id = $1 ORDER BY namespace
      ) t`),
      read(`SELECT row_to_json(t) AS row FROM (
        SELECT * FROM delegated_role_admin_scopes WHERE admin_user_id = $1
        ORDER BY namespace, directory_department_id
      ) t`),
      read(`SELECT row_to_json(t) AS row FROM (
        SELECT * FROM delegated_role_admin_member_groups WHERE admin_user_id = $1
        ORDER BY namespace, group_id
      ) t`),
    ])
    return { roles, admissions, departmentScopes, groupScopes }
  }

  function scopeAssignmentsOf(body: unknown): Array<{ namespace: string; directoryDepartmentId: string }> {
    if (!isRecord(body) || !isRecord(body.data) || !Array.isArray(body.data.scopeAssignments)) {
      const dataShape = isRecord(body) && isRecord(body.data)
        ? (Array.isArray(body.data.scopeAssignments) ? 'array' : typeof body.data.scopeAssignments)
        : 'missing'
      throw new Error(`scope response missing data.scopeAssignments; data ${dataShape}`)
    }
    return body.data.scopeAssignments.map((item) => {
      if (!isRecord(item) || typeof item.namespace !== 'string' || typeof item.directoryDepartmentId !== 'string') {
        const namespaceType = isRecord(item) ? typeof item.namespace : 'missing'
        const departmentType = isRecord(item) ? typeof item.directoryDepartmentId : 'missing'
        throw new Error(`unexpected scope assignment shape: namespace ${namespaceType}, directoryDepartmentId ${departmentType}`)
      }
      return { namespace: item.namespace, directoryDepartmentId: item.directoryDepartmentId }
    })
  }

  async function grantDirect(userId: string, permission: string): Promise<void> {
    const response = await request(app)
      .post('/api/permissions/grant')
      .auth(adminToken, { type: 'bearer' })
      .send({ userId, permission })
    if (response.status !== 200 || response.body?.success !== true) {
      const success = isRecord(response.body) ? response.body.success === true : false
      throw new Error(`direct grant failed: status ${response.status} success ${success} code ${errorCode(response.body) ?? 'none'}`)
    }
  }

  async function setLegacyPermissions(userId: string, codes: string[]): Promise<void> {
    await query('UPDATE users SET permissions = $2::jsonb WHERE id = $1', [userId, JSON.stringify(codes)])
  }

  async function remotePreflight(baseUrl: string, token: string): Promise<HttpResult> {
    const response = await fetch(`${baseUrl}${BUSINESS_PATH}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    const body: unknown = await response.json().catch(() => null)
    return { status: response.status, body }
  }

  it('clears a parent department scope on the last stock-prep admin revoke and keeps the other namespace', async () => {
    const tree = requireDirectory()
    const delegateToken = mintToken(delegateId)
    assertOk(await post(rolePath(delegateId, 'assign'), adminToken, { roleId: STOCK_PREP_ADMIN_ROLE_ID }))
    assertOk(await post(rolePath(delegateId, 'assign'), adminToken, { roleId: otherAdminRoleId }))
    assertOk(await patch(admissionPath(delegateId), adminToken, { enabled: true }))
    assertOk(await post(
      `/api/admin/role-delegation/users/${delegateId}/scopes/assign`,
      adminToken,
      { namespace: 'stock-prep', directoryDepartmentId: tree.parentDepartmentId },
    ))
    assertOk(await post(
      `/api/admin/role-delegation/users/${delegateId}/scopes/assign`,
      adminToken,
      { namespace: otherNamespace, directoryDepartmentId: tree.parentDepartmentId },
    ))

    assertOk(await post(
      `/api/admin/role-delegation/users/${childUserId}/roles/assign`,
      delegateToken,
      { roleId: operatorRoleId },
    ))
    assertError(
      await post(
        `/api/admin/role-delegation/users/${outsideUserId}/roles/assign`,
        delegateToken,
        { roleId: operatorRoleId },
      ),
      403,
      'ROLE_DELEGATION_USER_OUT_OF_SCOPE',
    )

    assertOk(await post(rolePath(delegateId, 'unassign'), adminToken, { roleId: STOCK_PREP_ADMIN_ROLE_ID }))
    expect(await scopeCount(delegateId, 'stock-prep')).toBe(0)
    expect(await scopeCount(delegateId, otherNamespace)).toBe(1)
    assertError(
      await post(
        `/api/admin/role-delegation/users/${childUserId}/roles/assign`,
        delegateToken,
        { roleId: operatorRoleId },
      ),
      403,
      'ROLE_DELEGATION_FORBIDDEN',
    )

    assertOk(await post(rolePath(delegateId, 'assign'), adminToken, { roleId: STOCK_PREP_ADMIN_ROLE_ID }))
    assertOk(await patch(admissionPath(delegateId), adminToken, { enabled: true }))
    expect(await scopeCount(delegateId, 'stock-prep')).toBe(0)
    expect(await scopeCount(delegateId, otherNamespace)).toBe(1)
    const listed = await request(app)
      .get(`/api/admin/role-delegation/users/${delegateId}/scopes`)
      .auth(adminToken, { type: 'bearer' })
    expect(listed.status).toBe(200)
    const assignments = scopeAssignmentsOf(listed.body)
    expect(assignments).toContainEqual({ namespace: otherNamespace, directoryDepartmentId: tree.parentDepartmentId })
    expect(assignments.some((item) => item.namespace === 'stock-prep')).toBe(false)
    assertError(
      await post(
        `/api/admin/role-delegation/users/${childUserId}/roles/assign`,
        delegateToken,
        { roleId: operatorRoleId },
      ),
      403,
      'ROLE_DELEGATION_USER_OUT_OF_SCOPE',
    )
  })

  it('admits isolated direct and legacy stock-prep:read only with a controlling role and admission', async () => {
    const directToken = mintToken(directUserId)
    const legacyToken = mintToken(legacyUserId)
    await grantDirect(directUserId, 'stock-prep:read')
    await setLegacyPermissions(legacyUserId, ['stock-prep:read'])

    expect((await business(directToken)).status).toBe(403)
    expect((await business(legacyToken)).status).toBe(403)
    const blockedDirect = await inspectUserPermissionGrants(directUserId)
    expect(blockedDirect.direct).toContain('stock-prep:read')
    expect(blockedDirect.inherited).not.toContain('stock-prep:read')
    expect(blockedDirect.effective).not.toContain('stock-prep:read')
    const blockedLegacy = await inspectUserPermissionGrants(legacyUserId)
    expect(blockedLegacy.legacy).toContain('stock-prep:read')
    expect(blockedLegacy.direct).not.toContain('stock-prep:read')
    expect(blockedLegacy.effective).not.toContain('stock-prep:read')

    assertOk(await post(rolePath(directUserId, 'assign'), adminToken, { roleId: holderRoleId }))
    assertOk(await post(rolePath(legacyUserId, 'assign'), adminToken, { roleId: holderRoleId }))
    expect((await business(directToken)).status).toBe(403)
    expect((await business(legacyToken)).status).toBe(403)

    assertOk(await patch(admissionPath(directUserId), adminToken, { enabled: true }))
    assertOk(await patch(admissionPath(legacyUserId), adminToken, { enabled: true }))
    expect((await business(directToken)).status).toBe(200)
    expect((await business(legacyToken)).status).toBe(200)
    const admittedDirect = await inspectUserPermissionGrants(directUserId)
    expect(admittedDirect.direct).toContain('stock-prep:read')
    expect(admittedDirect.inherited).not.toContain('stock-prep:read')
    expect(admittedDirect.effective).toContain('stock-prep:read')
    const admittedLegacy = await inspectUserPermissionGrants(legacyUserId)
    expect(admittedLegacy.legacy).toContain('stock-prep:read')
    expect(admittedLegacy.direct).not.toContain('stock-prep:read')
    expect(admittedLegacy.effective).toContain('stock-prep:read')

    assertOk(await post(rolePath(directUserId, 'unassign'), adminToken, { roleId: holderRoleId }))
    assertOk(await post(rolePath(legacyUserId, 'unassign'), adminToken, { roleId: holderRoleId }))
    const directRow = await query(
      'SELECT 1 FROM user_permissions WHERE user_id = $1 AND permission_code = $2',
      [directUserId, 'stock-prep:read'],
    )
    expect(directRow.rowCount).toBe(1)
    const legacyRow = await query<{ permissions: unknown }>('SELECT permissions FROM users WHERE id = $1', [legacyUserId])
    expect(legacyRow.rows[0]?.permissions).toEqual(['stock-prep:read'])
    expect((await business(directToken)).status).toBe(403)
    expect((await business(legacyToken)).status).toBe(403)
    expect((await inspectUserPermissionGrants(directUserId)).direct).toContain('stock-prep:read')
    expect((await inspectUserPermissionGrants(legacyUserId)).legacy).toContain('stock-prep:read')
  })

  it('keeps a legacy stock-prep wildcard off preflight and lets the RBAC guard admit it when admission allows', async () => {
    const token = mintToken(wildcardUserId)
    await setLegacyPermissions(wildcardUserId, ['stock-prep:*'])
    expect((await business(token)).status).toBe(403)
    const coldProbe = await request(app).get('/api/rbac/stock-prep/read-probe').auth(token, { type: 'bearer' })
    expect(coldProbe.status).toBe(403)

    assertOk(await post(rolePath(wildcardUserId, 'assign'), adminToken, { roleId: holderRoleId }))
    expect((await business(token)).status).toBe(403)
    const heldProbe = await request(app).get('/api/rbac/stock-prep/read-probe').auth(token, { type: 'bearer' })
    expect(heldProbe.status).toBe(403)

    assertOk(await patch(admissionPath(wildcardUserId), adminToken, { enabled: true }))
    expect((await business(token)).status).toBe(403)
    const admittedProbe = await request(app).get('/api/rbac/stock-prep/read-probe').auth(token, { type: 'bearer' })
    expect(admittedProbe.status).toBe(200)
    const checked = await request(app)
      .post('/api/permissions/check')
      .auth(adminToken, { type: 'bearer' })
      .send({ permission: 'stock-prep:read', userId: wildcardUserId })
    expect(checked.status).toBe(200)
    expect(checked.body.allowed).toBe(true)
    const grants = await inspectUserPermissionGrants(wildcardUserId)
    expect(grants.legacy).toContain('stock-prep:*')
    expect(grants.direct).not.toContain('stock-prep:read')
    expect(grants.inherited).not.toContain('stock-prep:read')
    expect(grants.effective).toContain('stock-prep:*')
    expect(grants.effective).not.toContain('stock-prep:read')

    assertOk(await post(rolePath(wildcardUserId, 'unassign'), adminToken, { roleId: holderRoleId }))
    const legacyRow = await query<{ permissions: unknown }>('SELECT permissions FROM users WHERE id = $1', [wildcardUserId])
    expect(legacyRow.rows[0]?.permissions).toEqual(['stock-prep:*'])
    const directRow = await query('SELECT 1 FROM user_permissions WHERE user_id = $1', [wildcardUserId])
    expect(directRow.rowCount).toBe(0)
    expect((await business(token)).status).toBe(403)
    const revokedProbe = await request(app).get('/api/rbac/stock-prep/read-probe').auth(token, { type: 'bearer' })
    expect(revokedProbe.status).toBe(403)
  })

  it('lets a platform admin bypass preflight without stock-prep:read and keeps a direct grant after that role is revoked', async () => {
    const bypassToken = mintToken(bypassUserId)
    const controlToken = mintToken(controlUserId)
    expect((await business(controlToken)).status).toBe(403)
    expect((await business(bypassToken)).status).toBe(200)

    await grantDirect(bypassUserId, 'stock-prep:read')
    assertOk(await post(rolePath(bypassUserId, 'unassign'), adminToken, { roleId: 'admin' }))
    const directRow = await query(
      'SELECT 1 FROM user_permissions WHERE user_id = $1 AND permission_code = $2',
      [bypassUserId, 'stock-prep:read'],
    )
    expect(directRow.rowCount).toBe(1)
    expect((await inspectUserPermissionGrants(bypassUserId)).direct).toContain('stock-prep:read')
    expect((await business(bypassToken)).status).toBe(403)
    expect((await business(controlToken)).status).toBe(403)
  })

  it('rolls back the role, admission, and both scope tables when the admission write fails', async () => {
    const tree = requireDirectory()
    assertOk(await post(rolePath(rollbackUserId, 'assign'), adminToken, { roleId: STOCK_PREP_ADMIN_ROLE_ID }))
    assertOk(await patch(admissionPath(rollbackUserId), adminToken, { enabled: true }))
    assertOk(await post(
      `/api/admin/role-delegation/users/${rollbackUserId}/scopes/assign`,
      adminToken,
      { namespace: 'stock-prep', directoryDepartmentId: tree.parentDepartmentId },
    ))
    const created = await post('/api/admin/role-delegation/member-groups', adminToken, { name: `lcrb${runHex}` })
    assertOk(created)
    const groupId = groupIdFrom(created.body)
    extraGroupIds.push(groupId)
    assertOk(await post(
      `/api/admin/role-delegation/users/${rollbackUserId}/scope-groups/assign`,
      adminToken,
      { namespace: 'stock-prep', groupId },
    ))
    expect(await roleHeld(rollbackUserId, STOCK_PREP_ADMIN_ROLE_ID)).toBe(true)
    expect(await admissionEnabled(rollbackUserId, 'stock-prep')).toBe(true)
    expect(await scopeCount(rollbackUserId, 'stock-prep')).toBe(1)
    expect(await groupScopeCount(rollbackUserId, 'stock-prep')).toBe(1)

    await installPermissionLifecycleAdmissionFault(rollbackUserId, runHex)
    const before = await ownedRevokeSnapshot(rollbackUserId)
    expect(before.roles).toEqual(expect.arrayContaining([
      expect.objectContaining({ role_id: STOCK_PREP_ADMIN_ROLE_ID, user_id: rollbackUserId }),
    ]))
    expect(before.admissions).toEqual(expect.arrayContaining([
      expect.objectContaining({ namespace: 'stock-prep', user_id: rollbackUserId, enabled: true }),
    ]))
    expect(before.departmentScopes).toHaveLength(1)
    expect(before.groupScopes).toHaveLength(1)
    try {
      const revoked = await post(rolePath(rollbackUserId, 'unassign'), adminToken, { roleId: STOCK_PREP_ADMIN_ROLE_ID })
      assertError(revoked, 500, 'ROLE_UNASSIGN_FAILED')
      expect(await ownedRevokeSnapshot(rollbackUserId)).toEqual(before)
    } finally {
      await dropPermissionLifecycleAdmissionFault(runHex)
    }

    assertOk(await post(rolePath(rollbackUserId, 'unassign'), adminToken, { roleId: STOCK_PREP_ADMIN_ROLE_ID }))
    expect(await roleHeld(rollbackUserId, STOCK_PREP_ADMIN_ROLE_ID)).toBe(false)
    expect(await scopeCount(rollbackUserId, 'stock-prep')).toBe(0)
    expect(await groupScopeCount(rollbackUserId, 'stock-prep')).toBe(0)
    expect(await admissionEnabled(rollbackUserId, 'stock-prep')).toBe(false)
  })

  async function ensureSiblingScope(tree: PermissionLifecycleDirectory): Promise<void> {
    if (!(await roleHeld(raceUserId, STOCK_PREP_ADMIN_ROLE_ID))) {
      assertOk(await post(rolePath(raceUserId, 'assign'), adminToken, { roleId: STOCK_PREP_ADMIN_ROLE_ID }))
    }
    if (!(await roleHeld(raceUserId, otherAdminRoleId))) {
      assertOk(await post(rolePath(raceUserId, 'assign'), adminToken, { roleId: otherAdminRoleId }))
    }
    if ((await scopeCount(raceUserId, otherNamespace)) === 0) {
      assertOk(await post(
        `/api/admin/role-delegation/users/${raceUserId}/scopes/assign`,
        adminToken,
        { namespace: otherNamespace, directoryDepartmentId: tree.parentDepartmentId },
      ))
    }
  }

  async function expectRevokeClearsLateScopeWrite(startWrite: () => Promise<HttpResult>): Promise<void> {
    await installPermissionLifecycleScopeInsertGate(raceUserId, runHex)
    const gate = await holdScopeInsertLock(runHex)
    const pendingWrite = startWrite()
    void pendingWrite.catch(() => undefined)
    let pendingRevoke: Promise<HttpResult> | undefined
    let writerPid: number | null = null
    let writerHeldLock = false
    let revokerPid: number | null = null
    let writeResult: HttpResult | undefined
    let revokeResult: HttpResult | undefined
    try {
      writerPid = await waitForAdvisoryLockWaiterPid(gate.pid)
      if (writerPid) {
        writerHeldLock = await writerHoldsAdvisoryLockBesides(writerPid, gate.pid)
        pendingRevoke = post(rolePath(raceUserId, 'unassign'), adminToken, { roleId: STOCK_PREP_ADMIN_ROLE_ID })
        void pendingRevoke.catch(() => undefined)
        revokerPid = await waitForAdvisoryLockWaiterPid(writerPid)
      }
    } finally {
      await gate.release()
      try {
        writeResult = await pendingWrite
      } catch {
        writeResult = undefined
      }
      if (pendingRevoke) {
        try {
          revokeResult = await pendingRevoke
        } catch {
          revokeResult = undefined
        }
      }
      await dropPermissionLifecycleScopeInsertGate(runHex)
    }
    assertOk(writeResult ?? { status: 0, body: null })
    assertOk(revokeResult ?? { status: 0, body: null })
    expect(writerPid, 'scope writer did not block on the insert gate').not.toBeNull()
    expect(writerHeldLock, 'scope writer did not hold the admission lock').toBe(true)
    expect(revokerPid, 'revoke did not block on the scope writer').not.toBeNull()
    expect(await roleHeld(raceUserId, STOCK_PREP_ADMIN_ROLE_ID)).toBe(false)
    expect(await scopeCount(raceUserId, 'stock-prep')).toBe(0)
    expect(await groupScopeCount(raceUserId, 'stock-prep')).toBe(0)
    expect(await roleHeld(raceUserId, otherAdminRoleId)).toBe(true)
    expect(await scopeCount(raceUserId, otherNamespace)).toBe(1)
  }

  async function admissionLockWaitChain(rootPid: number): Promise<number[]> {
    const result = await query<{ pid: number }>(
      `WITH RECURSIVE waiters AS (
         SELECT pid, ARRAY[pid] AS path
         FROM pg_stat_activity
         WHERE datname = current_database()
           AND pid <> pg_backend_pid()
           AND $1::int = ANY(pg_blocking_pids(pid))
         UNION ALL
         SELECT activity.pid, waiters.path || activity.pid
         FROM pg_stat_activity AS activity
         JOIN waiters ON waiters.pid = ANY(pg_blocking_pids(activity.pid))
         WHERE activity.datname = current_database()
           AND activity.pid <> pg_backend_pid()
           AND NOT (activity.pid = ANY(waiters.path))
       )
       SELECT DISTINCT pid::int AS pid
       FROM waiters`,
      [rootPid],
    )
    return result.rows
      .map((row) => Number(row.pid))
      .filter((pid) => Number.isInteger(pid) && pid > 0)
  }

  async function directBlockersOf(waiterPid: number): Promise<number[]> {
    const result = await query<{ pid: number }>(
      'SELECT blocker.pid::int AS pid FROM unnest(pg_blocking_pids($1::int)) AS blocker(pid)',
      [waiterPid],
    )
    return result.rows
      .map((row) => Number(row.pid))
      .filter((pid) => Number.isInteger(pid) && pid > 0)
  }

  async function proveScopeAssignSerializedWithRevoke(
    targetUserId: string,
    order: 'actor-before-target' | 'target-before-actor',
    tree: PermissionLifecycleDirectory,
  ): Promise<void> {
    expect(order === 'actor-before-target' ? adminId < targetUserId : targetUserId < adminId).toBe(true)
    assertOk(await post(rolePath(targetUserId, 'assign'), adminToken, { roleId: STOCK_PREP_ADMIN_ROLE_ID }))
    assertOk(await patch(admissionPath(targetUserId), adminToken, { enabled: true }))
    assertOk(await post(
      `/api/admin/role-delegation/users/${targetUserId}/scopes/assign`,
      adminToken,
      { namespace: 'stock-prep', directoryDepartmentId: tree.parentDepartmentId },
    ))
    const lock = await holdNamespaceAdmissionLock(targetUserId)
    const pendingRevoke = post(rolePath(targetUserId, 'unassign'), adminToken, { roleId: STOCK_PREP_ADMIN_ROLE_ID })
    void pendingRevoke.catch(() => undefined)
    let pendingAssign: Promise<HttpResult> | undefined
    let revokePid: number | null = null
    let assignPid: number | null = null
    let witnessedChain: number[] = []
    let waitEdge: 'revoke' | 'gate' | null = null
    let revokeResult: HttpResult | undefined
    let assignResult: HttpResult | undefined
    try {
      revokePid = await waitForAdvisoryLockWaiterPid(lock.pid)
      if (revokePid) {
        pendingAssign = post(
          `/api/admin/role-delegation/users/${targetUserId}/scopes/assign`,
          adminToken,
          { namespace: 'stock-prep', directoryDepartmentId: tree.childDepartmentId },
        )
        void pendingAssign.catch(() => undefined)
        const deadline = Date.now() + 5000
        while (Date.now() < deadline && assignPid === null) {
          const chain = await admissionLockWaitChain(lock.pid)
          witnessedChain = chain
          const others = chain.filter((pid) => pid !== revokePid)
          if (!chain.includes(revokePid) || others.length !== 1 || new Set(chain).size !== 2) {
            await new Promise((resolve) => setTimeout(resolve, 25))
            continue
          }
          const candidate = others[0] ?? null
          if (candidate === null) {
            await new Promise((resolve) => setTimeout(resolve, 25))
            continue
          }
          const blockers = await directBlockersOf(candidate)
          if (order === 'actor-before-target') {
            if (blockers.includes(revokePid) && !blockers.includes(lock.pid)) {
              assignPid = candidate
              waitEdge = 'revoke'
            }
          } else {
            const directAssign = await waitForAdvisoryLockWaiterPid(lock.pid, {
              ignorePids: [revokePid],
              timeoutMs: 40,
            })
            if (directAssign === candidate && blockers.includes(lock.pid)) {
              assignPid = candidate
              waitEdge = 'gate'
            }
          }
          if (assignPid === null) await new Promise((resolve) => setTimeout(resolve, 25))
        }
      }
    } finally {
      await lock.release()
      if (pendingAssign) {
        try {
          assignResult = await pendingAssign
        } catch {
          assignResult = undefined
        }
      }
      try {
        revokeResult = await pendingRevoke
      } catch {
        revokeResult = undefined
      }
    }
    assertOk(revokeResult ?? { status: 0, body: null })
    assertError(assignResult ?? { status: 0, body: null }, 409, 'ROLE_DELEGATION_NAMESPACE_NOT_HELD')
    expect(revokePid, `${order}: revoke did not block on the admission lock`).not.toBeNull()
    expect(
      assignPid,
      `${order}: scope assign did not block on the admission lock; chain=${witnessedChain.join(',')}`,
    ).not.toBeNull()
    if (revokePid === null || assignPid === null) throw new Error(`${order}: both blocked writers must be observed`)
    expect(assignPid).not.toBe(revokePid)
    expect(new Set([revokePid, assignPid]).size).toBe(2)
    expect(witnessedChain.slice().sort((left, right) => left - right)).toEqual(
      [revokePid, assignPid].slice().sort((left, right) => left - right),
    )
    expect(waitEdge).toBe(order === 'actor-before-target' ? 'revoke' : 'gate')
    expect(await roleHeld(targetUserId, STOCK_PREP_ADMIN_ROLE_ID)).toBe(false)
    expect(await scopeCount(targetUserId, 'stock-prep')).toBe(0)
    expect(await admissionEnabled(targetUserId, 'stock-prep')).toBe(false)
  }

  it('serializes a department scope assign with revoke on that user admission lock', async () => {
    const tree = requireDirectory()
    // Actor and target admission locks are sorted. Actor-first makes the scope
    // assign a transitive waiter; target-first makes both writers direct waiters.
    await proveScopeAssignSerializedWithRevoke(actorBeforeTargetId, 'actor-before-target', tree)
    await proveScopeAssignSerializedWithRevoke(targetBeforeActorId, 'target-before-actor', tree)
  })

  it.each(['department', 'member-group', 'template'] as const)(
    'does not leave a stock-prep %s scope when revoke commits after a paused insert',
    async (kind) => {
      const tree = requireDirectory()
      await ensureSiblingScope(tree)
      if (kind === 'department') {
        await expectRevokeClearsLateScopeWrite(() => post(
          `/api/admin/role-delegation/users/${raceUserId}/scopes/assign`,
          adminToken,
          { namespace: 'stock-prep', directoryDepartmentId: tree.childDepartmentId },
        ))
        return
      }
      if (kind === 'member-group') {
        const created = await post('/api/admin/role-delegation/member-groups', adminToken, {
          name: `plc-${runHex}-race-group`,
        })
        assertOk(created)
        const groupId = groupIdFrom(created.body)
        extraGroupIds.push(groupId)
        await expectRevokeClearsLateScopeWrite(() => post(
          `/api/admin/role-delegation/users/${raceUserId}/scope-groups/assign`,
          adminToken,
          { namespace: 'stock-prep', groupId },
        ))
        return
      }
      const created = await post('/api/admin/role-delegation/scope-templates', adminToken, {
        name: `plc-${runHex}-race-template`,
      })
      assertOk(created)
      const templateId = rememberTemplateId(created.body)
      assertOk(await post(
        `/api/admin/role-delegation/scope-templates/${templateId}/departments/assign`,
        adminToken,
        { directoryDepartmentId: tree.childDepartmentId },
      ))
      await expectRevokeClearsLateScopeWrite(() => post(
        `/api/admin/role-delegation/users/${raceUserId}/scope-templates/apply`,
        adminToken,
        { namespace: 'stock-prep', templateId, mode: 'replace' },
      ))
    },
  )

  it('rolls back a template apply when a later scope insert fails', async () => {
    const tree = requireDirectory()
    assertOk(await post(rolePath(rollbackUserId, 'assign'), adminToken, { roleId: STOCK_PREP_ADMIN_ROLE_ID }))
    assertOk(await post(
      `/api/admin/role-delegation/users/${rollbackUserId}/scopes/assign`,
      adminToken,
      { namespace: 'stock-prep', directoryDepartmentId: tree.parentDepartmentId },
    ))
    const createdGroup = await post('/api/admin/role-delegation/member-groups', adminToken, {
      name: `plc-${runHex}-rollback-group`,
    })
    assertOk(createdGroup)
    const groupId = groupIdFrom(createdGroup.body)
    extraGroupIds.push(groupId)
    const createdTemplate = await post('/api/admin/role-delegation/scope-templates', adminToken, {
      name: `plc-${runHex}-rollback-template`,
    })
    assertOk(createdTemplate)
    const templateId = rememberTemplateId(createdTemplate.body)
    assertOk(await post(
      `/api/admin/role-delegation/scope-templates/${templateId}/departments/assign`,
      adminToken,
      { directoryDepartmentId: tree.childDepartmentId },
    ))
    assertOk(await post(
      `/api/admin/role-delegation/scope-templates/${templateId}/member-groups/assign`,
      adminToken,
      { groupId },
    ))
    const before = await ownedRevokeSnapshot(rollbackUserId)
    expect(before.departmentScopes).toHaveLength(1)
    expect(before.groupScopes).toHaveLength(0)
    await installPermissionLifecycleMemberGroupInsertFault(rollbackUserId, runHex)
    try {
      const applied = await post(
        `/api/admin/role-delegation/users/${rollbackUserId}/scope-templates/apply`,
        adminToken,
        { namespace: 'stock-prep', templateId, mode: 'replace' },
      )
      assertError(applied, 500, 'ROLE_DELEGATION_SCOPE_TEMPLATE_APPLY_FAILED')
      expect(await ownedRevokeSnapshot(rollbackUserId)).toEqual(before)
    } finally {
      await dropPermissionLifecycleMemberGroupInsertFault(runHex)
    }
    assertOk(await post(
      `/api/admin/role-delegation/users/${rollbackUserId}/scope-templates/apply`,
      adminToken,
      { namespace: 'stock-prep', templateId, mode: 'replace' },
    ))
    expect(await roleHeld(rollbackUserId, STOCK_PREP_ADMIN_ROLE_ID)).toBe(true)
    expect(await scopeCount(rollbackUserId, 'stock-prep')).toBe(1)
    expect(await groupScopeCount(rollbackUserId, 'stock-prep')).toBe(1)
  })

  it('serves the warmed child preflight from the same JWT and denies the first child response after the parent revoke', async () => {
    const token = mintToken(cacheUserId)
    assertOk(await post(rolePath(cacheUserId, 'assign'), adminToken, { roleId: holderRoleId }))
    assertOk(await patch(admissionPath(cacheUserId), adminToken, { enabled: true }))
    await grantDirect(cacheUserId, 'stock-prep:read')
    const child = await startPermissionCacheProbe()
    try {
      const warmed = await remotePreflight(child.baseUrl, token)
      expect(warmed.status).toBe(200)
      expectShape(warmed.body, PREFLIGHT_OK_SHAPE, 'child preflight')

      assertOk(await post(rolePath(cacheUserId, 'unassign'), adminToken, { roleId: holderRoleId }))
      const directRow = await query(
        'SELECT 1 FROM user_permissions WHERE user_id = $1 AND permission_code = $2',
        [cacheUserId, 'stock-prep:read'],
      )
      expect(directRow.rowCount).toBe(1)
      const parentAfter = await business(token)
      expect(parentAfter.status, 'same-process preflight after revoke').toBe(403)

      const childAfter = await remotePreflight(child.baseUrl, token)
      expect(childAfter.status).toBe(403)
      expect(errorCode(childAfter.body)).toBe('FORBIDDEN')
    } finally {
      await child.stop()
    }
  }, 120_000)

  it('denies the warmed child after only the direct permission is revoked and allows it again after regrant', async () => {
    const token = mintToken(directUserId)
    assertOk(await post(rolePath(directUserId, 'assign'), adminToken, { roleId: holderRoleId }))
    assertOk(await patch(admissionPath(directUserId), adminToken, { enabled: true }))
    await grantDirect(directUserId, 'stock-prep:read')
    const child = await startPermissionCacheProbe()
    try {
      const warmed = await remotePreflight(child.baseUrl, token)
      expect(warmed.status).toBe(200)
      const revoked = await request(app)
        .post('/api/permissions/revoke')
        .auth(adminToken, { type: 'bearer' })
        .send({ userId: directUserId, permission: 'stock-prep:read' })
      expect(revoked.status).toBe(200)
      expect(await roleHeld(directUserId, holderRoleId)).toBe(true)
      expect(await admissionEnabled(directUserId, 'stock-prep')).toBe(true)
      const childRevoked = await remotePreflight(child.baseUrl, token)
      expect(childRevoked.status).toBe(403)
      await grantDirect(directUserId, 'stock-prep:read')
      const childRegranted = await remotePreflight(child.baseUrl, token)
      expect(childRegranted.status).toBe(200)
    } finally {
      await child.stop()
    }
  }, 120_000)
})
