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
import { applyRecycleMove, applyRecycleRestore, applyRecyclePurge, applyRecycleRescrub, listDueRecycleUsers, purgeDueRecycleUsers } from '../../src/admin/user-recycle'
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
    const linkedAccountIds = (await query<{ id: string }>(
      `SELECT directory_account_id::text AS id
       FROM directory_account_links
       WHERE local_user_id = $1 AND link_status = 'linked'`,
      [userId],
    )).rows.map((row) => row.id)
    expect(linkedAccountIds.length).toBeGreaterThan(0)
    expect((await transaction(client => applyRecyclePurge(client, { userId, actorId: 'synthetic-operator', index: 0, passwordHash: 'synthetic-unusable' }))).ok).toBe(true)
    expect((await query('SELECT access_generation::int, is_active, email, hire_date, last_login_at, cumulative_service_start_date FROM users WHERE id = $1', [userId])).rows).toEqual([{
      access_generation: 4,
      is_active: false,
      email: null,
      hire_date: null,
      last_login_at: null,
      cumulative_service_start_date: null,
    }])
    expect((await query('SELECT role_id FROM user_roles WHERE user_id = $1', [userId])).rows).toEqual([])
    const scrubbed = await query(
      `SELECT a.name, a.email, a.mobile, a.is_active, l.link_status, l.local_user_id
       FROM directory_accounts a
       JOIN directory_account_links l ON l.directory_account_id = a.id
       WHERE a.id = ANY($1::uuid[])`,
      [linkedAccountIds],
    )
    expect(scrubbed.rows).toEqual([{
      name: '已清除用户',
      email: null,
      mobile: null,
      is_active: false,
      link_status: 'unlinked',
      local_user_id: null,
    }])
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

  async function ensureAuditPartition(at: string) {
    const meta = await query<{ name: string; start: string; finish: string }>(
      `SELECT
         'audit_logs_' || TO_CHAR(DATE_TRUNC('month', $1::timestamptz), 'YYYY_MM') AS name,
         DATE_TRUNC('month', $1::timestamptz)::text AS start,
         (DATE_TRUNC('month', $1::timestamptz) + INTERVAL '1 month')::text AS finish`,
      [at],
    )
    const name = meta.rows[0]?.name ?? ''
    const start = meta.rows[0]?.start ?? ''
    const finish = meta.rows[0]?.finish ?? ''
    if (!/^audit_logs_\d{4}_\d{2}$/.test(name) || !start || !finish) {
      throw new Error('audit partition bounds were not derived')
    }
    const literal = (value: string) => `'${value.replace(/'/g, "''")}'`
    await query(
      `CREATE TABLE IF NOT EXISTS ${name} PARTITION OF audit_logs FOR VALUES FROM (${literal(start)}) TO (${literal(finish)})`,
    )
  }

  async function insertAuditRow(input: {
    userId: string
    email: string
    name: string
    at: string
    resourceId?: string
    resourceType?: string
    action?: string
    details?: Record<string, unknown>
    requestBody?: Record<string, unknown> | null
    actorUserId?: number | null
    table?: 'audit_logs' | 'audit_logs_archive'
  }) {
    const table = input.table ?? 'audit_logs'
    if (table === 'audit_logs') await ensureAuditPartition(input.at)
    const details = input.details ?? { email: input.email, name: input.name }
    const requestBody = input.requestBody === undefined ? details : input.requestBody
    const inserted = await query<{ id: string; created_at: string }>(
      `INSERT INTO ${table} (
         event_type, event_category, action, resource_type, resource_id, resource_name,
         user_id, user_email, user_name, action_details, request_body, created_at
       ) VALUES (
         'UPDATE', 'USER', $6, $7, $1, $2,
         $9, $3, $2, $4::jsonb, $8::jsonb, $5::timestamptz
       )
       RETURNING id::text AS id, created_at::text AS created_at`,
      [
        input.resourceId ?? input.userId,
        input.name,
        input.email,
        JSON.stringify(details),
        input.at,
        input.action ?? 'update',
        input.resourceType ?? 'user',
        requestBody == null ? null : JSON.stringify(requestBody),
        input.actorUserId ?? null,
      ],
    )
    return inserted.rows[0]
  }

  async function rescrubAs(actorId: string, ids: string[], confirmText = '重新清理') {
    const app = express()
    app.use(express.json())
    app.use(adminUsersRouter())
    const jwt = authService.createToken({
      id: actorId,
      email: '',
      name: 'Synthetic',
      role: 'admin',
      permissions: [],
      created_at: new Date(),
      updated_at: new Date(),
    })
    return request(app)
      .post('/api/admin/users/recycle/rescrub')
      .auth(jwt, { type: 'bearer' })
      .send({ userIds: ids, confirmText })
  }

  async function seedPurgedUser(id = `recycle_review_${randomUUID()}`) {
    await query(
      `INSERT INTO users(id, username, email, name, password_hash, role, is_admin, is_active, activation_status, deleted_at, purged_at, purged_by)
       VALUES ($1, $1, $2, 'Synthetic user', 'synthetic-only', 'user', FALSE, FALSE, 'activated', NOW(), NOW(), 'synthetic-operator')`,
      [id, `${id}@example.test`],
    )
    return id
  }

  it('purges a user with microsecond audit rows and leaves unrelated audit rows untouched', async () => {
    const userId = await seedUser()
    const at = '2026-11-04 05:31:00.123456+00'
    const subject = await insertAuditRow({
      userId,
      email: `${userId}@example.test`,
      name: 'Synthetic user',
      at,
    })
    const unrelated = await insertAuditRow({
      userId,
      email: 'keep@example.test',
      name: 'Other person',
      at,
      resourceId: `other-${userId}`,
    })
    expect(subject.created_at).toContain('123456')
    expect((await move(userId)).ok).toBe(true)
    expect((await transaction(client => applyRecyclePurge(client, {
      userId,
      actorId: 'synthetic-operator',
      index: 0,
      passwordHash: 'synthetic-unusable',
    }))).ok).toBe(true)
    const scrubbed = await query(
      `SELECT created_at::text AS created_at, user_email, user_name, resource_name, action_details
       FROM audit_logs WHERE id = $1`,
      [subject.id],
    )
    expect(scrubbed.rows[0].created_at).toBe(subject.created_at)
    expect(scrubbed.rows[0].user_email).toBeNull()
    expect(scrubbed.rows[0].user_name).toBe('已清除用户')
    expect(scrubbed.rows[0].resource_name).toBe('已清除用户')
    expect(scrubbed.rows[0].action_details).toMatchObject({ email: null, name: '已清除用户' })
    const kept = await query(
      `SELECT created_at::text AS created_at, user_email, user_name, resource_name, action_details
       FROM audit_logs WHERE id = $1`,
      [unrelated.id],
    )
    expect(kept.rows[0].created_at).toBe(unrelated.created_at)
    expect(kept.rows[0].user_email).toBe('keep@example.test')
    expect(kept.rows[0].user_name).toBe('Other person')
    expect(kept.rows[0].resource_name).toBe('Other person')
    expect(kept.rows[0].action_details).toMatchObject({ email: 'keep@example.test', name: 'Other person' })
  })

  it('scrubs accountLabel on a create audit in both the live and archive logs', async () => {
    const userId = await seedUser()
    const at = '2026-11-04 05:31:00.123456+00'
    const email = `${userId}@example.test`
    const details = {
      email,
      username: userId,
      mobile: '13800001111',
      accountLabel: email,
      displayName: 'Synthetic user',
      phone: '13800001111',
      position: '装配',
      roleId: 'user',
      adminUserId: 'synthetic-operator',
    }
    const created = await insertAuditRow({
      userId,
      email,
      name: 'Synthetic user',
      at,
      action: 'create',
      details,
    })
    const archived = await insertAuditRow({
      userId,
      email,
      name: 'Synthetic user',
      at,
      action: 'create',
      details,
      table: 'audit_logs_archive',
    })
    const unrelated = await insertAuditRow({
      userId,
      email: 'keep@example.test',
      name: 'Other person',
      at,
      action: 'create',
      resourceId: `other-${userId}`,
      details: { accountLabel: 'keep@example.test', roleId: 'user' },
    })
    expect((await move(userId)).ok).toBe(true)
    expect((await transaction(client => applyRecyclePurge(client, {
      userId,
      actorId: 'synthetic-operator',
      index: 0,
      passwordHash: 'synthetic-unusable',
    }))).ok).toBe(true)
    for (const row of [
      { table: 'audit_logs', id: created.id },
      { table: 'audit_logs_archive', id: archived.id },
    ]) {
      const scrubbed = await query(
        `SELECT action_details FROM ${row.table} WHERE id = $1`,
        [row.id],
      )
      expect(scrubbed.rows[0].action_details).toMatchObject({
        email: null,
        username: null,
        mobile: null,
        accountLabel: null,
        displayName: '已清除用户',
        phone: null,
        position: null,
        roleId: 'user',
        adminUserId: 'synthetic-operator',
      })
    }
    expect((await query('SELECT action_details FROM audit_logs WHERE id = $1', [unrelated.id])).rows[0].action_details).toMatchObject({
      accountLabel: 'keep@example.test',
      roleId: 'user',
    })
  })

  it('rescrubs leftover accountLabel on an already purged user and rejects anyone not purged', async () => {
    const actorId = await seedUser(true)
    const userId = await seedUser()
    const email = `${userId}@example.test`
    expect((await move(userId)).ok).toBe(true)
    expect((await transaction(client => applyRecyclePurge(client, {
      userId,
      actorId,
      index: 0,
      passwordHash: 'synthetic-unusable',
    }))).ok).toBe(true)
    const before = (await query(
      'SELECT email, name, role, is_active, deleted_at IS NOT NULL AS deleted, purged_at IS NOT NULL AS purged FROM users WHERE id = $1',
      [userId],
    )).rows
    const at = '2026-11-04 05:31:00.123456+00'
    const details = {
      accountLabel: email,
      email,
      roleId: 'user',
      colleague: { id: 'other-person', accountLabel: 'keep@example.test' },
    }
    const live = await insertAuditRow({ userId, email, name: 'Synthetic user', at, action: 'create', details })
    const archived = await insertAuditRow({
      userId,
      email,
      name: 'Synthetic user',
      at,
      action: 'create',
      details,
      table: 'audit_logs_archive',
    })
    const app = express()
    app.use(express.json())
    app.use(adminUsersRouter())
    const jwt = authService.createToken({
      id: actorId,
      email: '',
      name: 'Synthetic',
      role: 'admin',
      permissions: [],
      created_at: new Date(),
      updated_at: new Date(),
    })
    const send = (ids: string[], confirmText = '重新清理') => request(app)
      .post('/api/admin/users/recycle/rescrub')
      .auth(jwt, { type: 'bearer' })
      .send({ userIds: ids, confirmText })

    const first = await send([userId])
    expect(first.status).toBe(200)
    expect(first.body.data.results[0]).toMatchObject({ ok: true, userId, code: null })
    for (const row of [
      { table: 'audit_logs', id: live.id },
      { table: 'audit_logs_archive', id: archived.id },
    ]) {
      const scrubbed = await query(`SELECT action_details FROM ${row.table} WHERE id = $1`, [row.id])
      expect(scrubbed.rows[0].action_details).toMatchObject({
        accountLabel: null,
        email: null,
        roleId: 'user',
        colleague: { id: 'other-person', accountLabel: 'keep@example.test' },
      })
    }
    expect((await query(
      'SELECT email, name, role, is_active, deleted_at IS NOT NULL AS deleted, purged_at IS NOT NULL AS purged FROM users WHERE id = $1',
      [userId],
    )).rows).toEqual(before)
    const auditRow = await query(
      `SELECT action_details FROM audit_logs
       WHERE resource_id = 'recycle-rescrub' AND action_details->>'adminUserId' = $1
       ORDER BY created_at DESC LIMIT 1`,
      [actorId],
    )
    expect(auditRow.rows[0].action_details).toMatchObject({ outcome: 'rescrubbed' })
    expect(JSON.stringify(auditRow.rows[0].action_details)).not.toContain(email)

    const second = await send([userId])
    expect(second.status).toBe(200)
    expect(second.body.data.results[0].ok).toBe(true)
    expect((await query('SELECT action_details FROM audit_logs WHERE id = $1', [live.id])).rows[0].action_details.accountLabel).toBeNull()
    expect((await query(
      'SELECT email, name, role, is_active, deleted_at IS NOT NULL AS deleted, purged_at IS NOT NULL AS purged FROM users WHERE id = $1',
      [userId],
    )).rows).toEqual(before)

    const activeId = await seedUser()
    const activeBefore = (await query('SELECT email, deleted_at, purged_at FROM users WHERE id = $1', [activeId])).rows
    const active = await send([activeId])
    expect(active.body.data.results[0].code).toBe('NOT_PURGED')
    expect((await query('SELECT email, deleted_at, purged_at FROM users WHERE id = $1', [activeId])).rows).toEqual(activeBefore)

    const binnedId = await seedUser()
    expect((await move(binnedId)).ok).toBe(true)
    const binnedBefore = (await query('SELECT email, deleted_at IS NOT NULL AS deleted, purged_at FROM users WHERE id = $1', [binnedId])).rows
    const binned = await send([binnedId])
    expect(binned.body.data.results[0].code).toBe('NOT_PURGED')
    expect((await query('SELECT email, deleted_at IS NOT NULL AS deleted, purged_at FROM users WHERE id = $1', [binnedId])).rows).toEqual(binnedBefore)
    expect((await query(
      `SELECT resource_name, user_name FROM audit_logs
       WHERE resource_type = 'user' AND action = 'rescrub' AND resource_id = ANY($1::text[])`,
      [[activeId, binnedId]],
    )).rows).toEqual([{ resource_name: null, user_name: null }, { resource_name: null, user_name: null }])
  })

  it.each(['audit_logs', 'audit_logs_archive'] as const)('rescrubs namespaced permission subjects without widening ownership in %s', async (table) => {
    const actorId = await seedUser(true)
    const userId = await seedPurgedUser()
    const email = `${userId}@example.test`
    const at = '2026-11-04 05:31:00.123456+00'
    const matched = []
    const permissions = ['tasks:read', 'approvals:*', 'tasks.read', '*', 'tasks:records:read', 'custom/read', '自定义权限']
    for (const permission of permissions) {
      matched.push(await insertAuditRow({
        userId, email, name: 'Synthetic subject', at, table,
        resourceType: 'permission', resourceId: `${userId}:${permission}`,
        details: { userId, email, accountLabel: email, permission, adminUserId: actorId },
      }))
    }
    const untouched = []
    for (const [resourceType, resourceId] of [
      ['permission', `${userId}-other:tasks:read`],
      ['permission', `other:${userId}:read`],
      ['permission', `${userId}::read`],
      ['permission', `${userId}:tasks:`],
      ['permission', userId],
      ['role', `${userId}:tasks:read`],
      ['permission-template', `${userId}:tasks:read`],
    ]) {
      untouched.push(await insertAuditRow({
        userId, email: 'keep@example.test', name: 'Keep identity', at, table,
        resourceType, resourceId,
      }))
    }
    const readUntouched = () => query(
      `SELECT id::text, xmin::text, resource_name, user_email, user_name, action_details, request_body
       FROM ${table} WHERE id = ANY($1::bigint[]) ORDER BY id`,
      [untouched.map(row => row.id)],
    )
    const before = (await readUntouched()).rows
    const response = await rescrubAs(actorId, [userId])
    expect(response.status).toBe(200)
    expect(response.body.data.results[0]).toMatchObject({ ok: true, userId })
    const cleaned = await query(
      `SELECT resource_id, resource_name, user_email, user_name, action_details, request_body
       FROM ${table} WHERE id = ANY($1::bigint[]) ORDER BY id`,
      [matched.map(row => row.id)],
    )
    expect(cleaned.rows).toHaveLength(permissions.length)
    for (const row of cleaned.rows) {
      expect(row).toMatchObject({ user_email: null, user_name: '已清除用户', resource_name: '已清除用户' })
      expect(row.action_details).toEqual({ userId, email: null, accountLabel: null, permission: row.resource_id.slice(userId.length + 1), adminUserId: actorId })
      expect(row.request_body).toEqual(row.action_details)
    }
    expect((await readUntouched()).rows).toEqual(before)
  })

  it('leaves clean audit rows and earlier receipts unchanged on consecutive rescrubs', async () => {
    const actorId = await seedUser(true)
    const userId = await seedPurgedUser()
    const tables = ['audit_logs', 'audit_logs_archive'] as const
    for (const table of tables) {
      await insertAuditRow({
        userId, email: `${userId}@example.test`, name: 'Legacy receipt',
        at: '2026-11-04 05:31:00.123456+00', table, action: 'rescrub',
        details: { outcome: 'rescrubbed', auditRowsUpdated: 1, adminUserId: actorId, email: `${userId}@example.test` },
      })
    }
    const readRows = async () => {
      const snapshots = []
      for (const table of tables) {
        const rows = await query(
          `SELECT id::text, created_at::text, xmin::text, resource_name, user_email, user_name, action_details, request_body
           FROM ${table} WHERE resource_type = 'user' AND resource_id = $1 ORDER BY id, created_at`,
          [userId],
        )
        snapshots.push({ table, rows: rows.rows })
      }
      return snapshots
    }
    const userBefore = (await query('SELECT xmin::text, to_jsonb(users) AS row FROM users WHERE id = $1', [userId])).rows
    const first = await rescrubAs(actorId, [userId])
    expect(first.status).toBe(200)
    let previous = await readRows()
    expect(previous.map(snapshot => snapshot.rows.length)).toEqual([2, 1])
    expect(previous[0].rows[1].action_details).toEqual({ outcome: 'rescrubbed', auditRowsUpdated: 2, adminUserId: actorId })
    for (const snapshot of previous) {
      expect(snapshot.rows[0].action_details.email).toBeNull()
    }
    for (const receiptCount of [2, 3]) {
      const response = await rescrubAs(actorId, [userId])
      expect(response.status).toBe(200)
      expect(response.body.data.results[0]).toMatchObject({ ok: true, userId })
      const current = await readRows()
      for (const [index, snapshot] of previous.entries()) {
        expect(current[index].rows.filter(row => snapshot.rows.some(old => old.id === row.id && old.created_at === row.created_at))).toEqual(snapshot.rows)
      }
      expect(current.map(snapshot => snapshot.rows.length)).toEqual([receiptCount + 1, 1])
      expect(current[0].rows[receiptCount].action_details).toEqual({ outcome: 'rescrubbed', auditRowsUpdated: 0, adminUserId: actorId })
      previous = current
    }
    expect((await query('SELECT xmin::text, to_jsonb(users) AS row FROM users WHERE id = $1', [userId])).rows).toEqual(userBefore)
  })

  it('does not rewrite residual directory accounts, links, or alias conflicts', async () => {
    const actorId = await seedUser(true)
    const userId = await seedUser()
    expect((await move(userId)).ok).toBe(true)
    expect((await transaction(client => applyRecyclePurge(client, {
      userId,
      actorId,
      index: 0,
      passwordHash: 'synthetic-unusable',
    }))).ok).toBe(true)
    const integrationId = randomUUID()
    const accountId = randomUUID()
    await query(
      `INSERT INTO directory_integrations(id, org_id, provider, name, corp_id, sync_enabled)
       VALUES ($1::uuid, 'default', 'dingtalk', $1::text, $1::text, FALSE)`,
      [integrationId],
    )
    await query(
      `INSERT INTO directory_accounts(
         id, integration_id, provider, corp_id, external_user_id, external_key,
         name, nick, email, mobile, job_number, title, avatar_url, org_email, open_id, union_id,
         raw, is_active
       ) VALUES (
         $1::uuid, $2::uuid, 'dingtalk', $2::text, $1::text, $1::text,
         'Residual name', 'nick', 'residual@example.test', '13800000000', 'E-9', '装配', 'avatar', 'org@example.test', 'open', 'union',
         '{"email":"residual@example.test"}'::jsonb, TRUE
       )`,
      [accountId, integrationId],
    )
    await query(
      `INSERT INTO directory_account_links(directory_account_id, local_user_id, link_status)
       VALUES ($1::uuid, $2, 'linked')`,
      [accountId, userId],
    )
    const collision = await query<{ id: string }>(
      `INSERT INTO user_login_alias_collision_report(normalized_value, kind, candidate_user_ids, reason)
       VALUES ('residual@example.test', 'email', ARRAY[$1]::text[], 'synthetic')
       RETURNING id::text AS id`,
      [userId],
    )
    const collisionId = collision.rows[0].id
    const readVersions = async () => {
      const account = await query(
        `SELECT xmin::text AS xmin, name, nick, email, mobile, job_number, title, avatar_url, org_email,
                open_id, union_id, raw, is_active, external_user_id, external_key
         FROM directory_accounts WHERE id = $1::uuid`,
        [accountId],
      )
      const link = await query(
        `SELECT xmin::text AS xmin, local_user_id, link_status
         FROM directory_account_links WHERE directory_account_id = $1::uuid`,
        [accountId],
      )
      const report = await query(
        `SELECT xmin::text AS xmin, normalized_value, candidate_user_ids, reason
         FROM user_login_alias_collision_report WHERE id = $1::uuid`,
        [collisionId],
      )
      return { account: account.rows[0], link: link.rows[0], report: report.rows[0] }
    }
    const before = await readVersions()
    const response = await rescrubAs(actorId, [userId])
    expect(response.status).toBe(200)
    expect(response.body.data.results[0]).toMatchObject({ ok: true, userId })
    expect(await readVersions()).toEqual(before)
  })

  it('keeps a subject email cleared when an actor rescrub commits a stale read', async () => {
    const aId = await seedPurgedUser()
    const bId = String(1_600_000_000 + Math.floor(Math.random() * 400_000_000))
    await seedPurgedUser(bId)
    const at = '2026-11-04 05:31:00.123456+00'
    const secret = `actor-race-${randomUUID()}@example.test`
    const shared = await insertAuditRow({
      userId: aId,
      email: secret,
      name: 'Synthetic user',
      at,
      action: 'create',
      resourceType: 'user',
      resourceId: aId,
      actorUserId: Number(bId),
      details: { email: secret, accountLabel: secret, roleId: 'user' },
      requestBody: { email: secret, accountLabel: secret },
    })
    let releaseWrite!: () => void
    let markRead!: () => void
    const readGate = new Promise<void>((resolve) => { markRead = resolve })
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve })
    const actor = new Client({ connectionString: process.env.DATABASE_URL })
    await actor.connect()
    let actorRead = false
    const wrapped = {
      query: async (statement: string, params?: unknown[]) => {
        if (statement.includes('UPDATE') && statement.includes('audit_logs') && JSON.stringify(params ?? []).includes(secret)) {
          throw new Error('actor rescrub wrote the subject snapshot')
        }
        const result = await actor.query(statement, params)
        const liveSelect = statement.includes('FROM audit_logs')
          && !statement.includes('audit_logs_archive')
          && statement.includes('action_details')
          && !statement.includes('UPDATE')
          && !statement.includes('INSERT')
        if (!actorRead && liveSelect) {
          actorRead = true
          markRead()
          await writeGate
        }
        return result
      },
    }
    await actor.query('BEGIN')
    const actorRun = applyRecycleRescrub(wrapped, { userId: bId, actorId: 'synthetic-operator', index: 0 })
    let committed = false
    try {
      await Promise.race([
        readGate,
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error('actor rescrub did not read the shared audit row')), 8000)),
      ])
      const subjectRun = await transaction((client) => applyRecycleRescrub(client, {
        userId: aId,
        actorId: 'synthetic-operator',
        index: 0,
      }))
      expect(subjectRun.ok).toBe(true)
      releaseWrite()
      const actorResult = await actorRun
      expect(actorResult.ok).toBe(true)
      await actor.query('COMMIT')
      committed = true
      const finalRow = await query(
        `SELECT action_details, request_body FROM audit_logs WHERE id = $1`,
        [shared.id],
      )
      expect(finalRow.rows[0].action_details).toMatchObject({ email: null, accountLabel: null, roleId: 'user' })
      expect(finalRow.rows[0].request_body).toEqual({ email: null, accountLabel: null })
      expect(JSON.stringify(finalRow.rows[0])).not.toContain(secret)
    } finally {
      releaseWrite()
      await actorRun.catch(() => undefined)
      if (!committed) await actor.query('ROLLBACK').catch(() => undefined)
      await actor.end()
    }
  })

  it('cleans a user audit and leaves a role that reused the same id', async () => {
    const actorId = await seedUser(true)
    const userId = await seedUser()
    const email = `${userId}@example.test`
    expect((await move(userId)).ok).toBe(true)
    expect((await transaction(client => applyRecyclePurge(client, {
      userId,
      actorId,
      index: 0,
      passwordHash: 'synthetic-unusable',
    }))).ok).toBe(true)
    const at = '2026-11-04 05:31:00.123456+00'
    const role = await insertAuditRow({
      userId,
      email: 'role-admin@example.test',
      name: 'Warehouse lead',
      at,
      action: 'create',
      resourceType: 'role',
      resourceId: userId,
      details: { name: 'Warehouse lead', permissions: ['roles.read'] },
      requestBody: { name: 'Warehouse lead' },
    })
    const userRow = await insertAuditRow({
      userId,
      email,
      name: 'Synthetic user',
      at,
      action: 'create',
      resourceType: 'user',
      details: { accountLabel: email, email, name: 'Synthetic user', roleId: 'user' },
    })
    const before = await query(
      `SELECT xmin::text AS xmin, action_details, resource_name FROM audit_logs WHERE id = $1`,
      [role.id],
    )
    const response = await rescrubAs(actorId, [userId])
    expect(response.status).toBe(200)
    expect(response.body.data.results[0].ok).toBe(true)
    const after = await query(
      `SELECT xmin::text AS xmin, action_details, resource_name FROM audit_logs WHERE id = $1`,
      [role.id],
    )
    expect(after.rows).toEqual(before.rows)
    const cleaned = await query(`SELECT action_details, resource_name FROM audit_logs WHERE id = $1`, [userRow.id])
    expect(cleaned.rows[0].action_details).toMatchObject({
      accountLabel: null,
      email: null,
      name: '已清除用户',
      roleId: 'user',
    })
    expect(cleaned.rows[0].resource_name).toBe('已清除用户')
  })

  it('records an unmatched email only as a fixed not-found reason', async () => {
    const actorId = await seedUser(true)
    const userId = await seedPurgedUser()
    const email = `missing-${randomUUID()}@example.test`
    const watermark = (await query<{ id: string }>(`SELECT COALESCE(MAX(id), 0)::text AS id FROM audit_logs`)).rows[0].id
    const response = await rescrubAs(actorId, [email, userId])
    expect(response.status).toBe(200)
    expect(response.body.data.results.map((row: { code: string | null; ok: boolean }) => ({ code: row.code, ok: row.ok }))).toEqual([
      { code: 'USER_NOT_FOUND', ok: false },
      { code: null, ok: true },
    ])
    const receipts = await query<{
      resource_id: string | null
      action: string
      details: string
      body: string
      user_email: string
      user_name: string
      resource_name: string
      error_message: string
    }>(
      `SELECT resource_id, action, action_details::text AS details,
              COALESCE(request_body::text, '') AS body,
              COALESCE(user_email, '') AS user_email,
              COALESCE(user_name, '') AS user_name,
              COALESCE(resource_name, '') AS resource_name,
              COALESCE(error_message, '') AS error_message
       FROM audit_logs
       WHERE id > $1::bigint`,
      [watermark],
    )
    expect(receipts.rows.length).toBeGreaterThan(0)
    for (const row of receipts.rows) {
      expect(JSON.stringify(row)).not.toContain(email)
    }
    expect(receipts.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'rescrub', resource_id: userId }),
      expect.objectContaining({ action: 'rescrub', resource_id: null, resource_name: '', user_name: '' }),
      expect.objectContaining({ action: 'update', resource_id: 'recycle-rescrub' }),
    ]))
    const notFound = receipts.rows.find((row) => row.action === 'rescrub' && row.resource_id == null)
    expect(notFound?.details).toContain('USER_NOT_FOUND')
    expect(receipts.rows.find((row) => row.resource_id === userId)?.details).toContain('rescrubbed')
    const archived = await query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM audit_logs_archive
       WHERE resource_id = $1 OR COALESCE(action_details::text, '') LIKE $2`,
      [email, `%${email}%`],
    )
    expect(archived.rows[0].c).toBe(0)
  })

  it('keeps the operator on earlier receipts when a later item aborts the summary', async () => {
    const actorId = await seedUser(true)
    const firstId = await seedPurgedUser()
    const secondId = await seedPurgedUser()
    const marker = `later-item-${randomUUID()}@example.test`
    const at = '2026-11-04 05:31:00.123456+00'
    const secondRow = await insertAuditRow({
      userId: secondId,
      email: marker,
      name: 'Synthetic user',
      at,
      action: 'create',
      details: { accountLabel: marker, email: marker },
    })
    const before = await query(`SELECT action_details, user_email FROM audit_logs WHERE id = $1`, [secondRow.id])
    const watermark = (await query<{ id: string }>(`SELECT COALESCE(MAX(id), 0)::text AS id FROM audit_logs`)).rows[0].id
    await query(`
      CREATE OR REPLACE FUNCTION synthetic_rescrub_later_item_fail() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      BEGIN
        IF OLD.user_email = '${marker.replace(/'/g, "''")}' THEN
          RAISE EXCEPTION 'synthetic later rescrub failure';
        END IF;
        RETURN NEW;
      END
      $fn$
    `)
    await query(`
      DROP TRIGGER IF EXISTS synthetic_rescrub_later_item_fail ON audit_logs;
      CREATE TRIGGER synthetic_rescrub_later_item_fail
      BEFORE UPDATE ON audit_logs
      FOR EACH ROW EXECUTE FUNCTION synthetic_rescrub_later_item_fail()
    `)
    try {
      const response = await rescrubAs(actorId, [firstId, secondId])
      expect(response.status).toBe(500)
      expect(response.body.error.code).toBe('RECYCLE_RESCRUB_FAILED')
      const receipts = await query<{ resource_id: string | null; action_details: { adminUserId?: string; outcome?: string } }>(
        `SELECT resource_id, action_details
         FROM audit_logs
         WHERE id > $1::bigint AND action = 'rescrub'`,
        [watermark],
      )
      expect(receipts.rows).toEqual([
        expect.objectContaining({
          resource_id: firstId,
          action_details: expect.objectContaining({ adminUserId: actorId, outcome: 'rescrubbed' }),
        }),
      ])
      expect((await query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM audit_logs
         WHERE id > $1::bigint AND resource_id = 'recycle-rescrub'`,
        [watermark],
      )).rows).toEqual([{ c: 0 }])
      expect((await query(`SELECT action_details, user_email FROM audit_logs WHERE id = $1`, [secondRow.id])).rows).toEqual(before.rows)
    } finally {
      await query('DROP TRIGGER IF EXISTS synthetic_rescrub_later_item_fail ON audit_logs')
      await query('DROP FUNCTION IF EXISTS synthetic_rescrub_later_item_fail()')
    }
  })

  it('keeps the operator on per-item receipts when the batch summary write fails', async () => {
    const actorId = await seedUser(true)
    const userId = await seedPurgedUser()
    const watermark = (await query<{ id: string }>(`SELECT COALESCE(MAX(id), 0)::text AS id FROM audit_logs`)).rows[0].id
    await query(`
      CREATE OR REPLACE FUNCTION synthetic_rescrub_batch_summary_fail() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.resource_id = 'recycle-rescrub' THEN
          RAISE EXCEPTION 'synthetic rescrub batch summary failure';
        END IF;
        RETURN NEW;
      END
      $fn$
    `)
    await query(`
      DROP TRIGGER IF EXISTS synthetic_rescrub_batch_summary_fail ON audit_logs;
      CREATE TRIGGER synthetic_rescrub_batch_summary_fail
      BEFORE INSERT ON audit_logs
      FOR EACH ROW EXECUTE FUNCTION synthetic_rescrub_batch_summary_fail()
    `)
    try {
      const response = await rescrubAs(actorId, [userId])
      expect(response.status).toBe(200)
      expect(response.body.data.results[0]).toMatchObject({ ok: true, userId })
      const receipts = await query<{ resource_id: string | null; action_details: { adminUserId?: string; outcome?: string } }>(
        `SELECT resource_id, action_details
         FROM audit_logs
         WHERE id > $1::bigint AND action = 'rescrub'`,
        [watermark],
      )
      expect(receipts.rows).toEqual([
        expect.objectContaining({
          resource_id: userId,
          action_details: expect.objectContaining({ adminUserId: actorId, outcome: 'rescrubbed' }),
        }),
      ])
      expect((await query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM audit_logs
         WHERE id > $1::bigint AND resource_id = 'recycle-rescrub'`,
        [watermark],
      )).rows).toEqual([{ c: 0 }])
    } finally {
      await query('DROP TRIGGER IF EXISTS synthetic_rescrub_batch_summary_fail ON audit_logs')
      await query('DROP FUNCTION IF EXISTS synthetic_rescrub_batch_summary_fail()')
    }
  })

  it('rolls the audit rewrite back when the per-item receipt insert fails', async () => {
    const actorId = await seedUser(true)
    const userId = await seedUser()
    const email = `${userId}@example.test`
    expect((await move(userId)).ok).toBe(true)
    expect((await transaction(client => applyRecyclePurge(client, {
      userId,
      actorId,
      index: 0,
      passwordHash: 'synthetic-unusable',
    }))).ok).toBe(true)
    const at = '2026-11-04 05:31:00.123456+00'
    const live = await insertAuditRow({
      userId,
      email,
      name: 'Synthetic user',
      at,
      action: 'create',
      details: { accountLabel: email, email, roleId: 'user' },
    })
    const before = await query(`SELECT action_details, user_email, resource_name FROM audit_logs WHERE id = $1`, [live.id])
    await query(`
      CREATE OR REPLACE FUNCTION synthetic_rescrub_receipt_fail() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.action = 'rescrub' THEN
          RAISE EXCEPTION 'synthetic rescrub receipt failure';
        END IF;
        RETURN NEW;
      END
      $fn$
    `)
    await query(`
      DROP TRIGGER IF EXISTS synthetic_rescrub_receipt_fail ON audit_logs;
      CREATE TRIGGER synthetic_rescrub_receipt_fail
      BEFORE INSERT ON audit_logs
      FOR EACH ROW EXECUTE FUNCTION synthetic_rescrub_receipt_fail()
    `)
    try {
      const response = await rescrubAs(actorId, [userId])
      expect(response.status).toBe(200)
      expect(response.body.data.results[0]).toMatchObject({ ok: false, code: 'RESCRUB_RECEIPT_FAILED' })
      expect((await query(`SELECT action_details, user_email, resource_name FROM audit_logs WHERE id = $1`, [live.id])).rows).toEqual(before.rows)
      expect((await query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM audit_logs WHERE action = 'rescrub' AND resource_id = $1`,
        [userId],
      )).rows).toEqual([{ c: 0 }])
      const batch = await query<{ action_details: { failureCount?: number; successCount?: number } }>(
        `SELECT action_details FROM audit_logs
         WHERE resource_id = 'recycle-rescrub' AND action_details->>'adminUserId' = $1
         ORDER BY created_at DESC LIMIT 1`,
        [actorId],
      )
      expect(batch.rows[0].action_details).toMatchObject({ successCount: 0, failureCount: 1 })
      expect(JSON.stringify(batch.rows[0].action_details)).not.toContain(email)
    } finally {
      await query('DROP TRIGGER IF EXISTS synthetic_rescrub_receipt_fail ON audit_logs')
      await query('DROP FUNCTION IF EXISTS synthetic_rescrub_receipt_fail()')
    }
  })

  it('rolls back the whole purge when audit scrub fails', async () => {
    const userId = await seedUser()
    const at = '2026-11-04 05:31:00.654321+00'
    const subject = await insertAuditRow({
      userId,
      email: 'scrub-fail@example.test',
      name: 'Synthetic user',
      at,
    })
    await query(`
      CREATE OR REPLACE FUNCTION synthetic_recycle_audit_scrub_fail() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      BEGIN
        IF OLD.user_email = 'scrub-fail@example.test' THEN
          RAISE EXCEPTION 'synthetic audit scrub failure';
        END IF;
        RETURN NEW;
      END
      $fn$
    `)
    await query(`
      DROP TRIGGER IF EXISTS synthetic_recycle_audit_scrub_fail ON audit_logs;
      CREATE TRIGGER synthetic_recycle_audit_scrub_fail
      BEFORE UPDATE ON audit_logs
      FOR EACH ROW EXECUTE FUNCTION synthetic_recycle_audit_scrub_fail()
    `)
    try {
      expect((await move(userId)).ok).toBe(true)
      const before = await query('SELECT email, name, purged_at FROM users WHERE id = $1', [userId])
      await expect(transaction(client => applyRecyclePurge(client, {
        userId,
        actorId: 'synthetic-operator',
        index: 0,
        passwordHash: 'synthetic-unusable',
      }))).rejects.toThrow(/synthetic audit scrub failure/)
      expect((await query('SELECT email, name, purged_at FROM users WHERE id = $1', [userId])).rows).toEqual(before.rows)
      expect((await query('SELECT user_email, action_details FROM audit_logs WHERE id = $1', [subject.id])).rows).toEqual([{
        user_email: 'scrub-fail@example.test',
        action_details: { email: 'scrub-fail@example.test', name: 'Synthetic user' },
      }])
    } finally {
      await query('DROP TRIGGER IF EXISTS synthetic_recycle_audit_scrub_fail ON audit_logs')
      await query('DROP FUNCTION IF EXISTS synthetic_recycle_audit_scrub_fail()')
    }
  })

  it('sweeper purges a due account that has audit rows and does not count a scrub failure as success', async () => {
    const now = new Date()
    const userId = await seedUser()
    const at = '2026-11-04 05:31:00.111111+00'
    const subject = await insertAuditRow({
      userId,
      email: `${userId}@example.test`,
      name: 'Synthetic user',
      at,
    })
    expect((await move(userId, new Date(now.getTime() - 40 * 86400000))).ok).toBe(true)
    expect(await purgeDueRecycleUsers(now)).toBeGreaterThan(0)
    expect((await query('SELECT email, purged_at IS NOT NULL AS purged FROM users WHERE id = $1', [userId])).rows).toEqual([{
      email: null,
      purged: true,
    }])
    expect((await query('SELECT user_email, created_at::text AS created_at FROM audit_logs WHERE id = $1', [subject.id])).rows).toEqual([{
      user_email: null,
      created_at: subject.created_at,
    }])

    const failedId = await seedUser()
    await insertAuditRow({
      userId: failedId,
      email: 'scrub-fail@example.test',
      name: 'Synthetic user',
      at: '2026-11-04 05:31:00.222222+00',
    })
    expect((await move(failedId, new Date(now.getTime() - 40 * 86400000))).ok).toBe(true)
    await query(`
      CREATE OR REPLACE FUNCTION synthetic_recycle_audit_scrub_fail() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      BEGIN
        IF OLD.user_email = 'scrub-fail@example.test' THEN
          RAISE EXCEPTION 'synthetic audit scrub failure';
        END IF;
        RETURN NEW;
      END
      $fn$
    `)
    await query(`
      DROP TRIGGER IF EXISTS synthetic_recycle_audit_scrub_fail ON audit_logs;
      CREATE TRIGGER synthetic_recycle_audit_scrub_fail
      BEFORE UPDATE ON audit_logs
      FOR EACH ROW EXECUTE FUNCTION synthetic_recycle_audit_scrub_fail()
    `)
    try {
      await expect(purgeDueRecycleUsers(now)).rejects.toThrow(/synthetic audit scrub failure/)
      expect((await query('SELECT email, purged_at FROM users WHERE id = $1', [failedId])).rows).toEqual([{
        email: `${failedId}@example.test`,
        purged_at: null,
      }])
    } finally {
      await query('DROP TRIGGER IF EXISTS synthetic_recycle_audit_scrub_fail ON audit_logs')
      await query('DROP FUNCTION IF EXISTS synthetic_recycle_audit_scrub_fail()')
    }
  })
})
