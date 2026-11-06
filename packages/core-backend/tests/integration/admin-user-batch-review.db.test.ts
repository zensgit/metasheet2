import { randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { Client } from 'pg'
import { beforeAll, describe, expect, it } from 'vitest'
import { authService } from '../../src/auth/AuthService'

import { query } from '../../src/db/pg'
import { isAdmin } from '../../src/rbac/service'
import { adminUsersRouter } from '../../src/routes/admin-users'
import { attendanceAdminRouter } from '../../src/routes/attendance-admin'
import { authenticate } from '../../src/middleware/auth'
import { applyRecycleMove, applyRecyclePurge, isLastSignInPlatformAdmin, lockPlatformAdminInvariant } from '../../src/admin/user-recycle'
import { lockNamespaceAdmissionWrites } from '../../src/rbac/namespace-admission'

const app = express()
app.use(express.json())
app.use(adminUsersRouter())
app.use('/api/attendance-admin', authenticate)
app.use(attendanceAdminRouter())

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL || 'invalid:')
  expect(process.env.EXPECT_DB).toBe('1')
  expect(url.pathname).toMatch(/^\/admin_review_synthetic(?:_[a-z0-9_]+)?$/)
  process.env.RBAC_BYPASS = 'false'
  process.env.RBAC_TOKEN_TRUST = 'false'
  await query("INSERT INTO roles(id, name) VALUES ('admin', 'Synthetic admin'), ('user', 'Synthetic user') ON CONFLICT DO NOTHING")
})

async function seedUser(admin = false) {
  const userId = `batch_review_${randomUUID()}`
  await query(
    `INSERT INTO users(id, username, email, name, password_hash, role, is_admin, is_active, activation_status)
     VALUES ($1, $1, $2, 'Synthetic user', 'synthetic-only', $3, $4, TRUE, 'activated')`,
    [userId, `${userId}@example.test`, admin ? 'admin' : 'user', admin],
  )
  await query('INSERT INTO user_roles(user_id, role_id) VALUES ($1, $2)', [userId, admin ? 'admin' : 'user'])
  return userId
}

async function seedDeprovision(userId: string, actorId: string) {
  const integrationId = randomUUID()
  const accountId = randomUUID()
  const eventId = randomUUID()
  await query(
    `INSERT INTO directory_integrations(id, org_id, provider, name, corp_id, sync_enabled)
     VALUES ($1::uuid, 'default', 'dingtalk', $1::text, $1::text, FALSE)`,
    [integrationId],
  )
  await query(
    `INSERT INTO directory_accounts(id, integration_id, provider, corp_id, external_user_id, external_key, name, is_active)
     VALUES ($1::uuid, $2::uuid, 'dingtalk', $2::text, $1::text, $1::text, 'Synthetic user', FALSE)`,
    [accountId, integrationId],
  )
  await query(
    `INSERT INTO directory_account_links(directory_account_id, local_user_id, link_status)
     VALUES ($1, $2, 'linked')`, [accountId, userId],
  )
  await query('UPDATE users SET is_active = FALSE WHERE id = $1', [userId])
  await query(
    `INSERT INTO directory_deprovision_events(id, org_id, integration_id, directory_account_id,
       local_user_id, triggered_by, event_origin, link_witness_account_id, link_witness_local_user_id,
       policy, globally_clear, access_generation_at_apply, status)
     VALUES ($1, 'default', $2, $3, $4, $5, 'admin_manual', $3, $4, 'mark_inactive', TRUE, 0, 'applied')`,
    [eventId, integrationId, accountId, userId, actorId],
  )
  await query(
    `INSERT INTO directory_deprovision_effects(event_id, local_user_id, effect_type, before_active,
       after_active, access_generation_at_apply, status)
     VALUES ($1, $2, 'user_changed', TRUE, FALSE, 0, 'applied')`, [eventId, userId],
  )
  return eventId
}

function token(userId: string) {
  return authService.createToken({ id: userId, email: `${userId}@example.test`, name: 'Synthetic user', role: 'admin', permissions: [], created_at: new Date(), updated_at: new Date() })
}

function update(actorId: string, items: Array<Record<string, unknown>>) {
  return request(app).post('/api/admin/users/batch/update').auth(token(actorId), { type: 'bearer' }).send({ items })
}

describe('batch review regressions against migrated synthetic PostgreSQL', () => {
  it('keeps the last admin through delegation and simultaneous delegation/platform demotions', async () => {
    expect((await query('SELECT count(*)::int AS count FROM users')).rows[0].count).toBe(0)
    const firstId = await seedUser(true)
    const pendingBackup = await seedUser(true)
    const disabledBackup = await seedUser(true)
    await query("UPDATE users SET activation_status = 'pending_activation' WHERE id = $1", [pendingBackup])
    await query("UPDATE users SET role = 'disabled' WHERE id = $1", [disabledBackup])
    const demote = (actorId: string, userId: string, delegated: boolean) => request(app)
      .post(delegated ? `/api/admin/role-delegation/users/${userId}/roles/unassign` : `/api/admin/users/${userId}/roles/unassign`)
      .auth(token(actorId), { type: 'bearer' }).send({ roleId: 'admin' }).then(response => response)
    const refused = await demote(firstId, firstId, true)
    expect(refused.status).toBe(409)
    expect(refused.body.error.code).toBe('LAST_PLATFORM_ADMIN')
    expect(await isAdmin(firstId)).toBe(true)
    const legacy = new Client({ connectionString: process.env.DATABASE_URL })
    await legacy.connect()
    await legacy.query('BEGIN')
    try {
      await legacy.query('ALTER TABLE users ALTER COLUMN role DROP NOT NULL')
      await legacy.query('UPDATE users SET role = NULL WHERE id = $1', [firstId])
      expect(await isLastSignInPlatformAdmin(legacy, firstId)).toBe(true)
    } finally {
      await legacy.query('ROLLBACK')
      await legacy.end()
    }

    const secondId = await seedUser(true)
    const blocker = new Client({ connectionString: process.env.DATABASE_URL })
    await blocker.connect()
    await blocker.query('BEGIN')
    try {
      await lockPlatformAdminInvariant(blocker)
      const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      const first = demote(firstId, secondId, true)
      const second = demote(secondId, firstId, false)
      await waitForBlockedBy(pid, 2)
      await blocker.query('COMMIT')
      const results = await Promise.all([first, second])
      expect(results.map(result => result.status).sort()).toEqual([200, 409])
      expect(results.find(result => result.status === 409)!.body.error.code).toBe('LAST_PLATFORM_ADMIN')
      const rows = (await query('SELECT id, role, is_admin FROM users WHERE id = ANY($1::text[]) ORDER BY id', [[firstId, secondId]])).rows
      expect(rows.filter(row => row.is_admin)).toHaveLength(1)
      for (const row of rows) {
        const held = (await query("SELECT 1 FROM user_roles WHERE user_id = $1 AND role_id = 'admin'", [row.id])).rows.length > 0
        expect(row.role === 'admin').toBe(held)
        expect(row.is_admin).toBe(held)
      }
    } finally {
      await blocker.query('ROLLBACK')
      await blocker.end()
    }
  })

  it.each(['create', 'update', 'disable', 'delete'])('rejects a non-administrator at the production batch %s gate', async (operation) => {
    const actorId = await seedUser()
    const targetId = await seedUser()
    const before = await query('SELECT name, email, department, is_active, access_generation FROM users WHERE id = $1', [targetId])
    const response = await request(app).post(`/api/admin/users/batch/${operation}`)
      .auth(token(actorId), { type: 'bearer' })
      .send({ items: [{ userId: targetId, email: `${targetId}@example.test`, name: 'Forbidden', department: 'Forbidden' }], userIds: [targetId], isActive: false })
    expect(response.status).toBe(403)
    expect((await query('SELECT name, email, department, is_active, access_generation FROM users WHERE id = $1', [targetId])).rows).toEqual(before.rows)
  })

  it('replaces admin membership and denies subsequent administrator writes', async () => {
    const actorId = await seedUser(true)
    const targetId = await seedUser(true)
    expect(await isAdmin(targetId)).toBe(true)
    const result = await update(actorId, [{ userId: targetId, roleId: 'user' }])
    expect(result.status).toBe(200)
    expect(result.body.data.results.map((row: { code: string | null; message: string }) => ({ code: row.code, message: row.message }))).toEqual([{ code: null, message: '已更新' }])
    expect(result.body.data.successCount).toBe(1)
    expect(await isAdmin(targetId)).toBe(false)
    const roles = await query('SELECT role_id FROM user_roles WHERE user_id = $1 ORDER BY role_id', [targetId])
    expect(roles.rows).toEqual([{ role_id: 'user' }])
    const profile = await query('SELECT role, is_admin FROM users WHERE id = $1', [targetId])
    expect(profile.rows).toEqual([{ role: 'user', is_admin: false }])
    const denied = await update(targetId, [{ userId: actorId, department: 'forbidden' }])
    expect(denied.status).toBe(403)
  })

  it('rejects self-disable before a combined profile update writes anything', async () => {
    const actorId = await seedUser(true)
    const result = await update(actorId, [{ userId: actorId, department: 'must-not-save', isActive: false }])
    expect(result.body.data.failureCount).toBe(1)
    expect(result.body.data.results[0].code).toBe('SELF_DISABLE_FORBIDDEN')
    const user = await query('SELECT department, is_active FROM users WHERE id = $1', [actorId])
    expect(user.rows).toEqual([{ department: null, is_active: true }])
  })

  it('rejects conflicting identity keys and leaves both people unchanged', async () => {
    const actorId = await seedUser(true)
    const firstId = await seedUser()
    const secondId = await seedUser()
    const result = await update(actorId, [{ userId: firstId, email: `${secondId}@example.test`, department: 'must-not-save' }])
    expect(result.body.data.failureCount).toBe(1)
    expect(result.body.data.results[0].code).toBe('AMBIGUOUS_MATCH')
    const rows = await query('SELECT department FROM users WHERE id = ANY($1::text[])', [[firstId, secondId]])
    expect(rows.rows).toEqual([{ department: null }, { department: null }])
  })

  it('supersedes old directory recovery evidence through enable then disable', async () => {
    const actorId = await seedUser(true)
    const targetId = await seedUser()
    const eventId = await seedDeprovision(targetId, actorId)
    for (const isActive of [true, false]) {
      const result = await request(app).post('/api/admin/users/batch/disable')
        .auth(token(actorId), { type: 'bearer' }).send({ userIds: [targetId], isActive })
      expect(result.body.data.successCount).toBe(1)
    }
    const state = await query('SELECT is_active, access_generation::int FROM users WHERE id = $1', [targetId])
    expect(state.rows).toEqual([{ is_active: false, access_generation: 2 }])
    const event = await query('SELECT status FROM directory_deprovision_events WHERE id = $1', [eventId])
    const effects = await query('SELECT status FROM directory_deprovision_effects WHERE event_id = $1', [eventId])
    expect(event.rows).toEqual([{ status: 'superseded' }])
    expect(effects.rows).toEqual([{ status: 'superseded' }])
  })

  it('repairs hidden admin membership even when the display role already matches', async () => {
    const actorId = await seedUser(true)
    const targetId = await seedUser(true)
    await query("UPDATE users SET role = 'user', is_admin = FALSE WHERE id = $1", [targetId])
    const response = await update(actorId, [{ userId: targetId, roleId: 'user' }])
    expect(response.body.data.successCount).toBe(1)
    expect((await query('SELECT role_id FROM user_roles WHERE user_id = $1', [targetId])).rows).toEqual([{ role_id: 'user' }])
    expect((await update(targetId, [{ userId: actorId, department: 'denied' }])).status).toBe(403)
  })

  it('rejects an unmatched second identity instead of updating the first identity', async () => {
    const actorId = await seedUser(true)
    const targetId = await seedUser()
    const response = await update(actorId, [{ userId: targetId, email: 'unregistered@example.test', department: 'denied' }])
    expect(response.body.data.results[0].code).toBe('AMBIGUOUS_MATCH')
    expect((await query('SELECT department FROM users WHERE id = $1', [targetId])).rows).toEqual([{ department: null }])
  })

  it('serializes simultaneous replacements before reading the old memberships', async () => {
    const actorId = await seedUser(true)
    const targetId = await seedUser()
    await query("INSERT INTO roles(id, name) VALUES ('batch_review_replacement', 'Synthetic replacement') ON CONFLICT DO NOTHING")
    const blocker = new Client({ connectionString: process.env.DATABASE_URL })
    await blocker.connect()
    await blocker.query('BEGIN')
    await blocker.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [targetId])
    const responses = Promise.all([
      update(actorId, [{ userId: targetId, roleId: 'admin' }]).then(response => response),
      update(actorId, [{ userId: targetId, roleId: 'batch_review_replacement' }]).then(response => response),
    ])
    try {
      const deadline = Date.now() + 5000
      let waiting = 0
      while (Date.now() < deadline && waiting < 2) {
        const result = await query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'")
        waiting = Number(result.rows[0].count)
        if (waiting < 2) await new Promise(resolve => setTimeout(resolve, 20))
      }
      expect(waiting).toBe(2)
    } finally {
      await blocker.query('ROLLBACK')
      await blocker.end()
    }
    expect((await responses).map(response => response.body.data.successCount)).toEqual([1, 1])
    const profile = await query('SELECT role, is_admin FROM users WHERE id = $1', [targetId])
    const roles = await query('SELECT role_id FROM user_roles WHERE user_id = $1', [targetId])
    expect(roles.rows).toEqual([{ role_id: profile.rows[0].role }])
    expect(profile.rows[0].is_admin).toBe(profile.rows[0].role === 'admin')
  })

  it('keeps an explicitly removed attendance role revoked through real authentication', async () => {
    const actorId = await seedUser(true)
    const targetId = await seedUser()
    await query("INSERT INTO user_roles(user_id, role_id) VALUES ($1, 'attendance_employee')", [targetId])
    await query("INSERT INTO user_namespace_admissions(user_id, namespace, enabled, source) VALUES ($1, 'attendance', TRUE, 'synthetic')", [targetId])
    const previousMode = process.env.PRODUCT_MODE
    process.env.PRODUCT_MODE = 'attendance'
    try {
      expect(await authService.verifyToken(token(targetId))).not.toBeNull()
      const response = await update(actorId, [{ userId: targetId, roleId: 'user' }])
      expect(response.body.data.successCount).toBe(1)
      const admission = await query("SELECT enabled, source FROM user_namespace_admissions WHERE user_id = $1 AND namespace = 'attendance'", [targetId])
      expect(admission.rows).toEqual([{ enabled: false, source: 'role_unassigned' }])
      const authenticated = await authService.verifyToken(token(targetId))
      expect(authenticated).not.toBeNull()
      expect(authenticated?.permissions.some(permission => permission.startsWith('attendance:'))).toBe(false)
      expect((await query('SELECT role_id FROM user_roles WHERE user_id = $1', [targetId])).rows).toEqual([{ role_id: 'user' }])
    } finally {
      if (previousMode === undefined) delete process.env.PRODUCT_MODE
      else process.env.PRODUCT_MODE = previousMode
    }
  })

  it('keeps multiple real roles and direct permissions when roleId is omitted, and rejects an unknown role', async () => {
    const actorId = await seedUser(true)
    const targetId = await seedUser()
    await query("INSERT INTO roles(id, name) VALUES ('planner', 'Planner'), ('keeper', 'Keeper') ON CONFLICT DO NOTHING")
    await query('INSERT INTO user_roles(user_id, role_id) VALUES ($1, $2), ($1, $3) ON CONFLICT DO NOTHING', [targetId, 'planner', 'keeper'])
    await query("INSERT INTO user_permissions(user_id, permission_code) VALUES ($1, 'demo:read') ON CONFLICT DO NOTHING", [targetId])
    const beforeRoles = (await query('SELECT role_id FROM user_roles WHERE user_id = $1 ORDER BY role_id', [targetId])).rows
    const beforePermissions = (await query('SELECT permission_code FROM user_permissions WHERE user_id = $1 ORDER BY permission_code', [targetId])).rows
    const beforeProfile = (await query('SELECT role FROM users WHERE id = $1', [targetId])).rows
    expect(beforeRoles.map((row) => row.role_id)).toEqual(expect.arrayContaining(['planner', 'keeper', 'user']))

    const unchanged = await update(actorId, [{ userId: targetId, name: 'Synthetic user' }])
    expect(unchanged.status).toBe(200)
    expect(unchanged.body.data.results[0].code).toBe('UNCHANGED')
    expect((await query('SELECT role_id FROM user_roles WHERE user_id = $1 ORDER BY role_id', [targetId])).rows).toEqual(beforeRoles)
    expect((await query('SELECT permission_code FROM user_permissions WHERE user_id = $1 ORDER BY permission_code', [targetId])).rows).toEqual(beforePermissions)
    expect((await query('SELECT role FROM users WHERE id = $1', [targetId])).rows).toEqual(beforeProfile)

    const unknown = await update(actorId, [{ userId: targetId, roleId: 'not-a-real-role' }])
    expect(unknown.status).toBe(200)
    expect(unknown.body.data.results[0].code).toBe('ROLE_NOT_FOUND')
    expect((await query('SELECT role_id FROM user_roles WHERE user_id = $1 ORDER BY role_id', [targetId])).rows).toEqual(beforeRoles)
    expect((await query('SELECT permission_code FROM user_permissions WHERE user_id = $1 ORDER BY permission_code', [targetId])).rows).toEqual(beforePermissions)
    expect((await query("SELECT id FROM roles WHERE id = 'not-a-real-role'")).rows).toEqual([])
  })

  it('pages 110 users that share created_at without duplicating or skipping an id', async () => {
    const actorId = await seedUser(true)
    const stamp = '2001-01-01T00:00:00.000Z'
    const tokenText = `tie110_${randomUUID().replace(/-/g, '').slice(0, 12)}`
    const ids = Array.from({ length: 110 }, (_, index) => `${tokenText}_${String(index + 1).padStart(3, '0')}`)
    for (const userId of ids) {
      await query(
        `INSERT INTO users(id, username, email, name, password_hash, role, is_admin, is_active, activation_status, created_at, updated_at)
         VALUES ($1, $1, $2, $3, 'synthetic-only', 'user', FALSE, TRUE, 'activated', $4::timestamptz, $4::timestamptz)`,
        [userId, `${userId}@example.test`, tokenText, stamp],
      )
    }
    const seen: string[] = []
    for (let page = 1; page <= 6; page += 1) {
      const response = await request(app)
        .get('/api/admin/users')
        .query({ q: tokenText, page: String(page), pageSize: '20' })
        .auth(token(actorId), { type: 'bearer' })
      expect(response.status).toBe(200)
      expect(response.body.data.total).toBe(110)
      expect(response.body.data.pageSize).toBe(20)
      const pageIds = (response.body.data.items as Array<{ id: string }>).map((item) => item.id)
      expect(pageIds).toHaveLength(page === 6 ? 10 : 20)
      seen.push(...pageIds)
    }
    expect(seen).toHaveLength(110)
    expect(new Set(seen).size).toBe(110)
    expect(new Set(seen)).toEqual(new Set(ids))
  })
})

async function waitForBlockedBy(pid: number, count = 1): Promise<void> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const result = await query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))', [pid])
    if (result.rows[0].count >= count) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Expected requests to wait for the synthetic transaction lock')
}

const accessGraphSql = `SELECT role, is_admin, is_active, name, activation_status,
  deleted_at IS NOT NULL AS deleted, purged_at IS NOT NULL AS purged,
  ARRAY(SELECT role_id FROM user_roles WHERE user_id = users.id ORDER BY role_id) AS roles,
  ARRAY(SELECT directory_department_id::text FROM delegated_role_admin_scopes WHERE admin_user_id = users.id ORDER BY 1) AS scopes,
  ARRAY(SELECT group_id::text FROM delegated_role_admin_member_groups WHERE admin_user_id = users.id ORDER BY 1) AS scope_groups,
  ARRAY(SELECT group_id::text FROM platform_member_group_members WHERE user_id = users.id ORDER BY 1) AS member_groups,
  ARRAY(SELECT namespace || ':' || enabled::text FROM user_namespace_admissions WHERE user_id = users.id ORDER BY 1) AS admissions
  FROM users WHERE id = $1`

async function delegationFixture() {
  const actorId = await seedUser(true)
  const userId = await seedUser()
  const integrationId = randomUUID()
  const oldDepartmentId = randomUUID()
  const departmentId = randomUUID()
  const groupId = randomUUID()
  const templateId = randomUUID()
  await query("INSERT INTO roles(id, name) VALUES ('crm_admin', 'Synthetic CRM admin'), ('crm_reader', 'Synthetic CRM reader') ON CONFLICT DO NOTHING")
  await query("INSERT INTO user_roles(user_id, role_id) VALUES ($1, 'crm_admin')", [userId])
  await query("INSERT INTO directory_integrations(id, org_id, provider, name, corp_id, sync_enabled) VALUES ($1::uuid, 'default', 'dingtalk', $1::text, $1::text, FALSE)", [integrationId])
  for (const id of [oldDepartmentId, departmentId]) {
    await query('INSERT INTO directory_departments(id, integration_id, external_department_id, name) VALUES ($1::uuid, $2::uuid, $1::text, $1::text)', [id, integrationId])
  }
  await query('INSERT INTO platform_member_groups(id, name) VALUES ($1::uuid, $1::text)', [groupId])
  await query('INSERT INTO delegated_role_scope_templates(id, name) VALUES ($1::uuid, $1::text)', [templateId])
  await query('INSERT INTO delegated_role_scope_template_departments(template_id, directory_department_id) VALUES ($1, $2)', [templateId, departmentId])
  await query('INSERT INTO delegated_role_scope_template_member_groups(template_id, group_id) VALUES ($1, $2)', [templateId, groupId])
  await query("INSERT INTO delegated_role_admin_scopes(admin_user_id, namespace, directory_department_id) VALUES ($1, 'crm', $2)", [userId, oldDepartmentId])
  await query("INSERT INTO delegated_role_admin_member_groups(admin_user_id, namespace, group_id) VALUES ($1, 'crm', $2)", [userId, groupId])
  await query('INSERT INTO platform_member_group_members(group_id, user_id) VALUES ($1, $2)', [groupId, userId])
  return { actorId, userId, departmentId, oldDepartmentId, groupId, templateId }
}

type DelegationFixture = Awaited<ReturnType<typeof delegationFixture>>
const accessWrites = [
  ['platform assign', 'post', (f: DelegationFixture) => `/api/admin/users/${f.userId}/roles/assign`, () => ({ roleId: 'crm_reader' })],
  ['platform unassign', 'post', (f: DelegationFixture) => `/api/admin/users/${f.userId}/roles/unassign`, () => ({ roleId: 'crm_admin' })],
  ['delegation assign', 'post', (f: DelegationFixture) => `/api/admin/role-delegation/users/${f.userId}/roles/assign`, () => ({ roleId: 'crm_reader' })],
  ['delegation unassign', 'post', (f: DelegationFixture) => `/api/admin/role-delegation/users/${f.userId}/roles/unassign`, () => ({ roleId: 'crm_admin' })],
  ...(['assign', 'unassign'] as const).flatMap(action => [
    [`department scope ${action}`, 'post', (f: DelegationFixture) => `/api/admin/role-delegation/users/${f.userId}/scopes/${action}`, (f: DelegationFixture) => ({ namespace: 'crm', directoryDepartmentId: f.oldDepartmentId })],
    [`group scope ${action}`, 'post', (f: DelegationFixture) => `/api/admin/role-delegation/users/${f.userId}/scope-groups/${action}`, (f: DelegationFixture) => ({ namespace: 'crm', groupId: f.groupId })],
    [`member group ${action}`, 'post', (f: DelegationFixture) => `/api/admin/role-delegation/users/${f.userId}/member-groups/${action}`, (f: DelegationFixture) => ({ groupId: f.groupId })],
  ] as const),
  ['template replace', 'post', (f: DelegationFixture) => `/api/admin/role-delegation/users/${f.userId}/scope-templates/apply`, (f: DelegationFixture) => ({ namespace: 'crm', templateId: f.templateId, mode: 'replace' })],
  ['template merge', 'post', (f: DelegationFixture) => `/api/admin/role-delegation/users/${f.userId}/scope-templates/apply`, (f: DelegationFixture) => ({ namespace: 'crm', templateId: f.templateId, mode: 'merge' })],
  ['delegation admission', 'patch', (f: DelegationFixture) => `/api/admin/role-delegation/users/${f.userId}/namespaces/crm/admission`, () => ({ enabled: true })],
  ['platform admission', 'patch', (f: DelegationFixture) => `/api/admin/users/${f.userId}/namespaces/crm/admission`, () => ({ enabled: true })],
] as const

describe('access writes recheck lifecycle inside the recycle mutex', () => {
  it.each((['platform', 'delegation'] as const).flatMap(entry => (['assign', 'unassign'] as const).map(action => [entry, action] as const)))('%s admin %s rolls membership and legacy fields back together', async (entry, action) => {
    const actorId = await seedUser(true)
    const userId = await seedUser(action === 'unassign')
    const before = (await query(accessGraphSql, [userId])).rows[0]
    const triggerName = `synthetic_legacy_${randomUUID().replaceAll('-', '')}`
    await query(`CREATE FUNCTION ${triggerName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic legacy failure'; END $$`)
    await query(`CREATE TRIGGER ${triggerName} BEFORE UPDATE OF role, is_admin ON users FOR EACH ROW WHEN (OLD.id = '${userId}') EXECUTE FUNCTION ${triggerName}()`)
    const change = () => request(app)
      .post(entry === 'platform' ? `/api/admin/users/${userId}/roles/${action}` : `/api/admin/role-delegation/users/${userId}/roles/${action}`)
      .auth(token(actorId), { type: 'bearer' }).send({ roleId: 'admin' })
    try {
      expect((await change()).status).toBe(500)
      expect((await query(accessGraphSql, [userId])).rows[0]).toEqual(before)
    } finally {
      await query(`DROP TRIGGER ${triggerName} ON users`)
      await query(`DROP FUNCTION ${triggerName}()`)
    }
    expect((await change()).status).toBe(200)
    const after = (await query(accessGraphSql, [userId])).rows[0]
    expect(after.roles.includes('admin')).toBe(action === 'assign')
    expect(after.is_admin).toBe(action === 'assign')
    expect(after.role === 'admin').toBe(action === 'assign')
  })

  it.each(accessWrites.flatMap(write => (['recycle', 'purge'] as const).map(stage => [stage, ...write] as const)))('%s / %s refuses an in-flight write after lifecycle commit', async (stage, _name, method, path, body) => {
    const fixture = await delegationFixture()
    const blocker = new Client({ connectionString: process.env.DATABASE_URL })
    await blocker.connect()
    await blocker.query('BEGIN')
    try {
      const moved = await applyRecycleMove(blocker, { userId: fixture.userId, actorId: fixture.actorId, retentionDays: 30, index: 0 })
      expect(moved.ok).toBe(true)
      if (stage === 'purge') {
        const purged = await applyRecyclePurge({ query: blocker.query.bind(blocker) }, { userId: fixture.userId, actorId: fixture.actorId, index: 0, passwordHash: 'synthetic-unusable' })
        expect(purged.ok).toBe(true)
      }
      const expected = (await blocker.query(accessGraphSql, [fixture.userId])).rows[0]
      const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      const pending = request(app)[method](path(fixture)).auth(token(fixture.actorId), { type: 'bearer' }).send(body(fixture)).then(response => response)
      await waitForBlockedBy(pid)
      await blocker.query('COMMIT')
      const response = await pending
      expect(response.status).toBe(409)
      expect(response.body.error.code).toBe('USER_IN_RECYCLE_BIN')
      expect((await query(accessGraphSql, [fixture.userId])).rows[0]).toEqual(expected)
    } finally {
      await blocker.query('ROLLBACK')
      await blocker.end()
    }
  })

  it('rechecks a lost delegated namespace after waiting, while unrelated users can still be granted roles', async () => {
    const fixture = await delegationFixture()
    const otherId = await seedUser()
    const blocker = new Client({ connectionString: process.env.DATABASE_URL })
    await blocker.connect()
    await blocker.query('BEGIN')
    try {
      await lockNamespaceAdmissionWrites(blocker, fixture.userId)
      await blocker.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [fixture.userId])
      await blocker.query("DELETE FROM user_roles WHERE user_id = $1 AND role_id = 'crm_admin'", [fixture.userId])
      const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      const pending = request(app).post(`/api/admin/role-delegation/users/${fixture.userId}/scopes/assign`)
        .auth(token(fixture.actorId), { type: 'bearer' }).send({ namespace: 'crm', directoryDepartmentId: fixture.departmentId }).then(response => response)
      await waitForBlockedBy(pid)
      const unrelated = await request(app).post(`/api/admin/users/${otherId}/roles/assign`)
        .auth(token(fixture.actorId), { type: 'bearer' }).send({ roleId: 'crm_reader' })
      expect(unrelated.status).toBe(200)
      await blocker.query('COMMIT')
      const response = await pending
      expect(response.status).toBe(409)
      expect(response.body.error.code).toBe('ROLE_DELEGATION_NAMESPACE_NOT_HELD')
      expect((await query('SELECT 1 FROM delegated_role_admin_scopes WHERE admin_user_id = $1 AND directory_department_id = $2', [fixture.userId, fixture.departmentId])).rows).toEqual([])
    } finally {
      await blocker.query('ROLLBACK')
      await blocker.end()
    }
  })

  it('rolls template replacement back if a later scope insert fails, then applies normally', async () => {
    const fixture = await delegationFixture()
    const before = (await query(accessGraphSql, [fixture.userId])).rows[0]
    const triggerName = `synthetic_scope_${randomUUID().replaceAll('-', '')}`
    await query(`CREATE FUNCTION ${triggerName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic scope failure'; END $$`)
    await query(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON delegated_role_admin_member_groups FOR EACH ROW EXECUTE FUNCTION ${triggerName}()`)
    const apply = () => request(app).post(`/api/admin/role-delegation/users/${fixture.userId}/scope-templates/apply`)
      .auth(token(fixture.actorId), { type: 'bearer' }).send({ namespace: 'crm', templateId: fixture.templateId, mode: 'replace' })
    try {
      expect((await apply()).status).toBe(500)
      expect((await query(accessGraphSql, [fixture.userId])).rows[0]).toEqual(before)
    } finally {
      await query(`DROP TRIGGER ${triggerName} ON delegated_role_admin_member_groups`)
      await query(`DROP FUNCTION ${triggerName}()`)
    }
    expect((await apply()).status).toBe(200)
    expect((await query(accessGraphSql, [fixture.userId])).rows[0].scopes).toEqual([fixture.departmentId])
  })
})

describe('pending activation is refused by batch status and CSV update', () => {
  it.each(['enable', 'update', 'dryRun'])('%s refuses pending users without profile, role, or status writes', async (mode) => {
    const actorId = await seedUser(true)
    const userId = await seedUser()
    await query("UPDATE users SET activation_status = 'pending_activation', is_active = FALSE WHERE id = $1", [userId])
    const before = (await query(accessGraphSql, [userId])).rows[0]
    const response = mode === 'enable'
      ? await request(app).post('/api/admin/users/batch/disable').auth(token(actorId), { type: 'bearer' }).send({ userIds: [userId], isActive: true })
      : await request(app).post('/api/admin/users/batch/update').auth(token(actorId), { type: 'bearer' })
        .send({ items: [{ userId, name: 'Must not save', roleId: 'admin', isActive: true }], dryRun: mode === 'dryRun' })
    expect(response.status).toBe(200)
    expect(response.body.data.failureCount).toBe(1)
    expect(response.body.data.results[0].code).toBe('PENDING_ACTIVATE_BYPASS_FORBIDDEN')
    expect((await query(accessGraphSql, [userId])).rows[0]).toEqual(before)
    const disable = await request(app).post('/api/admin/users/batch/disable').auth(token(actorId), { type: 'bearer' }).send({ userIds: [userId], isActive: false })
    expect(disable.body.data.successCount).toBe(1)
  })

  it.each(['enable', 'update'])('%s rechecks pending status after its preflight waits for the user lock', async (mode) => {
    const actorId = await seedUser(true)
    const userId = await seedUser()
    await query('UPDATE users SET is_active = FALSE WHERE id = $1', [userId])
    const blocker = new Client({ connectionString: process.env.DATABASE_URL })
    await blocker.connect()
    await blocker.query('BEGIN')
    try {
      await blocker.query("UPDATE users SET activation_status = 'pending_activation' WHERE id = $1", [userId])
      const expected = (await blocker.query(accessGraphSql, [userId])).rows[0]
      const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      const pending = (mode === 'enable'
        ? request(app).post('/api/admin/users/batch/disable').send({ userIds: [userId], isActive: true })
        : request(app).post('/api/admin/users/batch/update').send({ items: [{ userId, name: 'Must not save', roleId: 'admin', isActive: true }] }))
        .auth(token(actorId), { type: 'bearer' }).then(response => response)
      await waitForBlockedBy(pid)
      await blocker.query('COMMIT')
      const response = await pending
      expect(response.status).toBe(200)
      expect(response.body.data.results[0].code).toBe('PENDING_ACTIVATE_BYPASS_FORBIDDEN')
      expect((await query(accessGraphSql, [userId])).rows[0]).toEqual(expected)
    } finally {
      await blocker.query('ROLLBACK')
      await blocker.end()
    }
  })
})


describe('atomic admission and fresh delegated authority', () => {
  it.each(['already recycled', 'recycled while queued', 'later SQL failure'])('bulk admission rolls back every target: %s', async (scenario) => {
    const actorId = await seedUser(true)
    const ids = [await seedUser(), await seedUser()].sort()
    const blocker = new Client({ connectionString: process.env.DATABASE_URL })
    await blocker.connect()
    const triggerName = `synthetic_admission_${randomUUID().replaceAll('-', '')}`
    if (scenario === 'later SQL failure') {
      await query(`CREATE FUNCTION ${triggerName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id = '${ids[1]}' THEN RAISE EXCEPTION 'synthetic admission failure'; END IF; RETURN NEW; END $$`)
      await query(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON user_namespace_admissions FOR EACH ROW EXECUTE FUNCTION ${triggerName}()`)
    } else {
      await blocker.query('BEGIN')
      const moved = await applyRecycleMove(blocker, { userId: ids[1], actorId, retentionDays: 30, index: 0 })
      expect(moved.ok).toBe(true)
      if (scenario === 'already recycled') await blocker.query('COMMIT')
    }
    try {
      const pending = request(app).post('/api/admin/users/namespaces/crm/admission/bulk')
        .auth(token(actorId), { type: 'bearer' }).send({ userIds: ids, enabled: true }).then(response => response)
      if (scenario === 'recycled while queued') {
        const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
        await waitForBlockedBy(pid)
        await blocker.query('COMMIT')
      }
      const response = await pending
      expect(response.status).toBe(scenario === 'later SQL failure' ? 500 : 409)
      expect((await query("SELECT 1 FROM user_namespace_admissions WHERE user_id = ANY($1::text[]) AND namespace = 'crm'", [ids])).rows).toEqual([])
    } finally {
      await blocker.query('ROLLBACK')
      await blocker.end()
      if (scenario === 'later SQL failure') {
        await query(`DROP TRIGGER ${triggerName} ON user_namespace_admissions`)
        await query(`DROP FUNCTION ${triggerName}()`)
      }
    }
  })

  it.each((['role assign', 'role unassign', 'admission'] as const).flatMap(operation =>
    (['namespace', 'audience', 'target membership', 'inactive actor', 'disabled actor', 'pending actor'] as const).map(revocation => [operation, revocation] as const),
  ))('%s rechecks actor %s after waiting for a target', async (operation, revocation) => {
    const f = await delegationFixture()
    // Sort the target before the actor so the request waits before locking the actor.
    const targetId = `a_delegation_${randomUUID()}`
    await query("INSERT INTO users(id, username, email, password_hash, role, is_active, activation_status) VALUES ($1, $1, $2, 'synthetic-only', 'user', TRUE, 'activated')", [targetId, `${targetId}@example.test`])
    await query("INSERT INTO user_roles(user_id, role_id) VALUES ($1, 'crm_reader')", [targetId])
    await query('INSERT INTO platform_member_group_members(group_id, user_id) VALUES ($1, $2)', [f.groupId, targetId])
    const before = (await query(accessGraphSql, [targetId])).rows[0]
    const blocker = new Client({ connectionString: process.env.DATABASE_URL })
    await blocker.connect()
    await blocker.query('BEGIN')
    try {
      await lockNamespaceAdmissionWrites(blocker, targetId)
      const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      const pending = (operation === 'admission'
        ? request(app).patch(`/api/admin/role-delegation/users/${targetId}/namespaces/crm/admission`).send({ enabled: true })
        : request(app).post(`/api/admin/role-delegation/users/${targetId}/roles/${operation === 'role assign' ? 'assign' : 'unassign'}`).send({ roleId: 'crm_reader' }))
        .auth(token(f.userId), { type: 'bearer' }).then(response => response)
      await waitForBlockedBy(pid)
      if (revocation === 'target membership') {
        await blocker.query('DELETE FROM platform_member_group_members WHERE user_id = $1', [targetId])
      } else {
        const revoker = new Client({ connectionString: process.env.DATABASE_URL })
        await revoker.connect()
        await revoker.query('BEGIN')
        try {
          await lockNamespaceAdmissionWrites(revoker, f.userId)
          await revoker.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [f.userId])
          if (revocation === 'namespace') await revoker.query("DELETE FROM user_roles WHERE user_id = $1 AND role_id = 'crm_admin'", [f.userId])
          else if (revocation === 'inactive actor') await revoker.query('UPDATE users SET is_active = FALSE WHERE id = $1', [f.userId])
          else if (revocation === 'disabled actor') await revoker.query("UPDATE users SET role = 'disabled' WHERE id = $1", [f.userId])
          else if (revocation === 'pending actor') await revoker.query("UPDATE users SET activation_status = 'pending_activation' WHERE id = $1", [f.userId])
          else {
            await revoker.query('DELETE FROM delegated_role_admin_scopes WHERE admin_user_id = $1', [f.userId])
            await revoker.query('DELETE FROM delegated_role_admin_member_groups WHERE admin_user_id = $1', [f.userId])
          }
          await revoker.query('COMMIT')
        } finally {
          await revoker.query('ROLLBACK')
          await revoker.end()
        }
      }
      await blocker.query('COMMIT')
      const response = await pending
      expect(response.status).toBe(403)
      expect(response.body.error.code).toBe(['namespace', 'inactive actor', 'disabled actor', 'pending actor'].includes(revocation) ? 'ROLE_DELEGATION_FORBIDDEN' : revocation === 'audience' ? 'ROLE_DELEGATION_SCOPE_REQUIRED' : 'ROLE_DELEGATION_USER_OUT_OF_SCOPE')
      const after = (await query(accessGraphSql, [targetId])).rows[0]
      expect(after).toEqual({ ...before, ...(revocation === 'target membership' ? { member_groups: [] } : {}) })
    } finally {
      await blocker.query('ROLLBACK')
      await blocker.end()
    }
  })

  it('allows a current delegate to assign, admit, and unassign an in-scope user', async () => {
    const f = await delegationFixture()
    const targetId = await seedUser()
    await query('INSERT INTO platform_member_group_members(group_id, user_id) VALUES ($1, $2)', [f.groupId, targetId])
    for (const action of ['assign', 'unassign']) {
      const response = await request(app).post(`/api/admin/role-delegation/users/${targetId}/roles/${action}`)
        .auth(token(f.userId), { type: 'bearer' }).send({ roleId: 'crm_reader' })
      expect(response.status).toBe(200)
      expect((await query("SELECT 1 FROM user_roles WHERE user_id = $1 AND role_id = 'crm_reader'", [targetId])).rows.length).toBe(action === 'assign' ? 1 : 0)
      if (action === 'assign') {
        const admitted = await request(app).patch(`/api/admin/role-delegation/users/${targetId}/namespaces/crm/admission`)
          .auth(token(f.userId), { type: 'bearer' }).send({ enabled: true })
        expect(admitted.status).toBe(200)
        expect((await query("SELECT enabled FROM user_namespace_admissions WHERE user_id = $1 AND namespace = 'crm'", [targetId])).rows).toEqual([{ enabled: true }])
      }
    }
  })

  it.each(['single', 'batch'])('attendance %s unassign takes namespace locks before users SHARE locks', async (mode) => {
    const actorId = await seedUser(true)
    const targetId = await seedUser()
    await query("INSERT INTO roles(id, name) VALUES ('attendance_employee', 'Synthetic attendance') ON CONFLICT DO NOTHING")
    await query("INSERT INTO user_roles(user_id, role_id) VALUES ($1, 'attendance_employee')", [targetId])
    const blocker = new Client({ connectionString: process.env.DATABASE_URL })
    await blocker.connect()
    await blocker.query('BEGIN')
    try {
      await lockNamespaceAdmissionWrites(blocker, targetId)
      const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      const pending = request(app).post(mode === 'single'
        ? `/api/attendance-admin/users/${targetId}/roles/unassign`
        : '/api/attendance-admin/users/batch/roles/unassign')
        .auth(token(actorId), { type: 'bearer' })
        .send({ scope: 'global', roleId: 'attendance_employee', userIds: [targetId] }).then(response => response)
      await waitForBlockedBy(pid)
      // A queued unassign must not hold users FOR SHARE while waiting for this namespace.
      await blocker.query("SET LOCAL statement_timeout = '1s'")
      await blocker.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [targetId])
      await blocker.query('COMMIT')
      expect((await pending).status).toBe(200)
      expect((await query("SELECT 1 FROM user_roles WHERE user_id = $1 AND role_id = 'attendance_employee'", [targetId])).rows).toEqual([])
    } finally {
      await blocker.query('ROLLBACK')
      await blocker.end()
    }
  })

  it('serializes reciprocal scope assignments without the created_by foreign key deadlock', async () => {
    const f = await delegationFixture()
    await query("UPDATE users SET role = 'admin', is_admin = TRUE WHERE id = $1", [f.userId])
    await query("INSERT INTO user_roles(user_id, role_id) VALUES ($1, 'crm_admin')", [f.actorId])
    const blocker = new Client({ connectionString: process.env.DATABASE_URL })
    await blocker.connect()
    await blocker.query('BEGIN')
    try {
      await lockNamespaceAdmissionWrites(blocker, [f.actorId, f.userId].sort()[0])
      const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      const assign = (actor: string, target: string) => request(app)
        .post(`/api/admin/role-delegation/users/${target}/scopes/assign`).auth(token(actor), { type: 'bearer' })
        .send({ namespace: 'crm', directoryDepartmentId: f.departmentId }).then(response => response)
      const pending = [assign(f.actorId, f.userId), assign(f.userId, f.actorId)]
      await waitForBlockedBy(pid, 2)
      await blocker.query('COMMIT')
      expect((await Promise.all(pending)).map(response => response.status)).toEqual([200, 200])
      expect((await query('SELECT 1 FROM delegated_role_admin_scopes WHERE admin_user_id = ANY($1::text[]) AND directory_department_id = $2', [[f.actorId, f.userId], f.departmentId])).rows).toHaveLength(2)
    } finally {
      await blocker.query('ROLLBACK')
      await blocker.end()
    }
  })
})
