import { randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { Client } from 'pg'
import { sql, type Kysely } from 'kysely'
import { beforeAll, describe, expect, it } from 'vitest'
import { query, transaction } from '../../src/db/pg'
import { db } from '../../src/db/db'
import { ApiTokenService } from '../../src/multitable/api-token-service'
import { authService } from '../../src/auth/AuthService'
import { restoreDeprovisionEvent } from '../../src/directory/deprovision-evidence-api'
import { adminUsersRouter } from '../../src/routes/admin-users'
import { applyRecycleMove, applyRecycleRestore, applyRecyclePurge, listDueRecycleUsers, purgeDueRecycleUsers } from '../../src/admin/user-recycle'
import { up, down } from '../../src/db/migrations/zzzz20261031120000_add_users_recycle_bin'

beforeAll(async () => {
  expect(process.env.EXPECT_DB).toBe('1')
  expect(new URL(process.env.DATABASE_URL || 'invalid:').pathname).toMatch(/^\/admin_review_synthetic(?:_[a-z0-9_]+)?$/)
  process.env.RBAC_BYPASS = 'false'
  process.env.RBAC_TOKEN_TRUST = 'false'
  await query("INSERT INTO roles(id, name) VALUES ('admin', 'Synthetic admin'), ('user', 'Synthetic user') ON CONFLICT DO NOTHING")
})

async function seedUser(admin = false) {
  const userId = `recycle_review_${randomUUID()}`
  await query(
    `INSERT INTO users(id, username, email, name, password_hash, role, is_admin, is_active, activation_status)
     VALUES ($1, $1, $2, 'Synthetic user', 'synthetic-only', $3, $4, TRUE, 'activated')`,
    [userId, `${userId}@example.test`, admin ? 'admin' : 'user', admin],
  )
  await query('INSERT INTO user_roles(user_id, role_id) VALUES ($1, $2)', [userId, admin ? 'admin' : 'user'])
  return userId
}

function move(userId: string, now = new Date()) {
  return transaction(client => applyRecycleMove(client, { userId, actorId: 'synthetic-operator', retentionDays: 30, index: 0, now }))
}

async function seedEvidence(userId: string) {
  const integrationId = randomUUID()
  const accountId = randomUUID()
  const eventId = randomUUID()
  await query("INSERT INTO directory_integrations(id, org_id, provider, name, corp_id, sync_enabled) VALUES ($1::uuid, 'default', 'dingtalk', $1::text, $1::text, FALSE)", [integrationId])
  await query("INSERT INTO directory_accounts(id, integration_id, provider, corp_id, external_user_id, external_key, name, is_active) VALUES ($1::uuid, $2::uuid, 'dingtalk', $2::text, $1::text, $1::text, 'Synthetic', FALSE)", [accountId, integrationId])
  await query("INSERT INTO directory_account_links(directory_account_id, local_user_id, link_status) VALUES ($1, $2, 'linked')", [accountId, userId])
  await query(`INSERT INTO directory_deprovision_events(id, org_id, integration_id, directory_account_id, local_user_id, triggered_by, event_origin, link_witness_account_id, link_witness_local_user_id, policy, globally_clear, access_generation_at_apply, status)
    VALUES ($1, 'default', $2, $3, $4, 'synthetic-operator', 'admin_manual', $3, $4, 'mark_inactive', TRUE, 0, 'applied')`, [eventId, integrationId, accountId, userId])
  await query("INSERT INTO directory_deprovision_effects(event_id, local_user_id, effect_type, before_active, after_active, access_generation_at_apply, status) VALUES ($1, $2, 'user_changed', TRUE, FALSE, 0, 'applied')", [eventId, userId])
  return eventId
}

describe('recycle review against a fresh migrated synthetic PostgreSQL database', () => {
  it('serializes two administrators recycling one another and preserves the last administrator', async () => {
    expect((await query('SELECT count(*)::int AS count FROM users')).rows).toEqual([{ count: 0 }])
    const firstId = await seedUser(true)
    const secondId = await seedUser(true)
    const first = new Client({ connectionString: process.env.DATABASE_URL })
    const secondName = `recycle_wait_${randomUUID()}`
    const second = new Client({ connectionString: process.env.DATABASE_URL, application_name: secondName })
    await first.connect()
    await second.connect()
    await first.query('BEGIN')
    await second.query('BEGIN')
    try {
      const moved = await applyRecycleMove(first, { userId: firstId, actorId: secondId, retentionDays: 30, index: 0 })
      expect(moved.ok).toBe(true)
      const concurrent = applyRecycleMove(second, { userId: secondId, actorId: firstId, retentionDays: 30, index: 0 })
      const deadline = Date.now() + 5000
      let waiting = false
      while (Date.now() < deadline && !waiting) {
        const status = await query('SELECT wait_event_type FROM pg_stat_activity WHERE application_name = $1', [secondName])
        waiting = status.rows[0]?.wait_event_type === 'Lock'
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 20))
      }
      await first.query('COMMIT')
      const outcome = await concurrent
      await second.query('COMMIT')
      expect(waiting).toBe(true)
      expect(outcome.code).toBe('LAST_PLATFORM_ADMIN')
      expect((await query("SELECT count(*)::int AS count FROM users WHERE deleted_at IS NULL AND role = 'admin'")).rows).toEqual([{ count: 1 }])
    } finally {
      await first.query('ROLLBACK')
      await second.query('ROLLBACK')
      await first.end()
      await second.end()
    }
  })

  it('supersedes old recovery evidence and advances generation for move, restore and purge', async () => {
    const userId = await seedUser()
    const eventId = await seedEvidence(userId)
    expect((await move(userId)).ok).toBe(true)
    expect((await query('SELECT status FROM directory_deprovision_events WHERE id = $1', [eventId])).rows).toEqual([{ status: 'superseded' }])
    expect((await query('SELECT status FROM directory_deprovision_effects WHERE event_id = $1', [eventId])).rows).toEqual([{ status: 'superseded' }])
    expect((await query('SELECT access_generation::int FROM users WHERE id = $1', [userId])).rows).toEqual([{ access_generation: 1 }])
    await expect(restoreDeprovisionEvent({ eventId, mode: 'admin_force', adminUserId: 'synthetic-operator', confirm: true, note: 'Synthetic recovery rejection' })).rejects.toMatchObject({ code: 'EVENT_NOT_APPLIED' })
    expect((await query('SELECT is_active FROM users WHERE id = $1', [userId])).rows).toEqual([{ is_active: false }])
    expect((await transaction(client => applyRecycleRestore(client, { userId, actorId: 'synthetic-operator', index: 0 }))).ok).toBe(true)
    expect((await query('SELECT access_generation::int, is_active FROM users WHERE id = $1', [userId])).rows).toEqual([{ access_generation: 2, is_active: true }])
    expect((await move(userId)).ok).toBe(true)
    expect((await transaction(client => applyRecyclePurge(client, { userId, actorId: 'synthetic-operator', index: 0, passwordHash: 'synthetic-unusable' }))).ok).toBe(true)
    expect((await query('SELECT access_generation::int, is_active, email FROM users WHERE id = $1', [userId])).rows).toEqual([{ access_generation: 4, is_active: false, email: null }])
    expect((await query('SELECT role_id FROM user_roles WHERE user_id = $1', [userId])).rows).toEqual([])
  })

  it('revokes tokens on recycling and fails closed on a recycled or purged creator even if active', async () => {
    const service = new ApiTokenService(db)
    const userId = await seedUser()
    const token = await service.createToken(userId, { name: 'Synthetic', scopes: ['records:read'] })
    expect((await service.validateToken(token.plainTextToken)).valid).toBe(true)
    expect((await move(userId)).ok).toBe(true)
    expect((await query('SELECT revoked FROM multitable_api_tokens WHERE id = $1', [token.token.id])).rows).toEqual([{ revoked: true }])
    expect((await service.validateToken(token.plainTextToken)).valid).toBe(false)
    await query('UPDATE multitable_api_tokens SET revoked = FALSE WHERE id = $1', [token.token.id])
    await query('UPDATE users SET is_active = TRUE WHERE id = $1', [userId])
    expect((await service.validateToken(token.plainTextToken)).valid).toBe(false)
    const jwt = authService.createToken({ id: userId, email: '', name: 'Synthetic', role: 'user', permissions: [], created_at: new Date(), updated_at: new Date() })
    expect(await authService.verifyToken(jwt)).toBeNull()
    await query('UPDATE users SET deleted_at = NULL, purged_at = NOW() WHERE id = $1', [userId])
    expect((await service.validateToken(token.plainTextToken)).valid).toBe(false)
    expect(await authService.verifyToken(jwt)).toBeNull()
  })

  it('applies migration down and up transactionally without altering identities or persisting rollback damage', async () => {
    const userId = await seedUser()
    await move(userId)
    const before = await query('SELECT id, email, deleted_at, purge_after FROM users WHERE id = $1', [userId])
    const rollback = new Error('synthetic migration rollback')
    await expect(db.transaction().execute(async client => {
      await down(client as Kysely<unknown>)
      const absent = await sql<{ count: number }>`SELECT count(*)::int AS count FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'users' AND column_name = 'deleted_at'`.execute(client)
      expect(absent.rows).toEqual([{ count: 0 }])
      expect((await sql<{ count: number }>`SELECT count(*)::int AS count FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_users_recycle_due'`.execute(client)).rows).toEqual([{ count: 0 }])
      const identity = await sql<{ id: string; email: string }>`SELECT id, email FROM users WHERE id = ${userId}`.execute(client)
      expect(identity.rows).toEqual([{ id: userId, email: `${userId}@example.test` }])
      await up(client as Kysely<unknown>)
      const restored = await sql<{ count: number }>`SELECT count(*)::int AS count FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'users' AND column_name IN ('deleted_at', 'deleted_by', 'purge_after', 'purged_at', 'purged_by', 'active_before_delete')`.execute(client)
      expect(restored.rows).toEqual([{ count: 6 }])
      expect((await sql<{ count: number }>`SELECT count(*)::int AS count FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_users_recycle_due'`.execute(client)).rows).toEqual([{ count: 1 }])
      throw rollback
    })).rejects.toBe(rollback)
    expect((await query('SELECT id, email, deleted_at, purge_after FROM users WHERE id = $1', [userId])).rows).toEqual(before.rows)
  })

  it.each([5, 35])('rejects stale sweep selection after restore/recycle at %i days ago under a competing transaction', async (daysAgo) => {
    const userId = await seedUser()
    const now = new Date()
    const oldTime = new Date(now.getTime() - 40 * 86400000)
    expect((await move(userId, oldTime)).ok).toBe(true)
    const selected = (await listDueRecycleUsers({ query }, now)).find(candidate => candidate.id === userId)
    expect(selected).toBeDefined()
    const blocker = new Client({ connectionString: process.env.DATABASE_URL })
    const waiterName = `purge_wait_${randomUUID()}`
    const waiter = new Client({ connectionString: process.env.DATABASE_URL, application_name: waiterName })
    await blocker.connect()
    await waiter.connect()
    await blocker.query('BEGIN')
    await waiter.query('BEGIN')
    try {
      expect((await applyRecycleRestore(blocker, { userId, actorId: 'synthetic-operator', index: 0 })).ok).toBe(true)
      expect((await applyRecycleMove(blocker, { userId, actorId: 'synthetic-operator', retentionDays: 30, index: 0, now: new Date(now.getTime() - daysAgo * 86400000) })).ok).toBe(true)
      const pending = applyRecyclePurge(waiter, { userId, actorId: 'synthetic-operator', index: 0, now, passwordHash: 'synthetic-unusable', expectedDeletedAt: selected!.deletedAt, dueBefore: now })
      const deadline = Date.now() + 5000
      let waiting = false
      while (Date.now() < deadline && !waiting) {
        waiting = (await query('SELECT wait_event_type FROM pg_stat_activity WHERE application_name = $1', [waiterName])).rows[0]?.wait_event_type === 'Lock'
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 20))
      }
      await blocker.query('COMMIT')
      const result = await pending
      await waiter.query('COMMIT')
      expect(waiting).toBe(true)
      expect(result.ok).toBe(false)
      expect((await query('SELECT email, purged_at FROM users WHERE id = $1', [userId])).rows).toEqual([{ email: `${userId}@example.test`, purged_at: null }])
    } finally {
      await blocker.query('ROLLBACK')
      await waiter.query('ROLLBACK')
      await blocker.end()
      await waiter.end()
    }
  })

  it('rechecks an extended deadline and only purges a current due candidate', async () => {
    const userId = await seedUser()
    const now = new Date()
    expect((await move(userId, new Date(now.getTime() - 40 * 86400000))).ok).toBe(true)
    const selected = (await listDueRecycleUsers({ query }, now)).find(candidate => candidate.id === userId)!
    expect(selected).toBeDefined()
    await query("UPDATE users SET purge_after = NOW() + INTERVAL '1 day' WHERE id = $1", [userId])
    const stale = await transaction(client => applyRecyclePurge(client, { userId, actorId: 'synthetic-operator', index: 0, now, passwordHash: 'synthetic-unusable', expectedDeletedAt: selected.deletedAt, dueBefore: now }))
    expect(stale.ok).toBe(false)
    await query("UPDATE users SET purge_after = NOW() - INTERVAL '1 day' WHERE id = $1", [userId])
    const due = await transaction(client => applyRecyclePurge(client, { userId, actorId: 'synthetic-operator', index: 0, now, passwordHash: 'synthetic-unusable', expectedDeletedAt: selected.deletedAt, dueBefore: now }))
    expect(due.ok).toBe(true)
    expect((await query('SELECT email, purged_at IS NOT NULL AS purged FROM users WHERE id = $1', [userId])).rows).toEqual([{ email: null, purged: true }])
  })

  it('carries selection witnesses through the actual sweeper and still purges a current due account', async () => {
    const userId = await seedUser()
    const now = new Date()
    await move(userId, new Date(now.getTime() - 40 * 86400000))
    const blocker = new Client({ connectionString: process.env.DATABASE_URL })
    await blocker.connect()
    await blocker.query('BEGIN')
    try {
      await applyRecycleRestore(blocker, { userId, actorId: 'synthetic-operator', index: 0 })
      await applyRecycleMove(blocker, { userId, actorId: 'synthetic-operator', retentionDays: 30, index: 0, now })
      const pending = purgeDueRecycleUsers(now)
      const deadline = Date.now() + 5000
      let waiting = false
      while (Date.now() < deadline && !waiting) {
        waiting = Number((await query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'")).rows[0].count) > 0
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 20))
      }
      await blocker.query('COMMIT')
      await pending
      expect(waiting).toBe(true)
      expect((await query('SELECT email, purged_at FROM users WHERE id = $1', [userId])).rows).toEqual([{ email: `${userId}@example.test`, purged_at: null }])
    } finally {
      await blocker.query('ROLLBACK')
      await blocker.end()
    }
    const dueId = await seedUser()
    await move(dueId, new Date(now.getTime() - 40 * 86400000))
    expect(await purgeDueRecycleUsers(now)).toBeGreaterThan(0)
    expect((await query('SELECT email, purged_at IS NOT NULL AS purged FROM users WHERE id = $1', [dueId])).rows).toEqual([{ email: null, purged: true }])
  })

  it.each([false, true])('refuses an already-planned profile and role update after lifecycle commit (purged=%s)', async (purged) => {
    const actorId = await seedUser(true)
    const userId = await seedUser()
    const app = express()
    app.use(express.json())
    app.use(adminUsersRouter())
    const jwt = authService.createToken({ id: actorId, email: '', name: 'Synthetic', role: 'admin', permissions: [], created_at: new Date(), updated_at: new Date() })
    const blocker = new Client({ connectionString: process.env.DATABASE_URL })
    await blocker.connect()
    await blocker.query('BEGIN')
    const bound = { query: (statement: string, params?: unknown[]) => blocker.query(statement, params) }
    try {
      expect((await applyRecycleMove(bound, { userId, actorId, retentionDays: 30, index: 0 })).ok).toBe(true)
      if (purged) expect((await applyRecyclePurge(bound, { userId, actorId, index: 0, passwordHash: 'synthetic-unusable' })).ok).toBe(true)
      const expected = await blocker.query('SELECT name, email, department, role, is_admin, is_active FROM users WHERE id = $1', [userId])
      const expectedRoles = await blocker.query('SELECT role_id FROM user_roles WHERE user_id = $1', [userId])
      const pending = request(app).post('/api/admin/users/batch/update').auth(jwt, { type: 'bearer' })
        .send({ items: [{ userId, name: 'Must not return', department: 'Denied', roleId: 'admin', isActive: true }] }).then(response => response)
      const deadline = Date.now() + 5000
      let waiting = false
      while (Date.now() < deadline && !waiting) {
        waiting = Number((await query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'")).rows[0].count) > 0
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 20))
      }
      await blocker.query('COMMIT')
      const response = await pending
      expect(waiting).toBe(true)
      expect(response.status).toBe(200)
      expect(response.body.data.results[0].code).toBe('USER_IN_RECYCLE_BIN')
      expect((await query('SELECT name, email, department, role, is_admin, is_active FROM users WHERE id = $1', [userId])).rows).toEqual(expected.rows)
      expect((await query('SELECT role_id FROM user_roles WHERE user_id = $1', [userId])).rows).toEqual(expectedRoles.rows)
    } finally {
      await blocker.query('ROLLBACK')
      await blocker.end()
    }
  })
})
