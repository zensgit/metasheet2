/**
 * Gate 2 and gate 13 under RBAC_TOKEN_TRUST=true (integration setup).
 * Tokens do not carry perms. Static paths are registered before /:id.
 */
import '../helpers/assert-rbac-optional-off'
import { randomUUID } from 'node:crypto'
import express from 'express'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { poolManager } from '../../src/integration/db/connection-pool'
import { tasksRouter } from '../../src/routes/tasks'

if (process.env.EXPECT_DB !== '1') {
  throw new Error('task-rbac-trust.db.test.ts requires EXPECT_DB=1')
}
if (process.env.RBAC_TOKEN_TRUST !== 'true') {
  throw new Error('gate 2 harness requires RBAC_TOKEN_TRUST=true')
}

const JWT_SECRET = process.env.JWT_SECRET
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error('task-rbac-trust.db.test.ts requires JWT_SECRET')
}

describe('gate 2 and gate 13 under token trust', () => {
  const stamp = randomUUID()
  const orgId = `org_trust_${stamp}`

  function token(userId: string, roleId: string): string {
    return jwt.sign({
      userId,
      sub: userId,
      email: `${userId}@tasks-trust.test`,
      role: 'user',
      roles: [roleId],
      tenantId: orgId,
    }, JWT_SECRET, { expiresIn: '1h' })
  }

  async function userWith(opts: {
    label: string
    codes: string[]
    admission: boolean
    direct?: string[]
  }): Promise<{ userId: string; roleId: string; bearer: string }> {
    const userId = `usr_${opts.label}_${stamp}`
    const roleId = `role_${opts.label}_${stamp}`
    const db = poolManager.get()
    await db.query('INSERT INTO roles (id, name) VALUES ($1, $2)', [roleId, roleId])
    for (const code of opts.codes) {
      await db.query(
        'INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, $2)',
        [roleId, code],
      )
    }
    await db.query(
      `INSERT INTO users (
         id, email, name, password_hash, role, permissions,
         is_active, activation_status, local_password_set, must_change_password
       ) VALUES (
         $1, $2, $3, 'x', 'user', '[]'::jsonb, TRUE, 'activated', TRUE, FALSE
       )`,
      [userId, `${userId}@tasks-trust.test`, opts.label],
    )
    await db.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [userId, roleId])
    await db.query(
      'INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)',
      [userId, orgId],
    )
    if (opts.admission) {
      await db.query(
        `INSERT INTO user_namespace_admissions (
           user_id, namespace, enabled, source, created_at, updated_at
         ) VALUES ($1, 'tasks', TRUE, 'test', now(), now())`,
        [userId],
      )
    }
    for (const code of opts.direct ?? []) {
      await db.query(
        'INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, $2)',
        [userId, code],
      )
    }
    return { userId, roleId, bearer: token(userId, roleId) }
  }

  function app(): express.Express {
    const router = tasksRouter()
    if (!router) throw new Error('tasks router must mount')
    const server = express()
    server.use(express.json())
    server.use(router)
    return server
  }

  beforeAll(async () => {
    await poolManager.get().query(
      `INSERT INTO permissions (code, name, description) VALUES
         ('tasks:read', 'Tasks Read', 'read'),
         ('tasks:write', 'Tasks Write', 'write'),
         ('tasks:admin', 'Tasks Admin', 'admin')
       ON CONFLICT (code) DO NOTHING`,
    )
  })

  afterAll(async () => {
    const db = poolManager.get()
    await db.query('DELETE FROM tasks WHERE org_id = $1', [orgId])
    await db.query(`DELETE FROM user_namespace_admissions WHERE user_id LIKE $1`, [`%_${stamp}`])
    await db.query(`DELETE FROM user_permissions WHERE user_id LIKE $1`, [`%_${stamp}`])
    await db.query(`DELETE FROM user_roles WHERE user_id LIKE $1`, [`%_${stamp}`])
    await db.query(`DELETE FROM user_orgs WHERE user_id LIKE $1`, [`%_${stamp}`])
    await db.query(`DELETE FROM users WHERE id LIKE $1`, [`%_${stamp}`])
    await db.query(`DELETE FROM role_permissions WHERE role_id LIKE $1`, [`role_%_${stamp}`])
    await db.query(`DELETE FROM roles WHERE id LIKE $1`, [`role_%_${stamp}`])
  })

  it('grants 200 when the role has the code and admission exists', async () => {
    const actor = await userWith({ label: 'full', codes: ['tasks:read', 'tasks:write'], admission: true })
    const response = await request(app())
      .post('/api/tasks')
      .set('Authorization', `Bearer ${actor.bearer}`)
      .send({ title: '备料复核' })
    expect(response.status).toBe(200)
  })

  it('returns 403 when the role has no tasks permission', async () => {
    const actor = await userWith({ label: 'nocode', codes: [], admission: true })
    const response = await request(app())
      .get('/api/tasks/context')
      .set('Authorization', `Bearer ${actor.bearer}`)
    expect(response.status).toBe(403)
    expect(response.body).toEqual({ error: 'Insufficient permissions' })
  })

  it('returns 403 when admission is missing', async () => {
    const actor = await userWith({ label: 'noadmit', codes: ['tasks:read'], admission: false })
    const response = await request(app())
      .get('/api/tasks/context')
      .set('Authorization', `Bearer ${actor.bearer}`)
    expect(response.status).toBe(403)
    expect(response.body).toEqual({ error: 'Insufficient permissions' })
  })

  it('returns 403 when the role only has a different tasks code', async () => {
    const actor = await userWith({ label: 'writeonly', codes: ['tasks:write'], admission: true })
    const response = await request(app())
      .get('/api/tasks/context')
      .set('Authorization', `Bearer ${actor.bearer}`)
    expect(response.status).toBe(403)
    expect(response.body).toEqual({ error: 'Insufficient permissions' })
  })

  it('rejects a role_permissions row whose permission code does not exist', async () => {
    const roleId = `role_missing_perm_${stamp}`
    await poolManager.get().query('INSERT INTO roles (id, name) VALUES ($1, $2)', [roleId, roleId])
    await expect(poolManager.get().query(
      'INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, $2)',
      [roleId, `tasks:missing_${stamp}`],
    )).rejects.toMatchObject({ code: '23503', constraint: 'role_permissions_permission_code_fkey' })
    await poolManager.get().query('DELETE FROM roles WHERE id = $1', [roleId])
  })

  it('returns 403 for a direct grant when no role carries a tasks code', async () => {
    const actor = await userWith({ label: 'direct', codes: [], admission: true, direct: ['tasks:read'] })
    const response = await request(app())
      .get('/api/tasks/context')
      .set('Authorization', `Bearer ${actor.bearer}`)
    expect(response.status).toBe(403)
    expect(response.body).toEqual({ error: 'Insufficient permissions' })
  })

  it('gate 13: context, pending, and pending-count answer before :id', async () => {
    const actor = await userWith({ label: 'paths', codes: ['tasks:read', 'tasks:write'], admission: true })
    const server = app()
    const context = await request(server).get('/api/tasks/context').set('Authorization', `Bearer ${actor.bearer}`)
    const pending = await request(server).get('/api/tasks/pending').set('Authorization', `Bearer ${actor.bearer}`)
    const count = await request(server).get('/api/tasks/pending-count').set('Authorization', `Bearer ${actor.bearer}`)
    expect(context.body.orgId).toBe(orgId)
    expect(Array.isArray(pending.body.items)).toBe(true)
    expect(typeof count.body.count).toBe('number')
    const missing = await request(server).get('/api/tasks/pending-count-not-a-task').set('Authorization', `Bearer ${actor.bearer}`)
    expect(missing.status).toBe(404)
    expect(missing.body).toEqual({ error: { code: 'NOT_FOUND' } })
  })
})
