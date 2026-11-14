import { randomUUID } from 'node:crypto'
import express from 'express'
import { Client } from 'pg'
import request, { type Response } from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { authService } from '../../src/auth/AuthService'
import { query } from '../../src/db/pg'
import { adminUsersRouter } from '../../src/routes/admin-users'

// A missing DB or a general integration setup must fail before any fixtures run.
if (process.env.EXPECT_DB !== '1' || !process.env.DATABASE_URL
  || process.env.RBAC_BYPASS !== 'false' || process.env.RBAC_TOKEN_TRUST !== 'false') {
  throw new Error('Permission UX admin requires a real database and trust disabled before imports')
}
if (!/^\/admin_review_synthetic(?:_[a-z0-9_]+)?$/.test(new URL(process.env.DATABASE_URL).pathname)) {
  throw new Error('Permission UX admin requires a dedicated synthetic review database')
}

const app = express()
app.use(express.json())
app.use(adminUsersRouter())

const runId = randomUUID().replaceAll('-', '').slice(0, 12)
const prefix = `ux-admin-${runId}`
const ownedUsers: string[] = []
const ownedRoles: string[] = []
const ownedIntegrations: string[] = []
const ownedGroups: string[] = []
const ownedTemplates: string[] = []
const roleVersion = '2026-01-02T03:04:05.000Z'
let platformId: string
let stockRole: string
let attendanceRole: string

type Capability = {
  isPlatformAdmin: boolean
  canManageScope: boolean
  canManagePermissions: boolean
  delegableNamespaces: string[]
}
type Candidate = { id: string; name: string; selectable?: boolean; disabledReason?: string }
type Access = { manageableNamespaces: string[]; roleCatalog: Array<{ id: string }>; delegableRoles: string[] }
type Directory = { integrationId: string; orgId: string; corpId: string; parentId: string; childId: string; outsideId: string }
type Audience = { directory: Directory; actorId: string; parentUserId: string; childUserId: string; outsideUserId: string }

function payload<T>(response: Response): T {
  return response.body.data as T
}

function expectStatus(response: Response, status: number): void {
  // Do not echo response bodies: admin create returns temporary passwords.
  const code = String(response.body?.error?.code || 'none')
  expect(response.status, `HTTP status; error code ${code}`).toBe(status)
}

function token(userId: string, tenantId?: string): string {
  // Deliberately optimistic claims: every request must resolve live DB authority.
  return authService.createToken({
    id: userId,
    email: `${userId}@example.test`,
    name: 'Synthetic user',
    role: 'admin',
    permissions: ['admin:all', 'roles:write'],
    created_at: new Date(),
    updated_at: new Date(),
    ...(tenantId ? { tenantId } : {}),
  })
}

function get(actorId: string, path: string, tenantId?: string) {
  return request(app).get(path).auth(token(actorId, tenantId), { type: 'bearer' })
}

function post(actorId: string, path: string, body: Record<string, unknown>, tenantId?: string) {
  return request(app).post(path).auth(token(actorId, tenantId), { type: 'bearer' }).send(body)
}

async function seedUser(options: { role?: string; roles?: string[]; isAdmin?: boolean; orgs?: string[] } = {}): Promise<string> {
  const id = randomUUID()
  ownedUsers.push(id)
  await query(
    `INSERT INTO users(id, username, email, name, password_hash, role, is_admin, is_active, activation_status)
     VALUES ($1, $1, $2, $3, 'synthetic-only', $4, $5, TRUE, 'activated')`,
    [id, `${id}@example.test`, `${prefix}-${id}`, options.role || 'user', options.isAdmin || false],
  )
  for (const role of options.roles || ['user']) {
    await query('INSERT INTO user_roles(user_id, role_id) VALUES ($1, $2)', [id, role])
  }
  for (const org of options.orgs || []) await admitOrg(id, org)
  return id
}

async function admitOrg(userId: string, orgId: string): Promise<void> {
  await query(
    `INSERT INTO user_orgs(user_id, org_id, is_active) VALUES ($1, $2, TRUE)
     ON CONFLICT(user_id, org_id) DO UPDATE SET is_active = TRUE`, [userId, orgId],
  )
}

async function seedRole(namespace: string, code: string): Promise<string> {
  const roleId = `${namespace}_ux${runId}_${randomUUID().slice(0, 8)}`
  ownedRoles.push(roleId)
  await query('INSERT INTO roles(id, name, updated_at) VALUES ($1, $1, $2)', [roleId, roleVersion])
  await query('INSERT INTO permissions(code, name) VALUES ($1, $1) ON CONFLICT DO NOTHING', [code])
  await query('INSERT INTO role_permissions(role_id, permission_code) VALUES ($1, $2)', [roleId, code])
  return roleId
}

async function directory(orgId = `${prefix}-${randomUUID().slice(0, 8)}`): Promise<Directory> {
  const integrationId = randomUUID()
  const corpId = `corp-${integrationId}`
  const parentId = randomUUID()
  const childId = randomUUID()
  const outsideId = randomUUID()
  ownedIntegrations.push(integrationId)
  await query(
    `INSERT INTO directory_integrations(id, org_id, provider, name, status, corp_id, sync_enabled)
     VALUES ($1, $2, 'dingtalk', $3, 'active', $4, FALSE)`,
    [integrationId, orgId, `${prefix}-${integrationId}`, corpId],
  )
  for (const [id, parent] of [[parentId, null], [childId, parentId], [outsideId, null]]) {
    await query(
      `INSERT INTO directory_departments(id, integration_id, provider, external_department_id,
         external_parent_department_id, name, is_active)
       VALUES ($1::uuid, $2, 'dingtalk', $1::text, $3, $4, TRUE)`,
      [id, integrationId, parent, `${prefix}-${id}`],
    )
  }
  return { integrationId, orgId, corpId, parentId, childId, outsideId }
}

async function link(directory: Directory, userId: string, departmentId: string, options: { corpId?: string | null; provider?: string } = {}): Promise<string> {
  const accountId = randomUUID()
  await query(
    `INSERT INTO directory_accounts(id, integration_id, provider, corp_id, external_user_id, external_key, name, is_active)
     VALUES ($1::uuid, $2, $3, $4, $1::text, $1::text, $5, TRUE)`,
    [accountId, directory.integrationId, options.provider || 'dingtalk', options.corpId === undefined ? directory.corpId : options.corpId, `${prefix}-${userId}`],
  )
  await query(
    `INSERT INTO directory_account_links(directory_account_id, local_user_id, link_status, match_strategy)
     VALUES ($1, $2, 'linked', 'manual')`, [accountId, userId],
  )
  await query(
    'INSERT INTO directory_account_departments(directory_account_id, directory_department_id, is_primary) VALUES ($1, $2, TRUE)',
    [accountId, departmentId],
  )
  return accountId
}

async function audience(): Promise<Audience> {
  const d = await directory()
  const actorId = await seedUser({ roles: ['stock-prep_admin'], orgs: [d.orgId] })
  const parentUserId = await seedUser({ orgs: [d.orgId] })
  const childUserId = await seedUser({ orgs: [d.orgId] })
  const outsideUserId = await seedUser({ orgs: [d.orgId] })
  await link(d, parentUserId, d.parentId)
  await link(d, childUserId, d.childId)
  await link(d, outsideUserId, d.outsideId)
  return { directory: d, actorId, parentUserId, childUserId, outsideUserId }
}

async function assignScope(actorId: string, departmentId: string, includeChildren?: unknown, namespace = 'stock-prep'): Promise<Response> {
  return post(platformId, `/api/admin/role-delegation/users/${actorId}/scopes/assign`, {
    namespace, directoryDepartmentId: departmentId,
    ...(includeChildren === undefined ? {} : { includeChildren }),
  })
}

async function candidates(actorId: string, includeIneligible = false, tenantId?: string): Promise<Response> {
  return get(actorId, `/api/admin/role-delegation/users?pageSize=100&q=${prefix}${includeIneligible ? '&includeIneligible=true' : ''}`, tenantId)
}

async function allowedIds(actorId: string, tenantId?: string): Promise<string[]> {
  const response = await candidates(actorId, false, tenantId)
  expectStatus(response, 200)
  return payload<{ items: Candidate[] }>(response).items.map(item => item.id)
}

async function expectDeniedTarget(actorId: string, userId: string, tenantId?: string): Promise<void> {
  expectStatus(await get(actorId, `/api/admin/role-delegation/users/${userId}/access`, tenantId), 403)
  expectStatus(await post(actorId, `/api/admin/role-delegation/users/${userId}/roles/assign`, { roleId: stockRole }, tenantId), 403)
  expect((await query('SELECT 1 FROM user_roles WHERE user_id = $1 AND role_id = $2', [userId, stockRole])).rows).toEqual([])
}

async function memberGroup(actorId: string, userIds: string[], namespace = 'stock-prep'): Promise<string> {
  const groupId = randomUUID()
  ownedGroups.push(groupId)
  await query('INSERT INTO platform_member_groups(id, name) VALUES ($1, $2)', [groupId, `${prefix}-${groupId}`])
  for (const userId of userIds) {
    expectStatus(await post(platformId, `/api/admin/role-delegation/users/${userId}/member-groups/assign`, { groupId }), 200)
  }
  expectStatus(await post(platformId, `/api/admin/role-delegation/users/${actorId}/scope-groups/assign`, { namespace, groupId }), 200)
  return groupId
}

async function template(departmentId: string, includeChildren?: unknown): Promise<string> {
  const response = await post(platformId, '/api/admin/role-delegation/scope-templates', { name: `${prefix}-${randomUUID()}` })
  expectStatus(response, 200)
  const templateId = payload<{ item: { id: string } }>(response).item.id
  ownedTemplates.push(templateId)
  expectStatus(await post(platformId, `/api/admin/role-delegation/scope-templates/${templateId}/departments/assign`, {
    directoryDepartmentId: departmentId,
    ...(includeChildren === undefined ? {} : { includeChildren }),
  }), 200)
  return templateId
}

const EXACT_DEPARTMENT_FLAG = 'DELEGATED_SCOPE_EXACT_DEPARTMENT_ENABLED'

async function withExactDepartmentFlag<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const previous = process.env[EXACT_DEPARTMENT_FLAG]
  if (value === undefined) delete process.env[EXACT_DEPARTMENT_FLAG]
  else process.env[EXACT_DEPARTMENT_FLAG] = value
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env[EXACT_DEPARTMENT_FLAG]
    else process.env[EXACT_DEPARTMENT_FLAG] = previous
  }
}

function withExactDepartmentEnabled<T>(fn: () => Promise<T>): Promise<T> {
  return withExactDepartmentFlag('true', fn)
}

async function createTemplateShell(): Promise<string> {
  const response = await post(platformId, '/api/admin/role-delegation/scope-templates', { name: `${prefix}-${randomUUID()}` })
  expectStatus(response, 200)
  const templateId = payload<{ item: { id: string } }>(response).item.id
  ownedTemplates.push(templateId)
  return templateId
}

async function scopeBits(adminUserId: string): Promise<Array<{ namespace: string; directory_department_id: string; include_children: boolean }>> {
  return (await query<{ namespace: string; directory_department_id: string; include_children: boolean }>(
    `SELECT namespace, directory_department_id::text, include_children
     FROM delegated_role_admin_scopes
     WHERE admin_user_id = $1
     ORDER BY namespace, directory_department_id`,
    [adminUserId],
  )).rows
}

async function templateDepartmentBits(templateId: string): Promise<Array<{ directory_department_id: string; include_children: boolean }>> {
  return (await query<{ directory_department_id: string; include_children: boolean }>(
    `SELECT directory_department_id::text, include_children
     FROM delegated_role_scope_template_departments
     WHERE template_id = $1
     ORDER BY directory_department_id`,
    [templateId],
  )).rows
}

async function templateUpdatedAt(templateId: string): Promise<string> {
  const row = (await query<{ updated_at: Date | string }>(
    'SELECT updated_at FROM delegated_role_scope_templates WHERE id = $1',
    [templateId],
  )).rows[0]
  return new Date(row.updated_at).toISOString()
}

async function waitUntilBlocked(blockerPid: number): Promise<void> {
  const deadline = Date.now() + 10000
  let waiting = false
  while (Date.now() < deadline && !waiting) {
    waiting = (await query<{ count: number }>(
      'SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))',
      [blockerPid],
    )).rows[0].count > 0
    if (!waiting) await new Promise(resolve => setTimeout(resolve, 20))
  }
  expect(waiting).toBe(true)
}

async function assertAttendanceBlocked(userId: string): Promise<void> {
  expect((await query(
    "SELECT enabled FROM user_namespace_admissions WHERE user_id = $1 AND namespace = 'attendance'", [userId],
  )).rows).toEqual([{ enabled: false }])
  const priorMode = process.env.PRODUCT_MODE
  try {
    for (const mode of ['attendance', 'platform']) {
      process.env.PRODUCT_MODE = mode
      const profile = await authService.verifyToken(token(userId))
      expect(profile).not.toBeNull()
      expect(profile?.permissions.some(code => code.startsWith('attendance:'))).toBe(false)
      expect((await query(
        "SELECT role_id FROM user_roles WHERE user_id = $1 AND role_id = 'attendance_employee'", [userId],
      )).rows).toEqual([])
    }
  } finally {
    if (priorMode === undefined) delete process.env.PRODUCT_MODE
    else process.env.PRODUCT_MODE = priorMode
  }
}

beforeAll(async () => {
  expect((await query('SELECT count(*)::int AS count FROM users')).rows).toEqual([{ count: 0 }])
  await query(`INSERT INTO roles(id, name) VALUES ('admin', 'Synthetic admin'), ('user', 'Synthetic user'),
    ('stock-prep_admin', 'Synthetic stock admin'), ('attendance_admin', 'Synthetic attendance admin') ON CONFLICT DO NOTHING`)
  platformId = await seedUser({ role: 'admin', roles: ['admin'] })
  stockRole = await seedRole('stock-prep', 'stock-prep:read')
  attendanceRole = await seedRole('attendance', 'attendance:read')
})

afterAll(async () => {
  // Only this file's UUIDs are touched; never truncate shared tables or reset the schema.
  await query('DELETE FROM delegated_role_scope_templates WHERE id = ANY($1::uuid[])', [ownedTemplates])
  await query('DELETE FROM platform_member_groups WHERE id = ANY($1::uuid[])', [ownedGroups])
  await query('DELETE FROM directory_integrations WHERE id = ANY($1::uuid[])', [ownedIntegrations])
  await query('DELETE FROM delegated_role_admin_scopes WHERE admin_user_id = ANY($1::text[])', [ownedUsers])
  await query('DELETE FROM delegated_role_admin_member_groups WHERE admin_user_id = ANY($1::text[])', [ownedUsers])
  await query('DELETE FROM user_roles WHERE user_id = ANY($1::text[])', [ownedUsers])
  await query('DELETE FROM user_permissions WHERE user_id = ANY($1::text[])', [ownedUsers])
  await query('DELETE FROM user_orgs WHERE user_id = ANY($1::text[])', [ownedUsers])
  await query('DELETE FROM user_namespace_admissions WHERE user_id = ANY($1::text[])', [ownedUsers])
  await query('DELETE FROM user_invites WHERE user_id = ANY($1::text[])', [ownedUsers])
  await query('DELETE FROM users WHERE id = ANY($1::text[])', [ownedUsers])
  await query('DELETE FROM role_permissions WHERE role_id = ANY($1::text[])', [ownedRoles])
  await query('DELETE FROM roles WHERE id = ANY($1::text[])', [ownedRoles])
})

describe('permission UX admin through production routes and real PostgreSQL', () => {
  it('requires the migrated schema and trust-off process without skipped database tests', async () => {
    expect(process.env.EXPECT_DB).toBe('1')
    expect(process.env.RBAC_BYPASS).toBe('false')
    expect(process.env.RBAC_TOKEN_TRUST).toBe('false')
    const columns = await query<{ table_name: string; is_nullable: string }>(
      `SELECT table_name, is_nullable FROM information_schema.columns WHERE table_schema = 'public'
       AND column_name = 'include_children' AND table_name IN ('delegated_role_admin_scopes', 'delegated_role_scope_template_departments')`,
    )
    expect(columns.rows).toHaveLength(2)
    expect(columns.rows.every(row => row.is_nullable === 'NO')).toBe(true)
  })

  it('separates live platform authority, RBAC permission authority, and misleading claims or is_admin flags', async () => {
    const cases = [
      { options: { role: 'admin' }, platform: true, permissions: false },
      { options: { roles: ['admin'] }, platform: true, permissions: true },
      { options: { isAdmin: true }, platform: false, permissions: false },
      { options: {}, platform: false, permissions: false },
    ]
    for (const item of cases) {
      const userId = await seedUser(item.options)
      const response = await get(userId, '/api/admin/access-capabilities')
      expectStatus(response, 200)
      expect(payload<Capability>(response)).toMatchObject({
        isPlatformAdmin: item.platform, canManageScope: item.platform,
        canManagePermissions: item.permissions, delegableNamespaces: [],
      })
    }
    const writerId = await seedUser()
    for (const code of ['roles:write', 'permissions:write']) {
      await query('INSERT INTO permissions(code, name) VALUES ($1, $1) ON CONFLICT DO NOTHING', [code])
      await query('INSERT INTO user_permissions(user_id, permission_code) VALUES ($1, $2)', [writerId, code])
    }
    const writer = await get(writerId, '/api/admin/access-capabilities')
    expectStatus(writer, 200)
    expect(payload<Capability>(writer)).toMatchObject({ isPlatformAdmin: false, canManageScope: false, canManagePermissions: false })
  })

  it('shows scope management with no audience, lists no candidates, and refuses target detail and writes', async () => {
    const actorId = await seedUser({ roles: ['stock-prep_admin'] })
    const targetId = await seedUser()
    const response = await get(actorId, '/api/admin/access-capabilities')
    expectStatus(response, 200)
    expect(payload<Capability>(response)).toMatchObject({
      isPlatformAdmin: false, canManageScope: true, canManagePermissions: false, delegableNamespaces: ['stock-prep'],
    })
    const listed = await candidates(actorId)
    expectStatus(listed, 200)
    expect(payload<{ items: Candidate[] }>(listed).items).toEqual([])
    await expectDeniedTarget(actorId, targetId)
  })

  it('rejects inactive, pending, recycled and purged accounts and gives no authority to a missing account', async () => {
    for (const mutation of [
      'UPDATE users SET is_active = FALSE WHERE id = $1',
      "UPDATE users SET activation_status = 'pending_activation' WHERE id = $1",
      'UPDATE users SET deleted_at = NOW() WHERE id = $1',
      'UPDATE users SET deleted_at = NOW(), purged_at = NOW() WHERE id = $1',
    ]) {
      const actorId = await seedUser({ role: 'admin', roles: ['admin'] })
      await query(mutation, [actorId])
      expectStatus(await get(actorId, '/api/admin/access-capabilities'), 401)
    }
    const missing = await get(randomUUID(), '/api/admin/access-capabilities')
    // NODE_ENV=test has a missing-user development fallback in AuthService. The
    // capability route must independently require a live row even in that mode.
    expectStatus(missing, 200)
    expect(payload<Capability>(missing)).toMatchObject({
      isPlatformAdmin: false, canManageScope: false, canManagePermissions: false, delegableNamespaces: [],
    })
  })

  it('advertises explicit admission and derives namespace metadata from stored roles and presets', async () => {
    const roles = await get(platformId, '/api/admin/roles')
    const presets = await get(platformId, '/api/admin/access-presets')
    expectStatus(roles, 200)
    expectStatus(presets, 200)
    expect(payload<{ capabilities: { explicitNamespaceAdmission: boolean } }>(presets).capabilities.explicitNamespaceAdmission).toBe(true)
    const catalog = payload<{ items: Array<{ id: string; admissionNamespaces: string[]; updatedAt: string }> }>(roles).items
    expect(catalog.find(role => role.id === attendanceRole)).toMatchObject({ admissionNamespaces: ['attendance'], updatedAt: roleVersion })
    expect(catalog.find(role => role.id === stockRole)).toMatchObject({ admissionNamespaces: ['stock-prep'] })
    const presetItems = payload<{ items: Array<{ id: string; admissionNamespaces: string[] }> }>(presets).items
    expect(presetItems.length).toBeGreaterThan(0)
    expect(presetItems.find(item => item.id === 'attendance-employee')?.admissionNamespaces).toEqual(['attendance'])
  })

  it.each(['single', 'batch'] as const)('%s create defaults to explicit attendance denial and profile reads cannot bootstrap it', async route => {
    for (const admission of [undefined, []]) {
      const email = `${randomUUID()}@example.test`
      const body = { email, name: `${prefix}-created`, roleId: admission ? attendanceRole : 'user', ...(admission ? { admissionNamespaces: admission } : {}) }
      const response = route === 'single'
        ? await post(platformId, '/api/admin/users', body)
        : await post(platformId, '/api/admin/users/batch/create', { items: [body] })
      expectStatus(response, 200)
      const rows = await query<{ id: string }>('SELECT id FROM users WHERE email = $1', [email])
      expect(rows.rows).toHaveLength(1)
      ownedUsers.push(rows.rows[0].id)
      if (route === 'batch') expect(payload<{ successCount: number }>(response).successCount).toBe(1)
      await assertAttendanceBlocked(rows.rows[0].id)
    }
  })

  it('explicit supported admission enables the selected role namespace while unrelated admission is refused without creating a user', async () => {
    // Explicit opt-in belongs to single create; batch has no admission checkbox.
    const email = `${randomUUID()}@example.test`
    const created = await post(platformId, '/api/admin/users', {
      email, name: `${prefix}-admitted`, roleId: attendanceRole, admissionNamespaces: ['attendance'],
    })
    expectStatus(created, 200)
    const userId = (await query<{ id: string }>('SELECT id FROM users WHERE email = $1', [email])).rows[0]?.id
    if (!userId) throw new Error('Create did not persist the synthetic identity')
    ownedUsers.push(userId)
    expect((await query("SELECT enabled FROM user_namespace_admissions WHERE user_id = $1 AND namespace = 'attendance'", [userId])).rows).toEqual([{ enabled: true }])
    const deniedEmail = `${randomUUID()}@example.test`
    const denied = await post(platformId, '/api/admin/users', {
      email: deniedEmail, name: `${prefix}-denied`, roleId: attendanceRole, admissionNamespaces: ['stock-prep'],
    })
    expectStatus(denied, 400)
    expect((await query('SELECT id FROM users WHERE email = $1', [deniedEmail])).rows).toEqual([])
  })

  it('rejects malformed admission lists before creating any identity', async () => {
    for (const admissionNamespaces of ['attendance', {}, [123]]) {
      const email = `${randomUUID()}@example.test`
      expectStatus(await post(platformId, '/api/admin/users', {
        email, name: `${prefix}-malformed`, roleId: attendanceRole, admissionNamespaces,
      }), 400)
      expect((await query('SELECT id FROM users WHERE email = $1', [email])).rows).toEqual([])
    }
  })

  it.each(['attendance', 'platform'])('negative control: an old missing-admission account really bootstraps in %s mode', async mode => {
    const userId = await seedUser()
    expect((await query('SELECT 1 FROM user_namespace_admissions WHERE user_id = $1', [userId])).rows).toEqual([])
    const priorMode = process.env.PRODUCT_MODE
    try {
      process.env.PRODUCT_MODE = mode
      const profile = await authService.verifyToken(token(userId))
      expect(profile?.permissions).toEqual(expect.arrayContaining(['attendance:read', 'attendance:write']))
      expect((await query("SELECT role_id FROM user_roles WHERE user_id = $1 AND role_id = 'attendance_employee'", [userId])).rows).toEqual([{ role_id: 'attendance_employee' }])
    } finally {
      if (priorMode === undefined) delete process.env.PRODUCT_MODE
      else process.env.PRODUCT_MODE = priorMode
    }
  })

  it('compares the catalog version on assign, rejects stale or null stored versions, and permits omission', async () => {
    const roleId = await seedRole('stock-prep', 'stock-prep:read')
    const userId = await seedUser()
    const path = `/api/admin/users/${userId}/roles/assign`
    expectStatus(await post(platformId, path, { roleId, expectedUpdatedAt: '2025-01-01T00:00:00.000Z' }), 409)
    expectStatus(await post(platformId, path, { roleId, expectedUpdatedAt: roleVersion }), 200)
    await query('DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2', [userId, roleId])
    const nullable = (await query<{ is_nullable: string }>(
      "SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'roles' AND column_name = 'updated_at'",
    )).rows[0].is_nullable === 'YES'
    // A fresh migrated schema is NOT NULL. Temporarily model an older nullable
    // column in this exclusively owned synthetic DB, then restore the constraint.
    if (!nullable) await query('ALTER TABLE roles ALTER COLUMN updated_at DROP NOT NULL')
    try {
      await query('UPDATE roles SET updated_at = NULL WHERE id = $1', [roleId])
      const stale = await post(platformId, path, { roleId, expectedUpdatedAt: roleVersion })
      expectStatus(stale, 409)
      expect(stale.body.error.code).toBe('ROLE_MODIFIED')
      expect((await query('SELECT 1 FROM user_roles WHERE user_id = $1 AND role_id = $2', [userId, roleId])).rows).toEqual([])
      expectStatus(await post(platformId, path, { roleId }), 200)
    } finally {
      await query('UPDATE roles SET updated_at = $2 WHERE id = $1', [roleId, roleVersion])
      if (!nullable) await query('ALTER TABLE roles ALTER COLUMN updated_at SET NOT NULL')
    }
  })

  it('rejects every supplied non-string or empty version on both platform and delegated assign routes', async () => {
    const a = await audience()
    expectStatus(await assignScope(a.actorId, a.directory.parentId), 200)
    for (const expectedUpdatedAt of [null, '', 123, {}, [], 'not-an-iso-timestamp']) {
      for (const actor of [platformId, a.actorId]) {
        const path = actor === platformId ? `/api/admin/users/${a.parentUserId}/roles/assign`
          : `/api/admin/role-delegation/users/${a.parentUserId}/roles/assign`
        expectStatus(await post(actor, path, { roleId: stockRole, expectedUpdatedAt }), 400)
      }
    }
    expect((await query('SELECT 1 FROM user_roles WHERE user_id = $1 AND role_id = $2', [a.parentUserId, stockRole])).rows).toEqual([])
  })

  it('rechecks the role version after waiting for the actual PostgreSQL role row lock', async () => {
    const roleId = await seedRole('stock-prep', 'stock-prep:read')
    const userId = await seedUser()
    const blocker = new Client({ connectionString: process.env.DATABASE_URL })
    let pending: Promise<Response> | undefined
    await blocker.connect()
    await blocker.query('BEGIN')
    try {
      const pid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid
      await blocker.query('SELECT id FROM roles WHERE id = $1 FOR UPDATE', [roleId])
      pending = Promise.resolve(post(platformId, `/api/admin/users/${userId}/roles/assign`, { roleId, expectedUpdatedAt: roleVersion }))
      let waiting = false
      const deadline = Date.now() + 10000
      while (Date.now() < deadline && !waiting) {
        waiting = (await query<{ count: number }>(
          'SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))', [pid],
        )).rows[0].count > 0
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 20))
      }
      expect(waiting).toBe(true)
      await blocker.query("UPDATE roles SET updated_at = '2026-02-03T04:05:06.000Z' WHERE id = $1", [roleId])
      await blocker.query('COMMIT')
      expectStatus(await pending, 409)
      expect((await query('SELECT 1 FROM user_roles WHERE user_id = $1 AND role_id = $2', [userId, roleId])).rows).toEqual([])
    } finally {
      await blocker.query('ROLLBACK')
      await pending
      await blocker.end()
    }
  })

  it('direct department scope defaults true, persists false, excludes descendants, and rejects malformed booleans', async () => {
    const a = await audience()
    await withExactDepartmentEnabled(async () => {
      expectStatus(await assignScope(a.actorId, a.directory.parentId, false), 200)
      expect(await allowedIds(a.actorId)).toEqual([a.parentUserId])
      await expectDeniedTarget(a.actorId, a.childUserId)
      // Omitted includeChildren widens a stored false only while the flag is on.
      expectStatus(await assignScope(a.actorId, a.directory.parentId), 200)
    })
    expect((await allowedIds(a.actorId)).sort()).toEqual([a.parentUserId, a.childUserId].sort())
    for (const includeChildren of [null, 'false', 0, {}]) {
      expectStatus(await assignScope(a.actorId, a.directory.parentId, includeChildren), 400)
    }
    expect((await query('SELECT include_children FROM delegated_role_admin_scopes WHERE admin_user_id = $1', [a.actorId])).rows).toEqual([{ include_children: true }])
  })

  it.each(['merge', 'replace'])('scope template %s carries false and updates the same department when changed back to true', async mode => {
    const a = await audience()
    expectStatus(await withExactDepartmentEnabled(() => assignScope(a.actorId, a.directory.outsideId, false)), 200)
    const templateId = await withExactDepartmentEnabled(() => template(a.directory.parentId, false))
    const apply = () => post(platformId, `/api/admin/role-delegation/users/${a.actorId}/scope-templates/apply`, { namespace: 'stock-prep', templateId, mode })
    expectStatus(await withExactDepartmentEnabled(() => apply()), 200)
    const retained = mode === 'merge' ? [a.outsideUserId] : []
    expect((await allowedIds(a.actorId)).sort()).toEqual([a.parentUserId, ...retained].sort())
    expectStatus(await post(platformId, `/api/admin/role-delegation/scope-templates/${templateId}/departments/assign`, { directoryDepartmentId: a.directory.parentId, includeChildren: true }), 200)
    expectStatus(await apply(), 200)
    expect((await allowedIds(a.actorId)).sort()).toEqual([a.parentUserId, a.childUserId, ...retained].sort())
    for (const includeChildren of [null, 'true', 1, {}]) {
      expectStatus(await post(platformId, `/api/admin/role-delegation/scope-templates/${templateId}/departments/assign`, { directoryDepartmentId: a.directory.parentId, includeChildren }), 400)
    }
    const defaultTemplate = await template(a.directory.childId)
    expect((await query('SELECT include_children FROM delegated_role_scope_template_departments WHERE template_id = $1', [defaultTemplate])).rows).toEqual([{ include_children: true }])
  })

  it('unions overlapping department scopes without losing an independently selected child or duplicating a candidate', async () => {
    const a = await audience()
    expectStatus(await withExactDepartmentEnabled(() => assignScope(a.actorId, a.directory.parentId, false)), 200)
    expectStatus(await withExactDepartmentEnabled(() => assignScope(a.actorId, a.directory.childId, false)), 200)
    expect((await allowedIds(a.actorId)).sort()).toEqual([a.parentUserId, a.childUserId].sort())
    expectStatus(await assignScope(a.actorId, a.directory.parentId, true), 200)
    const ids = await allowedIds(a.actorId)
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
  })

  it('supports member-group-only authority and falls back to authorized rows without inventing a tenant-wide grey directory', async () => {
    const actorId = await seedUser({ roles: ['stock-prep_admin'] })
    const targetId = await seedUser()
    const outsiderId = await seedUser()
    await memberGroup(actorId, [targetId])
    expect(await allowedIds(actorId)).toEqual([targetId])
    const grey = await candidates(actorId, true)
    expectStatus(grey, 200)
    expect(payload<{ items: Candidate[] }>(grey).items.map(item => item.id)).toEqual([targetId])
    expectStatus(await post(actorId, `/api/admin/role-delegation/users/${targetId}/roles/assign`, { roleId: stockRole }), 200)
    await expectDeniedTarget(actorId, outsiderId)
  })

  it('filters manageableNamespaces, assignable roles and revocable roles per target while platform catalogs stay complete', async () => {
    const a = await audience()
    const wrongSeparatorRole = await seedRole('stock-prepXviewer', 'stock-prep:read')
    await query('INSERT INTO user_roles(user_id, role_id) VALUES ($1, $2)', [a.actorId, 'attendance_admin'])
    await query('INSERT INTO user_roles(user_id, role_id) VALUES ($1, $2), ($1, $3), ($1, $4)', [a.parentUserId, stockRole, attendanceRole, wrongSeparatorRole])
    expectStatus(await withExactDepartmentEnabled(() => assignScope(a.actorId, a.directory.parentId, false)), 200)
    expectStatus(await withExactDepartmentEnabled(() => assignScope(a.actorId, a.directory.outsideId, false, 'attendance')), 200)
    const access = await get(a.actorId, `/api/admin/role-delegation/users/${a.parentUserId}/access`)
    expectStatus(access, 200)
    expect(payload<Access>(access).manageableNamespaces).toEqual(['stock-prep'])
    expect(payload<Access>(access).roleCatalog.map(role => role.id)).toContain(stockRole)
    expect(payload<Access>(access).roleCatalog.map(role => role.id)).not.toContain(attendanceRole)
    expect(payload<Access>(access).roleCatalog.map(role => role.id)).not.toContain(wrongSeparatorRole)
    expect(payload<Access>(access).delegableRoles).toContain(stockRole)
    expect(payload<Access>(access).delegableRoles).not.toContain(attendanceRole)
    expect(payload<Access>(access).delegableRoles).not.toContain(wrongSeparatorRole)
    const otherAccess = await get(a.actorId, `/api/admin/role-delegation/users/${a.outsideUserId}/access`)
    expectStatus(otherAccess, 200)
    expect(payload<Access>(otherAccess).manageableNamespaces).toEqual(['attendance'])
    const assigned = await post(a.actorId, `/api/admin/role-delegation/users/${a.parentUserId}/roles/assign`, { roleId: stockRole })
    expectStatus(assigned, 200)
    expect(payload<Access>(assigned).manageableNamespaces).toEqual(['stock-prep'])
    expect(payload<Access>(assigned).roleCatalog.map(role => role.id)).not.toContain(attendanceRole)
    for (const action of ['assign', 'unassign']) {
      expectStatus(await post(a.actorId, `/api/admin/role-delegation/users/${a.parentUserId}/roles/${action}`, { roleId: attendanceRole }), 403)
    }
    const platform = await get(platformId, `/api/admin/role-delegation/users/${a.parentUserId}/access`)
    expectStatus(platform, 200)
    expect(payload<Access>(platform).roleCatalog.map(role => role.id)).toEqual(expect.arrayContaining([stockRole, attendanceRole, wrongSeparatorRole]))
    expect(payload<Access>(platform).delegableRoles).toEqual(expect.arrayContaining([stockRole, attendanceRole, wrongSeparatorRole]))
  })

  it('adds only minimal grey candidates within the proven tenant and refuses their detail and mutation routes', async () => {
    const a = await audience()
    expectStatus(await withExactDepartmentEnabled(() => assignScope(a.actorId, a.directory.parentId, false)), 200)
    const hidden = await candidates(a.actorId)
    expect(payload<{ items: Candidate[] }>(hidden).items.map(item => item.id)).not.toContain(a.outsideUserId)
    const response = await candidates(a.actorId, true)
    expectStatus(response, 200)
    const grey = payload<{ items: Candidate[] }>(response).items.find(item => item.id === a.outsideUserId)
    expect(grey).toBeDefined()
    expect(Object.keys(grey || {}).sort()).toEqual(['disabledReason', 'id', 'name', 'selectable'])
    expect(grey?.selectable).toBe(false)
    expect(typeof grey?.disabledReason).toBe('string')
    expect(grey?.disabledReason?.length).toBeGreaterThan(0)
    await expectDeniedTarget(a.actorId, a.outsideUserId)
  })

  it('classifies an authorized user once across multiple linked accounts, including when that user is on another page', async () => {
    const a = await audience()
    expectStatus(await withExactDepartmentEnabled(() => assignScope(a.actorId, a.directory.parentId, false)), 200)
    await link(a.directory, a.parentUserId, a.directory.outsideId)
    const secondId = await seedUser({ orgs: [a.directory.orgId] })
    await link(a.directory, secondId, a.directory.parentId)
    await link(a.directory, secondId, a.directory.outsideId)
    const other = await directory()
    await admitOrg(a.actorId, other.orgId)
    const crossOrgId = await seedUser({ orgs: [a.directory.orgId, other.orgId] })
    await link(other, crossOrgId, other.parentId)
    await link(a.directory, crossOrgId, a.directory.outsideId)
    // Isolated raw authority fixture: existing authorized scope spans configured
    // integrations, whereas tenant A only bounds the NEW grey expansion. The
    // exclusion must use that whole authorized set, not just tenant A's seeds.
    await query(
      `INSERT INTO delegated_role_admin_scopes(admin_user_id, namespace, directory_department_id, include_children, created_by)
       VALUES ($1, 'stock-prep', $2, FALSE, $3)`, [a.actorId, other.parentId, platformId],
    )
    const marker = `${prefix}-dual-${randomUUID().slice(0, 8)}`
    const authorizedIds = [a.parentUserId, secondId, crossOrgId]
    await query('UPDATE users SET name = $2 WHERE id = ANY($1::text[])', [authorizedIds, marker])

    const base = `/api/admin/role-delegation/users?q=${marker}`
    const all = await get(a.actorId, `${base}&pageSize=100&includeIneligible=true`, a.directory.orgId)
    expectStatus(all, 200)
    const allItems = payload<{ items: Candidate[] }>(all).items
    expect(allItems.map(item => item.id).sort()).toEqual(authorizedIds.slice().sort())
    expect(allItems.some(item => item.selectable === false)).toBe(false)

    const first = await get(a.actorId, `${base}&pageSize=1&page=1`, a.directory.orgId)
    const second = await get(a.actorId, `${base}&pageSize=1&page=2`, a.directory.orgId)
    expectStatus(first, 200)
    expectStatus(second, 200)
    const firstItems = payload<{ items: Candidate[] }>(first).items
    const secondItems = payload<{ items: Candidate[] }>(second).items
    expect(firstItems).toHaveLength(1)
    expect(secondItems).toHaveLength(1)
    expect(firstItems[0].id).not.toBe(secondItems[0].id)
    const pageWithGrey = await get(a.actorId, `${base}&pageSize=1&page=1&includeIneligible=true`, a.directory.orgId)
    expectStatus(pageWithGrey, 200)
    const pageItems = payload<{ items: Candidate[] }>(pageWithGrey).items
    const offPageIds = authorizedIds.filter(id => id !== firstItems[0].id)
    expect(pageItems.some(item => offPageIds.includes(item.id) && item.selectable === false)).toBe(false)
    expect(new Set(pageItems.map(item => item.id)).size).toBe(pageItems.length)
  })

  it('does not expand grey candidates across org, corp or integration, including a separately shared second org', async () => {
    const a = await audience()
    const other = await directory()
    await admitOrg(a.actorId, other.orgId)
    expectStatus(await assignScope(a.actorId, a.directory.parentId, true), 200)
    const wrongOrg = await seedUser({ orgs: [other.orgId] })
    await link(a.directory, wrongOrg, a.directory.outsideId)
    const wrongCorp = await seedUser({ orgs: [a.directory.orgId] })
    await link(a.directory, wrongCorp, a.directory.outsideId, { corpId: `other-${runId}` })
    const nullCorp = await seedUser({ orgs: [a.directory.orgId] })
    await link(a.directory, nullCorp, a.directory.outsideId, { corpId: null })
    const wrongIntegration = await seedUser({ orgs: [a.directory.orgId, other.orgId] })
    await link(other, wrongIntegration, a.directory.outsideId)
    const wrongProvider = await seedUser({ orgs: [a.directory.orgId] })
    await link(a.directory, wrongProvider, a.directory.outsideId, { provider: 'local' })
    // These targets are genuinely outside the existing authorized department set.
    // The stricter directory/org/corp proof gates NEW grey expansion only; this
    // test does not claim to change the pre-existing authorized scope policy.
    const response = await candidates(a.actorId, true, a.directory.orgId)
    expectStatus(response, 200)
    const ids = payload<{ items: Candidate[] }>(response).items.map(item => item.id)
    for (const userId of [wrongOrg, wrongCorp, nullCorp, wrongIntegration, wrongProvider]) {
      expect(ids).not.toContain(userId)
      await expectDeniedTarget(a.actorId, userId, a.directory.orgId)
    }
    expect(ids).toContain(a.parentUserId)
  })

  it('binds grey expansion to authenticated tenant membership while unproven context preserves only authorized rows', async () => {
    const a = await audience()
    expectStatus(await assignScope(a.actorId, a.directory.parentId), 200)
    expect((await allowedIds(a.actorId)).sort()).toEqual([a.parentUserId, a.childUserId].sort())
    const other = await directory()
    await admitOrg(a.actorId, other.orgId)
    const forged = await get(a.actorId, `/api/admin/role-delegation/users?pageSize=100&q=${prefix}&includeIneligible=true`).set('x-tenant-id', a.directory.orgId)
    // Ambiguous memberships cannot turn a header into proof of a tenant-wide catalogue.
    expectStatus(forged, 200)
    const items = payload<{ items: Candidate[] }>(forged).items
    expect(items.map(item => item.id).sort()).toEqual([a.parentUserId, a.childUserId].sort())
    expect(items.filter(item => item.selectable === false)).toEqual([])
    const bound = await get(a.actorId, `/api/admin/role-delegation/users?pageSize=100&q=${prefix}&includeIneligible=true`, a.directory.orgId).set('x-tenant-id', other.orgId)
    expectStatus(bound, 200)
    expect(payload<{ items: Candidate[] }>(bound).items.map(item => item.id)).toContain(a.outsideUserId)
  })

  it('requires active scope departments, integrations and matching actor/candidate org memberships for grey expansion', async () => {
    const a = await audience()
    expectStatus(await withExactDepartmentEnabled(() => assignScope(a.actorId, a.directory.parentId, false)), 200)
    for (const [disable, restore, params] of [
      ["UPDATE directory_integrations SET status = 'disabled' WHERE id = $1", "UPDATE directory_integrations SET status = 'active' WHERE id = $1", [a.directory.integrationId]],
      ['UPDATE directory_departments SET is_active = FALSE WHERE id = $1', 'UPDATE directory_departments SET is_active = TRUE WHERE id = $1', [a.directory.parentId]],
      ["UPDATE directory_departments SET provider = 'local' WHERE id = $1", "UPDATE directory_departments SET provider = 'dingtalk' WHERE id = $1", [a.directory.parentId]],
      ['UPDATE user_orgs SET is_active = FALSE WHERE user_id = $1', 'UPDATE user_orgs SET is_active = TRUE WHERE user_id = $1', [a.outsideUserId]],
      ['UPDATE user_orgs SET is_active = FALSE WHERE user_id = $1', 'UPDATE user_orgs SET is_active = TRUE WHERE user_id = $1', [a.actorId]],
    ] as Array<[string, string, string[]]>) {
      await query(disable, params)
      try {
        const response = await candidates(a.actorId, true)
        if (response.status === 200) expect(payload<{ items: Candidate[] }>(response).items.map(item => item.id)).not.toContain(a.outsideUserId)
        else expectStatus(response, 403)
        await expectDeniedTarget(a.actorId, a.outsideUserId)
      } finally {
        await query(restore, params)
      }
    }
    const restored = await candidates(a.actorId, true)
    expectStatus(restored, 200)
    expect(payload<{ items: Candidate[] }>(restored).items.map(item => item.id)).toContain(a.outsideUserId)
  })

  it('refuses exact-department writes for every non-exact flag and allows only byte-exact true', async () => {
    const a = await audience()
    expectStatus(await assignScope(a.actorId, a.directory.outsideId, true), 200)
    const templateId = await createTemplateShell()
    await query(
      `INSERT INTO delegated_role_scope_template_departments(template_id, directory_department_id, include_children)
       VALUES ($1, $2, FALSE)`,
      [templateId, a.directory.parentId],
    )
    const beforeScopes = await scopeBits(a.actorId)
    const beforeDepartments = await templateDepartmentBits(templateId)
    const beforeStamp = await templateUpdatedAt(templateId)

    for (const value of [undefined, '1', 'TRUE', ' true ', 'true '] as const) {
      await withExactDepartmentFlag(value, async () => {
        const direct = await assignScope(a.actorId, a.directory.parentId, false)
        expectStatus(direct, 403)
        expect(direct.body.error.code).toBe('DELEGATED_SCOPE_EXACT_DEPARTMENT_DISABLED')
        expect(direct.body.error.message).toBe('Exact department scope is disabled')

        const added = await post(platformId, `/api/admin/role-delegation/scope-templates/${templateId}/departments/assign`, {
          directoryDepartmentId: a.directory.childId,
          includeChildren: false,
        })
        expectStatus(added, 403)
        expect(added.body.error.code).toBe('DELEGATED_SCOPE_EXACT_DEPARTMENT_DISABLED')

        for (const mode of ['merge', 'replace']) {
          const applied = await post(platformId, `/api/admin/role-delegation/users/${a.actorId}/scope-templates/apply`, {
            namespace: 'stock-prep',
            templateId,
            mode,
          })
          expectStatus(applied, 403)
          expect(applied.body.error.code).toBe('DELEGATED_SCOPE_EXACT_DEPARTMENT_DISABLED')
        }
      })
      expect(await scopeBits(a.actorId)).toEqual(beforeScopes)
      expect(await templateDepartmentBits(templateId)).toEqual(beforeDepartments)
      expect(await templateUpdatedAt(templateId)).toBe(beforeStamp)
    }

    await withExactDepartmentFlag('true', async () => {
      expectStatus(await assignScope(a.actorId, a.directory.parentId, false), 200)
      expectStatus(await post(platformId, `/api/admin/role-delegation/scope-templates/${templateId}/departments/assign`, {
        directoryDepartmentId: a.directory.childId,
        includeChildren: false,
      }), 200)
      expectStatus(await post(platformId, `/api/admin/role-delegation/users/${a.actorId}/scope-templates/apply`, {
        namespace: 'stock-prep',
        templateId,
        mode: 'merge',
      }), 200)
      expectStatus(await post(platformId, `/api/admin/role-delegation/users/${a.actorId}/scope-templates/apply`, {
        namespace: 'stock-prep',
        templateId,
        mode: 'replace',
      }), 200)
    })
    const exactIds = [a.directory.childId, a.directory.parentId].sort()
    expect(await scopeBits(a.actorId)).toEqual(exactIds.map(id => ({
      namespace: 'stock-prep',
      directory_department_id: id,
      include_children: false,
    })))
    expect(await templateDepartmentBits(templateId)).toEqual(exactIds.map(id => ({
      directory_department_id: id,
      include_children: false,
    })))
  })

  it('keeps a stored false exact after the flag is off, preserves an omitted write, and still allows true and unassign', async () => {
    const a = await audience()
    await query(
      `INSERT INTO delegated_role_admin_scopes(admin_user_id, namespace, directory_department_id, include_children, created_by)
       VALUES ($1, 'stock-prep', $2, FALSE, $3)`,
      [a.actorId, a.directory.parentId, platformId],
    )
    expect(await allowedIds(a.actorId)).toEqual([a.parentUserId])
    await expectDeniedTarget(a.actorId, a.childUserId)
    const listed = await get(platformId, `/api/admin/role-delegation/users/${a.actorId}/scopes`)
    expectStatus(listed, 200)
    expect(payload<{ scopeAssignments: Array<{ directoryDepartmentId: string; includeChildren: boolean }> }>(listed).scopeAssignments).toEqual([
      expect.objectContaining({ directoryDepartmentId: a.directory.parentId, includeChildren: false }),
    ])

    await withExactDepartmentFlag(undefined, async () => {
      expectStatus(await assignScope(a.actorId, a.directory.parentId), 200)
    })
    expect(await scopeBits(a.actorId)).toEqual([{
      namespace: 'stock-prep',
      directory_department_id: a.directory.parentId,
      include_children: false,
    }])
    expect(await allowedIds(a.actorId)).toEqual([a.parentUserId])

    expectStatus(await assignScope(a.actorId, a.directory.parentId, true), 200)
    expect((await allowedIds(a.actorId)).sort()).toEqual([a.parentUserId, a.childUserId].sort())

    await query(
      `UPDATE delegated_role_admin_scopes SET include_children = FALSE
       WHERE admin_user_id = $1 AND directory_department_id = $2`,
      [a.actorId, a.directory.parentId],
    )
    const removed = await post(platformId, `/api/admin/role-delegation/users/${a.actorId}/scopes/unassign`, {
      namespace: 'stock-prep',
      directoryDepartmentId: a.directory.parentId,
      includeChildren: false,
    })
    expectStatus(removed, 200)
    expect(await scopeBits(a.actorId)).toEqual([])
    expect(await allowedIds(a.actorId)).toEqual([])
  })

  it('rejects malformed includeChildren while the exact-department flag is on', async () => {
    const a = await audience()
    const templateId = await createTemplateShell()
    await withExactDepartmentFlag('true', async () => {
      for (const includeChildren of [null, 'false', 0, {}]) {
        expectStatus(await assignScope(a.actorId, a.directory.parentId, includeChildren), 400)
        expectStatus(await post(platformId, `/api/admin/role-delegation/scope-templates/${templateId}/departments/assign`, {
          directoryDepartmentId: a.directory.parentId,
          includeChildren,
        }), 400)
      }
    })
    expect(await scopeBits(a.actorId)).toEqual([])
    expect(await templateDepartmentBits(templateId)).toEqual([])
  })

  it('template department edits wait on the parent row, and a refused exact write does not move updated_at', async () => {
    const a = await audience()
    const templateId = await template(a.directory.parentId)
    const before = await templateUpdatedAt(templateId)
    const beforeDepartments = await templateDepartmentBits(templateId)
    const blocker = new Client({ connectionString: process.env.DATABASE_URL })
    let refusedPromise: Promise<Response> | undefined
    let pending: Promise<Response> | undefined
    const previousExact = process.env[EXACT_DEPARTMENT_FLAG]
    delete process.env[EXACT_DEPARTMENT_FLAG]
    await blocker.connect()
    await blocker.query('BEGIN')
    try {
      const pid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid
      await blocker.query('SELECT id FROM delegated_role_scope_templates WHERE id = $1 FOR UPDATE', [templateId])
      refusedPromise = Promise.resolve(post(platformId, `/api/admin/role-delegation/scope-templates/${templateId}/departments/assign`, {
        directoryDepartmentId: a.directory.childId,
        includeChildren: false,
      }))
      const refused = await Promise.race([
        refusedPromise.then(response => response),
        new Promise<Response | 'timeout'>(resolve => setTimeout(() => resolve('timeout'), 5000)),
      ])
      expect(refused).not.toBe('timeout')
      if (refused !== 'timeout') {
        expectStatus(refused, 403)
        expect(refused.body.error.code).toBe('DELEGATED_SCOPE_EXACT_DEPARTMENT_DISABLED')
      }
      expect(await templateUpdatedAt(templateId)).toBe(before)
      expect(await templateDepartmentBits(templateId)).toEqual(beforeDepartments)
      expect((await query<{ count: number }>(
        'SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))',
        [pid],
      )).rows[0].count).toBe(0)

      pending = Promise.resolve(post(platformId, `/api/admin/role-delegation/scope-templates/${templateId}/departments/assign`, {
        directoryDepartmentId: a.directory.parentId,
        includeChildren: true,
      }))
      await waitUntilBlocked(pid)
      expect(await templateUpdatedAt(templateId)).toBe(before)
      await blocker.query('COMMIT')
      const written = await pending
      pending = undefined
      expectStatus(written, 200)
      expect(await templateUpdatedAt(templateId)).not.toBe(before)
      expect(await templateDepartmentBits(templateId)).toEqual(beforeDepartments)
    } finally {
      if (previousExact === undefined) delete process.env[EXACT_DEPARTMENT_FLAG]
      else process.env[EXACT_DEPARTMENT_FLAG] = previousExact
      await blocker.query('ROLLBACK')
      if (pending) await pending
      if (refusedPromise) await refusedPromise
      await blocker.end()
    }
  })

  it('apply waits, re-reads a committed exact department, and does not delete when that write is refused', async () => {
    const a = await audience()
    expectStatus(await assignScope(a.actorId, a.directory.outsideId, true), 200)
    const before = await scopeBits(a.actorId)
    const templateId = await template(a.directory.parentId)
    const blocker = new Client({ connectionString: process.env.DATABASE_URL })
    let pending: Promise<Response> | undefined
    const previousExact = process.env[EXACT_DEPARTMENT_FLAG]
    delete process.env[EXACT_DEPARTMENT_FLAG]
    await blocker.connect()
    await blocker.query('BEGIN')
    try {
      const pid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid
      await blocker.query('SELECT id FROM delegated_role_scope_templates WHERE id = $1 FOR UPDATE', [templateId])
      pending = Promise.resolve(post(platformId, `/api/admin/role-delegation/users/${a.actorId}/scope-templates/apply`, {
        namespace: 'stock-prep',
        templateId,
        mode: 'replace',
      }))
      await waitUntilBlocked(pid)
      await blocker.query(
        `UPDATE delegated_role_scope_template_departments
         SET include_children = FALSE
         WHERE template_id = $1 AND directory_department_id = $2`,
        [templateId, a.directory.parentId],
      )
      await blocker.query('COMMIT')
      const response = await pending
      pending = undefined
      expectStatus(response, 403)
      expect(response.body.error.code).toBe('DELEGATED_SCOPE_EXACT_DEPARTMENT_DISABLED')
      expect(await scopeBits(a.actorId)).toEqual(before)
    } finally {
      if (previousExact === undefined) delete process.env[EXACT_DEPARTMENT_FLAG]
      else process.env[EXACT_DEPARTMENT_FLAG] = previousExact
      await blocker.query('ROLLBACK')
      if (pending) await pending
      await blocker.end()
    }
  })

  it('apply keeps the committed true snapshot when a concurrent exact change rolls back', async () => {
    const a = await audience()
    const templateId = await template(a.directory.parentId)
    const blocker = new Client({ connectionString: process.env.DATABASE_URL })
    let pending: Promise<Response> | undefined
    await blocker.connect()
    await blocker.query('BEGIN')
    try {
      const pid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid
      await blocker.query('SELECT id FROM delegated_role_scope_templates WHERE id = $1 FOR UPDATE', [templateId])
      await blocker.query(
        `UPDATE delegated_role_scope_template_departments
         SET include_children = FALSE
         WHERE template_id = $1 AND directory_department_id = $2`,
        [templateId, a.directory.parentId],
      )
      pending = Promise.resolve(post(platformId, `/api/admin/role-delegation/users/${a.actorId}/scope-templates/apply`, {
        namespace: 'stock-prep',
        templateId,
        mode: 'replace',
      }))
      await waitUntilBlocked(pid)
      await blocker.query('ROLLBACK')
      const response = await pending
      pending = undefined
      expectStatus(response, 200)
      expect(await scopeBits(a.actorId)).toEqual([{
        namespace: 'stock-prep',
        directory_department_id: a.directory.parentId,
        include_children: true,
      }])
    } finally {
      await blocker.query('ROLLBACK')
      if (pending) await pending
      await blocker.end()
    }
  })

  it.each(['departments', 'member-groups'])('%s edits lock the actor before the template and serialize with apply across updated_by owners', async (kind) => {
    const a = await audience()
    const otherAdminId = await seedUser({ role: 'admin', roles: ['admin'] })
    const templateId = await template(a.directory.parentId)
    await query('UPDATE delegated_role_scope_templates SET updated_by = $2 WHERE id = $1', [templateId, otherAdminId])
    const groupId = randomUUID()
    ownedGroups.push(groupId)
    await query('INSERT INTO platform_member_groups(id, name) VALUES ($1, $2)', [groupId, `${prefix}-${groupId}`])
    const blocker = new Client({ connectionString: process.env.DATABASE_URL })
    let edit: Promise<Response> | undefined
    let apply: Promise<Response> | undefined
    await blocker.connect()
    await blocker.query('BEGIN')
    try {
      const pid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid
      await blocker.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [platformId])
      edit = Promise.resolve(post(platformId, `/api/admin/role-delegation/scope-templates/${templateId}/${kind}/assign`,
        kind === 'departments'
          ? { directoryDepartmentId: a.directory.childId, includeChildren: true }
          : { groupId },
      ))
      await waitUntilBlocked(pid)
      const waiting = await query<{ pid: number }>(
        'SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))',
        [pid],
      )
      expect(waiting.rows).toHaveLength(1)
      // The old editor held this row while its updated_by FK waited for our user
      // lock. NOWAIT is the negative witness: old order raises 55P03 here.
      await blocker.query('SELECT id FROM delegated_role_scope_templates WHERE id = $1 FOR UPDATE NOWAIT', [templateId])
      apply = Promise.resolve(post(platformId, `/api/admin/role-delegation/users/${a.actorId}/scope-templates/apply`, {
        namespace: 'stock-prep', templateId, mode: 'replace',
      }))
      // Apply must wait on the editor's admission lock, not acquire the actor
      // and wait for an already-held template in the opposite order.
      await waitUntilBlocked(waiting.rows[0].pid)
      await blocker.query('COMMIT')
      const [edited, applied] = await Promise.all([edit, apply])
      edit = undefined
      apply = undefined
      expectStatus(edited, 200)
      expectStatus(applied, 200)
      expect((await query('SELECT updated_by FROM delegated_role_scope_templates WHERE id = $1', [templateId])).rows)
        .toEqual([{ updated_by: platformId }])
      const expectedDepartments = kind === 'departments'
        ? [a.directory.parentId, a.directory.childId].sort()
        : [a.directory.parentId]
      expect(await scopeBits(a.actorId)).toEqual(expectedDepartments.map(id => ({
        namespace: 'stock-prep', directory_department_id: id, include_children: true,
      })))
      expect((await query(
        'SELECT group_id::text FROM delegated_role_admin_member_groups WHERE admin_user_id = $1', [a.actorId],
      )).rows).toEqual(kind === 'member-groups' ? [{ group_id: groupId }] : [])
    } finally {
      await blocker.query('ROLLBACK')
      await Promise.allSettled([edit, apply].filter((pending): pending is Promise<Response> => pending !== undefined))
      await blocker.end()
    }
  })

  it('apply persists the exact department committed while it waited for the parent lock', async () => {
    const a = await audience()
    const templateId = await template(a.directory.parentId)
    const blocker = new Client({ connectionString: process.env.DATABASE_URL })
    let pending: Promise<Response> | undefined
    const previous = process.env[EXACT_DEPARTMENT_FLAG]
    process.env[EXACT_DEPARTMENT_FLAG] = 'true'
    await blocker.connect()
    await blocker.query('BEGIN')
    try {
      const pid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid
      await blocker.query('SELECT id FROM delegated_role_scope_templates WHERE id = $1 FOR UPDATE', [templateId])
      pending = Promise.resolve(post(platformId, `/api/admin/role-delegation/users/${a.actorId}/scope-templates/apply`, {
        namespace: 'stock-prep',
        templateId,
        mode: 'replace',
      }))
      await waitUntilBlocked(pid)
      await blocker.query(
        `UPDATE delegated_role_scope_template_departments
         SET include_children = FALSE
         WHERE template_id = $1 AND directory_department_id = $2`,
        [templateId, a.directory.parentId],
      )
      await blocker.query('COMMIT')
      const response = await pending
      pending = undefined
      expectStatus(response, 200)
      expect(await scopeBits(a.actorId)).toEqual([{
        namespace: 'stock-prep',
        directory_department_id: a.directory.parentId,
        include_children: false,
      }])
    } finally {
      if (previous === undefined) delete process.env[EXACT_DEPARTMENT_FLAG]
      else process.env[EXACT_DEPARTMENT_FLAG] = previous
      await blocker.query('ROLLBACK')
      if (pending) await pending
      await blocker.end()
    }
  })
})
