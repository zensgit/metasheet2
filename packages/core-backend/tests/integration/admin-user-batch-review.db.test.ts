import { randomUUID } from 'node:crypto'
import express from 'express'
import request, { type Response } from 'supertest'
import { Client } from 'pg'
import { beforeAll, describe, expect, it } from 'vitest'
import { authService } from '../../src/auth/AuthService'

import { isLastSignInPlatformAdmin, lockPlatformAdminInvariant } from '../../src/admin/user-recycle'
import { query } from '../../src/db/pg'
import { authenticate } from '../../src/middleware/auth'
import { lockNamespaceAdmissionWrites } from '../../src/rbac/namespace-admission'
import { isAdmin } from '../../src/rbac/service'
import { adminUsersRouter } from '../../src/routes/admin-users'
import { rolesRouter } from '../../src/routes/roles'

const app = express()
app.use(express.json())
app.use(adminUsersRouter())

const rolesApp = express()
rolesApp.use(express.json())
rolesApp.use(authenticate)
rolesApp.use(rolesRouter())

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

type ParkedAdmin = { id: string; activation_status: string }

async function parkAcceptedAdmins(): Promise<ParkedAdmin[]> {
  const rows = (await query<ParkedAdmin>(`
    SELECT u.id, u.activation_status
    FROM users u
    WHERE COALESCE(u.is_active, FALSE) IS TRUE
      AND u.activation_status = 'activated'
      AND u.deleted_at IS NULL
      AND u.purged_at IS NULL
      AND (
        u.role = 'admin'
        OR EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id AND ur.role_id = 'admin')
      )
  `)).rows
  if (rows.length > 0) {
    await query(
      `UPDATE users SET activation_status = 'pending_activation' WHERE id = ANY($1::text[])`,
      [rows.map((row) => row.id)],
    )
  }
  return rows
}

async function restoreParked(rows: ParkedAdmin[]): Promise<void> {
  for (const row of rows) {
    await query('UPDATE users SET activation_status = $2 WHERE id = $1', [row.id, row.activation_status])
  }
}

async function seedPhaseUser(options: {
  role: string
  isAdminFlag?: boolean
  activationStatus?: string
  rbacAdmin?: boolean
  active?: boolean
}): Promise<string> {
  const userId = `phasea_${randomUUID()}`
  await query(
    `INSERT INTO users(id, username, email, name, password_hash, role, is_admin, is_active, activation_status)
     VALUES ($1, $1, $2, 'Synthetic phase user', 'synthetic-only', $3, $4, $5, $6)`,
    [
      userId,
      `${userId}@example.test`,
      options.role,
      options.isAdminFlag === true,
      options.active !== false,
      options.activationStatus ?? 'activated',
    ],
  )
  await query(
    'INSERT INTO user_roles(user_id, role_id) VALUES ($1, $2)',
    [userId, options.rbacAdmin ? 'admin' : 'user'],
  )
  return userId
}

async function removePhaseUsers(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  await query('DELETE FROM user_roles WHERE user_id = ANY($1::text[])', [ids])
  await query('DELETE FROM users WHERE id = ANY($1::text[])', [ids])
}

async function adminProfile(userId: string) {
  const profile = (await query(
    'SELECT role, is_admin, is_active, activation_status, deleted_at, purged_at FROM users WHERE id = $1',
    [userId],
  )).rows[0]
  const roles = (await query(
    'SELECT role_id FROM user_roles WHERE user_id = $1 ORDER BY role_id',
    [userId],
  )).rows
  return { profile, roles }
}

function unassignAdmin(route: 'platform' | 'delegated', actorId: string, targetId: string): Promise<Response> {
  const path = route === 'platform'
    ? `/api/admin/users/${targetId}/roles/unassign`
    : `/api/admin/role-delegation/users/${targetId}/roles/unassign`
  return Promise.resolve(request(app).post(path).auth(token(actorId), { type: 'bearer' }).send({ roleId: 'admin' }))
}

function assignAdmin(route: 'platform' | 'delegated', actorId: string, targetId: string): Promise<Response> {
  const path = route === 'platform'
    ? `/api/admin/users/${targetId}/roles/assign`
    : `/api/admin/role-delegation/users/${targetId}/roles/assign`
  return Promise.resolve(request(app).post(path).auth(token(actorId), { type: 'bearer' }).send({ roleId: 'admin' }))
}

async function waitForBlockedBy(blockerPid: number, expected: number): Promise<void> {
  const deadline = Date.now() + 5000
  let waiting = 0
  while (Date.now() < deadline && waiting < expected) {
    const result = await query(
      `SELECT count(*)::int AS count
       FROM pg_stat_activity
       WHERE datname = current_database()
         AND pid <> pg_backend_pid()
         AND $1::int = ANY(pg_blocking_pids(pid))`,
      [blockerPid],
    )
    waiting = Number(result.rows[0].count)
    if (waiting < expected) await new Promise((resolve) => setTimeout(resolve, 20))
  }
  expect(waiting).toBe(expected)
}

describe('phase A last-admin and legacy profile regressions', () => {
  it('refuses demotion of the sole raw-disabled RBAC admin after real authentication', async () => {
    const parked = await parkAcceptedAdmins()
    const ids: string[] = []
    try {
      const targetId = await seedPhaseUser({ role: 'disabled', isAdminFlag: false, rbacAdmin: true })
      ids.push(targetId)
      const before = await adminProfile(targetId)
      for (const route of ['platform', 'delegated'] as const) {
        const response = await unassignAdmin(route, targetId, targetId)
        expect(response.status).toBe(409)
        expect(response.body.error.code).toBe('LAST_PLATFORM_ADMIN')
        expect(await adminProfile(targetId)).toEqual(before)
      }
    } finally {
      await restoreParked(parked)
      await removePhaseUsers(ids)
    }
  })

  it('does not count an is_admin flag, a pending admin, or a raw-disabled backup', async () => {
    const parked = await parkAcceptedAdmins()
    const ids: string[] = []
    try {
      const realId = await seedPhaseUser({ role: 'admin', isAdminFlag: true, rbacAdmin: true })
      const flagOnlyId = await seedPhaseUser({ role: 'user', isAdminFlag: true, rbacAdmin: false })
      const pendingId = await seedPhaseUser({
        role: 'admin', isAdminFlag: true, rbacAdmin: true, activationStatus: 'pending_activation',
      })
      const disabledId = await seedPhaseUser({ role: 'disabled', isAdminFlag: true, rbacAdmin: true })
      ids.push(realId, flagOnlyId, pendingId, disabledId)
      const before = await adminProfile(realId)
      const pendingBefore = await adminProfile(pendingId)
      const disabledBefore = await adminProfile(disabledId)
      const denied = await unassignAdmin('platform', flagOnlyId, realId)
      expect(denied.status).toBe(403)
      const blocked = await unassignAdmin('platform', realId, realId)
      expect(blocked.status).toBe(409)
      expect(blocked.body.error.code).toBe('LAST_PLATFORM_ADMIN')
      expect(await adminProfile(realId)).toEqual(before)
      expect(await adminProfile(pendingId)).toEqual(pendingBefore)
      expect(await adminProfile(disabledId)).toEqual(disabledBefore)
      const survivorId = await seedPhaseUser({ role: 'admin', isAdminFlag: true, rbacAdmin: true })
      ids.push(survivorId)
      const survivorBefore = await adminProfile(survivorId)
      const allowed = await unassignAdmin('delegated', realId, realId)
      expect(allowed.status).toBe(200)
      const demoted = await adminProfile(realId)
      expect(demoted.roles.map((row) => row.role_id)).not.toContain('admin')
      expect(demoted.profile.role).toBe('user')
      expect(demoted.profile.is_admin).toBe(false)
      expect(await adminProfile(survivorId)).toEqual(survivorBefore)
    } finally {
      await restoreParked(parked)
      await removePhaseUsers(ids)
    }
  })

  it('accepts a null historical role when the RBAC admin membership remains', async () => {
    const parked = await parkAcceptedAdmins()
    const ids: string[] = []
    let client: Client | null = null
    try {
      const targetId = await seedPhaseUser({ role: 'admin', isAdminFlag: true, rbacAdmin: true })
      ids.push(targetId)
      client = new Client({ connectionString: process.env.DATABASE_URL })
      await client.connect()
      await client.query('BEGIN')
      await client.query('ALTER TABLE users ALTER COLUMN role DROP NOT NULL')
      await client.query('UPDATE users SET role = NULL WHERE id = $1', [targetId])
      expect(await isLastSignInPlatformAdmin(client, targetId)).toBe(true)
      await client.query('ROLLBACK')
    } finally {
      await client?.query('ROLLBACK').catch(() => undefined)
      await client?.end().catch(() => undefined)
      await restoreParked(parked)
      await removePhaseUsers(ids)
    }
  })

  it('orders two real demotions by the platform invariant lock', async () => {
    const parked = await parkAcceptedAdmins()
    const ids: string[] = []
    const blocker = new Client({ connectionString: process.env.DATABASE_URL })
    const pending: Array<Promise<Response>> = []
    try {
      const firstId = await seedPhaseUser({ role: 'admin', isAdminFlag: true, rbacAdmin: true })
      const secondId = await seedPhaseUser({ role: 'admin', isAdminFlag: true, rbacAdmin: true })
      ids.push(firstId, secondId)
      const firstBefore = await adminProfile(firstId)
      const secondBefore = await adminProfile(secondId)
      await blocker.connect()
      await blocker.query('BEGIN')
      await lockPlatformAdminInvariant(blocker)
      const pid = Number((await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      pending.push(
        unassignAdmin('platform', firstId, secondId),
        unassignAdmin('delegated', secondId, firstId),
      )
      await waitForBlockedBy(pid, 2)
      await blocker.query('COMMIT')
      const responses = await Promise.all(pending)
      const statuses = responses.map((response) => response.status).sort()
      expect(statuses).toEqual([200, 409])
      expect(responses.find((response) => response.status === 409)?.body.error.code).toBe('LAST_PLATFORM_ADMIN')
      const first = await adminProfile(firstId)
      const second = await adminProfile(secondId)
      const held = [first, second].filter((row) => row.roles.some((role) => role.role_id === 'admin'))
      const cleared = [first, second].filter((row) => !row.roles.some((role) => role.role_id === 'admin'))
      expect(held).toHaveLength(1)
      expect(cleared).toHaveLength(1)
      expect(held[0].profile.role).toBe('admin')
      expect(held[0].profile.is_admin).toBe(true)
      expect(cleared[0].profile.role).toBe('user')
      expect(cleared[0].profile.is_admin).toBe(false)
      const unchanged = held[0] === first ? firstBefore : secondBefore
      expect(held[0]).toEqual(unchanged)
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined)
      await Promise.allSettled(pending)
      await blocker.end().catch(() => undefined)
      await restoreParked(parked)
      await removePhaseUsers(ids)
    }
  })

  it('rolls back membership when the legacy profile update fails, then commits a successful assign', async () => {
    const parked = await parkAcceptedAdmins()
    const created: string[] = []
    const functionName = `phasea_legacy_${randomUUID().replace(/-/g, '')}`
    try {
      const actorId = await seedPhaseUser({ role: 'admin', isAdminFlag: true, rbacAdmin: true })
      const targetId = await seedPhaseUser({ role: 'user', isAdminFlag: false, rbacAdmin: false })
      const adminTargetId = await seedPhaseUser({ role: 'admin', isAdminFlag: true, rbacAdmin: true })
      created.push(actorId, targetId, adminTargetId)
      const assignBefore = await adminProfile(targetId)
      const unassignBefore = await adminProfile(adminTargetId)
      await query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF OLD.id IN ('${targetId}', '${adminTargetId}') THEN
            RAISE EXCEPTION 'synthetic legacy profile failure';
          END IF;
          RETURN NEW;
        END $$`)
      await query(`CREATE TRIGGER ${functionName} BEFORE UPDATE OF role, is_admin ON users
        FOR EACH ROW EXECUTE FUNCTION ${functionName}()`)
      for (const route of ['platform', 'delegated'] as const) {
        const response = await assignAdmin(route, actorId, targetId)
        expect(response.status).toBe(500)
        expect(await adminProfile(targetId)).toEqual(assignBefore)
      }
      for (const route of ['platform', 'delegated'] as const) {
        const response = await unassignAdmin(route, actorId, adminTargetId)
        expect(response.status).toBe(500)
        expect(await adminProfile(adminTargetId)).toEqual(unassignBefore)
      }
      await query(`DROP TRIGGER IF EXISTS ${functionName} ON users`)
      await query(`DROP FUNCTION IF EXISTS ${functionName}()`)
      const granted = await assignAdmin('platform', actorId, targetId)
      expect(granted.status).toBe(200)
      const after = await adminProfile(targetId)
      expect(after.roles.map((row) => row.role_id)).toContain('admin')
      expect(after.profile.role).toBe('admin')
      expect(after.profile.is_admin).toBe(true)
      expect(await adminProfile(adminTargetId)).toEqual(unassignBefore)
    } finally {
      await query(`DROP TRIGGER IF EXISTS ${functionName} ON users`).catch(() => undefined)
      await query(`DROP FUNCTION IF EXISTS ${functionName}()`).catch(() => undefined)
      await restoreParked(parked)
      await removePhaseUsers(created)
    }
  })

  it('serializes an admin grant and revoke on the admission lock', async () => {
    const parked = await parkAcceptedAdmins()
    const ids: string[] = []
    const blocker = new Client({ connectionString: process.env.DATABASE_URL })
    const pending: Array<Promise<Response>> = []
    try {
      const actorId = await seedPhaseUser({ role: 'admin', isAdminFlag: true, rbacAdmin: true })
      const targetId = await seedPhaseUser({ role: 'user', isAdminFlag: false, rbacAdmin: false })
      ids.push(actorId, targetId)
      await blocker.connect()
      await blocker.query('BEGIN')
      await lockNamespaceAdmissionWrites(blocker, targetId)
      const pid = Number((await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      pending.push(
        assignAdmin('platform', actorId, targetId),
        unassignAdmin('delegated', actorId, targetId),
      )
      await waitForBlockedBy(pid, 2)
      await blocker.query('COMMIT')
      const responses = await Promise.all(pending)
      expect(responses.map((response) => response.status)).toEqual([200, 200])
      const after = await adminProfile(targetId)
      const held = after.roles.some((row) => row.role_id === 'admin')
      expect(after.profile.role === 'admin').toBe(held)
      expect(after.profile.is_admin).toBe(held)
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined)
      await Promise.allSettled(pending)
      await blocker.end().catch(() => undefined)
      await restoreParked(parked)
      await removePhaseUsers(ids)
    }
  })

  it('refuses DELETE of the reserved admin role with and without a role_id cascade', async () => {
    const ids: string[] = []
    const saved = (await query<{ name: string; restore_sql: string }>(`
      SELECT DISTINCT ON (con.oid)
             con.conname AS name,
             format(
               'ALTER TABLE %I.%I ADD CONSTRAINT %I %s',
               nsp.nspname,
               rel.relname,
               con.conname,
               pg_get_constraintdef(con.oid)
             ) AS restore_sql
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
      JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum = ANY (con.conkey)
      WHERE rel.relname = 'user_roles'
        AND att.attname = 'role_id'
        AND con.contype = 'f'
      ORDER BY con.oid
    `)).rows
    const tempName = `phasea_role_fk_${randomUUID().replace(/-/g, '')}`
    const droppedNames: string[] = []
    let addedTemp = false
    try {
      const actorId = await seedPhaseUser({ role: 'admin', isAdminFlag: true, rbacAdmin: true })
      ids.push(actorId)
      const beforeRole = (await query("SELECT id, name FROM roles WHERE id = 'admin'")).rows
      const beforeMembers = (await query(
        "SELECT user_id, role_id FROM user_roles WHERE role_id = 'admin' ORDER BY user_id",
      )).rows
      for (const fk of saved) {
        const quoted = (await query<{ q: string }>('SELECT quote_ident($1) AS q', [fk.name])).rows[0].q
        await query(`ALTER TABLE user_roles DROP CONSTRAINT ${quoted}`)
        droppedNames.push(fk.name)
      }
      const withoutFk = await request(rolesApp).delete('/api/roles/admin').auth(token(actorId), { type: 'bearer' })
      expect(withoutFk.status).toBe(409)
      expect(withoutFk.body.error.code).toBe('RESERVED_ADMIN_ROLE_DELETE_FORBIDDEN')
      expect((await query("SELECT id, name FROM roles WHERE id = 'admin'")).rows).toEqual(beforeRole)
      expect((await query(
        "SELECT user_id, role_id FROM user_roles WHERE role_id = 'admin' ORDER BY user_id",
      )).rows).toEqual(beforeMembers)
      await query(
        `ALTER TABLE user_roles ADD CONSTRAINT ${tempName}
         FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE`,
      )
      addedTemp = true
      const withCascade = await request(rolesApp).delete('/api/roles/admin').auth(token(actorId), { type: 'bearer' })
      expect(withCascade.status).toBe(409)
      expect(withCascade.body.error.code).toBe('RESERVED_ADMIN_ROLE_DELETE_FORBIDDEN')
      expect((await query("SELECT id, name FROM roles WHERE id = 'admin'")).rows).toEqual(beforeRole)
      expect((await query(
        "SELECT user_id, role_id FROM user_roles WHERE role_id = 'admin' ORDER BY user_id",
      )).rows).toEqual(beforeMembers)
    } finally {
      if (addedTemp) {
        await query(`ALTER TABLE user_roles DROP CONSTRAINT IF EXISTS ${tempName}`).catch(() => undefined)
      }
      for (const fk of saved) {
        if (droppedNames.includes(fk.name)) await query(fk.restore_sql)
      }
      await removePhaseUsers(ids)
    }
  })
})
