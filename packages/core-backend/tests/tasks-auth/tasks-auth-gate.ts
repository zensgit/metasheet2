import { randomUUID } from 'node:crypto'
import express from 'express'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { poolManager } from '../../src/integration/db/connection-pool'
import { tasksRouter } from '../../src/routes/tasks'

if (process.env.TASKS_AUTH_GATE_SETUP !== '1') {
  throw new Error('tasks auth gate must load dedicated setup before this file')
}
if (process.env.RBAC_BYPASS !== 'false' || process.env.RBAC_TOKEN_TRUST !== 'false') {
  throw new Error('tasks auth gate requires RBAC_BYPASS=false and RBAC_TOKEN_TRUST=false at import')
}

const JWT_SECRET = process.env.JWT_SECRET
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error('tasks auth gate requires a JWT_SECRET of at least 32 characters')
}

describe('tasks auth gate', () => {
  const stamp = randomUUID()
  const userId = `usr_tasks_auth_${stamp}`
  const roleId = `tasks_writer_${stamp}`
  const orgId = `org_tasks_auth_${stamp}`

  beforeAll(async () => {
    const db = poolManager.get()
    await db.query(
      `INSERT INTO permissions (code, name, description)
       VALUES
         ('tasks:read', 'Tasks Read', 'Read tasks in the caller org'),
         ('tasks:write', 'Tasks Write', 'Create and update tasks in the caller org'),
         ('tasks:admin', 'Tasks Admin', 'Administer task settings in the caller org')
       ON CONFLICT (code) DO NOTHING`,
    )
    await db.query(
      `INSERT INTO roles (id, name) VALUES ($1, $2)`,
      [roleId, roleId],
    )
    await db.query(
      `INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, 'tasks:write')`,
      [roleId],
    )
    await db.query(
      `INSERT INTO users (
         id, email, name, password_hash, role, permissions,
         is_active, activation_status, local_password_set, must_change_password
       )
       VALUES (
         $1, $2, $3, 'x', 'user', '[]'::jsonb,
         TRUE, 'activated', TRUE, FALSE
       )`,
      [userId, `${userId}@tasks-auth-gate.test`, 'tasks-auth'],
    )
    await db.query(
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`,
      [userId, roleId],
    )
    await db.query(
      `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)`,
      [userId, orgId],
    )
    await db.query(
      `INSERT INTO user_namespace_admissions (
         user_id, namespace, enabled, source, created_at, updated_at
       )
       VALUES ($1, 'tasks', TRUE, 'test', now(), now())`,
      [userId],
    )
  })

  afterAll(async () => {
    const db = poolManager.get()
    await db.query('DELETE FROM tasks WHERE org_id = $1', [orgId])
    await db.query('DELETE FROM user_namespace_admissions WHERE user_id = $1', [userId])
    await db.query('DELETE FROM user_roles WHERE user_id = $1', [userId])
    await db.query('DELETE FROM user_orgs WHERE user_id = $1', [userId])
    await db.query('DELETE FROM users WHERE id = $1', [userId])
    await db.query('DELETE FROM role_permissions WHERE role_id = $1', [roleId])
    await db.query('DELETE FROM roles WHERE id = $1', [roleId])
  })

  function token(): string {
    return jwt.sign({
      userId,
      sub: userId,
      email: `${userId}@tasks-auth-gate.test`,
      role: 'user',
      roles: [roleId],
      perms: ['tasks:read'],
      tenantId: orgId,
    }, JWT_SECRET, { expiresIn: '1h' })
  }

  function app(): express.Express {
    const router = tasksRouter()
    if (!router) throw new Error('tasks router must mount when the feature flag is true')
    const server = express()
    server.use(express.json())
    server.use(router)
    return server
  }

  it('mounts the read route and rejects a missing bearer', async () => {
    const response = await request(app()).get('/api/tasks/context')
    expect(response.status).toBe(401)
    expect(response.body).toEqual({
      ok: false,
      error: { code: 'UNAUTHORIZED', message: 'Missing Bearer token' },
    })
  })

  it('rejects a read route when the token claims tasks:read but the database only grants tasks:write', async () => {
    const response = await request(app())
      .get('/api/tasks/context')
      .set('Authorization', `Bearer ${token()}`)
    expect(response.status).toBe(403)
    expect(response.body).toEqual({ error: 'Insufficient permissions' })
  })

  it('allows POST /api/tasks when the database grants tasks:write', async () => {
    const response = await request(app())
      .post('/api/tasks')
      .set('Authorization', `Bearer ${token()}`)
      .send({ title: '备料复核' })
    expect(response.status).toBe(200)
    expect(String(response.body.id)).toMatch(/^tsk_/)
  })
})
