import { restorePermissionLifecycleEnv } from '../utils/permission-lifecycle-setup'
import { createRequire } from 'node:module'
import { randomBytes, randomUUID } from 'node:crypto'
import express, { type RequestHandler } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { authService } from '../../src/auth/AuthService'
import { query, transaction } from '../../src/db/pg'
import { authenticate } from '../../src/middleware/auth'
import {
  findObjectSheet,
  type MultitableProvisioningQueryFn,
} from '../../src/multitable/provisioning'
import { inspectUserPermissionGrants, listUserPermissions } from '../../src/rbac/service'
import { adminUsersRouter } from '../../src/routes/admin-users'

if (process.env.RBAC_BYPASS !== 'false' || process.env.RBAC_TOKEN_TRUST !== 'false') {
  throw new Error('permission lifecycle suite requires RBAC_BYPASS=false and RBAC_TOKEN_TRUST=false')
}
if (process.env.PRODUCT_MODE !== 'plm-workbench') {
  throw new Error('permission lifecycle suite requires PRODUCT_MODE=plm-workbench')
}
if (process.env.EXPECT_DB === '1' && !process.env.DATABASE_URL) {
  throw new Error('EXPECT_DB=1 but DATABASE_URL is missing; refusing a skip-shaped green')
}

const BUSINESS_PATH = '/api/integration/stock-preparation/preflight'
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
const orgId = `lc-${runHex}`
const adminId = randomUUID()
const subjectId = randomUUID()
const targetId = randomUUID()
const outsiderId = randomUUID()
const ownedUserIds = [adminId, subjectId, targetId, outsiderId]

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

function assertStatus(result: HttpResult, status: number): void {
  expect(result.status, JSON.stringify(result.body)).toBe(status)
}

function assertError(result: HttpResult, status: number, code: string): void {
  assertStatus(result, status)
  expect(errorCode(result.body)).toBe(code)
}

function assertOk(result: HttpResult): void {
  assertStatus(result, 200)
  if (!isRecord(result.body) || result.body.ok !== true) {
    throw new Error(`expected an ok envelope, received ${JSON.stringify(result.body)}`)
  }
}

const app = express()
app.use(express.json())
app.use(adminUsersRouter())

const require = createRequire(import.meta.url)
const loaded = require('../../../../plugins/plugin-integration-core/lib/http-routes.cjs') as {
  registerIntegrationRoutes?: (input: {
    context: {
      api: {
        multitable: {
          provisioning: {
            findObjectSheet: (input: { projectId: string; objectId: string }) => Promise<unknown>
            resolveFieldIds: () => never
            ensureObject: () => never
          }
        }
        http: {
          addRoute: (method: string, path: string, handler: RequestHandler) => void
        }
      }
    }
    services: Record<string, unknown>
  }) => void
}

if (typeof loaded.registerIntegrationRoutes !== 'function') {
  throw new Error('registerIntegrationRoutes export is missing')
}

const inert: object = new Proxy({}, {
  get(): () => never {
    return () => {
      throw new Error('unexpected synthetic service call')
    }
  },
})

const services: Record<string, unknown> = {}
for (const name of [
  'externalSystemRegistry',
  'adapterRegistry',
  'pipelineRegistry',
  'pipelineRunner',
  'deadLetterStore',
  'stagingInstaller',
  'templateRegistry',
  'readSourceConfigStore',
  'readSourceCompositionConfigStore',
  'bridgeAgentChecklistStore',
]) {
  services[name] = inert
}

const provisioningQuery: MultitableProvisioningQueryFn = async (sql, params) => {
  const result = await query(sql, params)
  return { rows: result.rows, rowCount: result.rowCount }
}

loaded.registerIntegrationRoutes({
  context: {
    api: {
      multitable: {
        provisioning: {
          findObjectSheet: ({ projectId, objectId }) => findObjectSheet(provisioningQuery, projectId, objectId),
          resolveFieldIds: () => {
            throw new Error('unexpected existing object')
          },
          ensureObject: () => {
            throw new Error('unexpected write')
          },
        },
      },
      http: {
        addRoute: (method, path, handler) => {
          if (method.toUpperCase() === 'GET' && path === BUSINESS_PATH) {
            app.get(path, authenticate, handler)
          }
        },
      },
    },
  },
  services,
})

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

async function business(): Promise<HttpResult> {
  const response = await request(app).get(BUSINESS_PATH).auth(subjectToken, { type: 'bearer' })
  const result: HttpResult = { status: response.status, body: response.body }
  if (result.status === 403) {
    expect(result.body).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  }
  if (result.status === 200) {
    expect(result.body).toMatchObject({
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
    })
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
    throw new Error(`member group response did not include data.item: ${JSON.stringify(body)}`)
  }
  const id = body.data.item.id
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`member group response did not include data.item.id: ${JSON.stringify(body)}`)
  }
  return id
}

async function cleanupOwnedFixtures(): Promise<void> {
  await transaction(async (client) => {
    await client.query('DELETE FROM role_permissions WHERE role_id = $1', [operatorRoleId])
    await client.query(
      `DELETE FROM user_roles
        WHERE user_id::text = ANY($1::text[])
           OR role_id = $2`,
      [ownedUserIds, operatorRoleId],
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
    await client.query(
      'DELETE FROM delegated_role_admin_scopes WHERE admin_user_id::text = ANY($1::text[])',
      [ownedUserIds],
    )
    if (ownedGroupId) {
      await client.query(
        `DELETE FROM delegated_role_admin_member_groups
          WHERE admin_user_id::text = ANY($1::text[])
             OR group_id::text = $2`,
        [ownedUserIds, ownedGroupId],
      )
      await client.query(
        `DELETE FROM platform_member_group_members
          WHERE user_id::text = ANY($1::text[])
             OR group_id::text = $2`,
        [ownedUserIds, ownedGroupId],
      )
      await client.query('DELETE FROM platform_member_groups WHERE id::text = $1', [ownedGroupId])
    } else {
      await client.query(
        'DELETE FROM delegated_role_admin_member_groups WHERE admin_user_id::text = ANY($1::text[])',
        [ownedUserIds],
      )
      await client.query(
        'DELETE FROM platform_member_group_members WHERE user_id::text = ANY($1::text[])',
        [ownedUserIds],
      )
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
    if (ownedGroupId) {
      auditResourceIds.push(
        `group:${ownedGroupId}`,
        `${ownedGroupId}:${adminId}`,
        `${ownedGroupId}:${subjectId}`,
        `${ownedGroupId}:${targetId}`,
        `${ownedGroupId}:${outsiderId}`,
        `${subjectId}:stock-prep:group:${ownedGroupId}`,
      )
    }
    await client.query(
      `DELETE FROM audit_logs
        WHERE resource_id = ANY($1::text[])
           OR action_details->>'userId' = ANY($2::text[])
           OR action_details->>'adminUserId' = ANY($2::text[])
           OR action_details->>'groupId' = ANY($3::text[])
           OR action_details->>'roleId' = $4
           OR action_details->>'operatorRoleId' = $4`,
      [auditResourceIds, ownedUserIds, ownedGroupId ? [ownedGroupId] : [], operatorRoleId],
    )
    await client.query('DELETE FROM users WHERE id::text = ANY($1::text[])', [ownedUserIds])
    await client.query(
      'DELETE FROM roles WHERE id = $1 AND NOT (id = ANY($2::text[]))',
      [operatorRoleId, [...PROTECTED_ROLE_IDS]],
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

    for (const id of ownedUserIds) {
      const isPlatformAdmin = id === adminId
      await query(
        `INSERT INTO users (
           id, username, email, name, password_hash, role, is_admin, is_active,
           activation_status, must_change_password, local_password_set
         ) VALUES ($1, $1, $2, 'synthetic', 'synthetic', $3, $4, true, 'activated', false, true)`,
        [id, `${id}@example.test`, isPlatformAdmin ? 'admin' : 'user', isPlatformAdmin],
      )
    }
    await query(
      'INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)',
      [adminId, 'admin'],
    )
    await query(
      'INSERT INTO roles (id, name) VALUES ($1, $2)',
      [operatorRoleId, `lifecycle ${runHex}`],
    )
    await query(
      'INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, $2)',
      [operatorRoleId, 'stock-prep:read'],
    )
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
})
