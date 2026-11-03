import { randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { Client } from 'pg'
import { beforeAll, describe, expect, it } from 'vitest'
import { authService } from '../../src/auth/AuthService'

import { query } from '../../src/db/pg'
import { isAdmin } from '../../src/rbac/service'
import { adminUsersRouter } from '../../src/routes/admin-users'

const app = express()
app.use(express.json())
app.use(adminUsersRouter())

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
})
