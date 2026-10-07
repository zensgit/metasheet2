/**
 * HTTP transport for the task real-DB and auth-gate files (M3R2-CONC-6).
 *
 * One listener per test file, started once and closed in `afterAll`, instead
 * of `supertest(app)` binding a fresh ephemeral listener for every request.
 * Every request is sent with `Connection: close` on a non-keep-alive agent,
 * so no socket outlives its response and nothing is reused across requests.
 *
 * Also hosts the per-file RBAC actor fixture used by the membership and
 * comment files, which records every row it inserts so `cleanup()` can
 * remove them (M3R2-TM-9).
 */
import http from 'node:http'
import express from 'express'
import jwt from 'jsonwebtoken'
import supertest from 'supertest'
import { poolManager } from '../../src/integration/db/connection-pool'
import { tasksRouter } from '../../src/routes/tasks'

const noKeepAlive = new http.Agent({ keepAlive: false })

export interface TasksListener {
  baseUrl: string
  port: number
  close: () => Promise<void>
}

export async function startTasksListener(router: express.Router | null = tasksRouter()): Promise<TasksListener> {
  if (!router) throw new Error('tasks router must mount when the feature flag is true')
  const app = express()
  app.use(express.json())
  app.use(router)
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve())
    server.once('error', reject)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('expected a network address')
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    port: address.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

export interface TasksClient {
  get: (path: string) => supertest.Test
  post: (path: string) => supertest.Test
  patch: (path: string) => supertest.Test
  delete: (path: string) => supertest.Test
}

/** supertest against the shared listener; `Connection: close`, no keep-alive. */
export function tasksClient(baseUrl: string): TasksClient {
  if (!baseUrl) throw new Error('tasks listener not started')
  const agent = supertest(baseUrl)
  const wrap = (test: supertest.Test): supertest.Test => test.agent(noKeepAlive).set('Connection', 'close')
  return {
    get: (path) => wrap(agent.get(path)),
    post: (path) => wrap(agent.post(path)),
    patch: (path) => wrap(agent.patch(path)),
    delete: (path) => wrap(agent.delete(path)),
  }
}

/** Sends the path bytes exactly as written. */
export function rawRequest(
  port: number,
  method: string,
  path: string,
  bearer: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8')
    const headers: Record<string, string> = { Authorization: `Bearer ${bearer}`, Connection: 'close' }
    if (payload) {
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = String(payload.length)
    }
    const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent: noKeepAlive }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let parsed: unknown = undefined
        try { parsed = text.length > 0 ? JSON.parse(text) : undefined } catch { parsed = text }
        resolve({ status: res.statusCode ?? 0, body: parsed })
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

/**
 * §12.0's three things for a non-admin to reach a tasks route: a `permissions`
 * seed (done by the P0-A migration), a role carrying `tasks:*` in
 * `role_permissions`, and a `user_namespace_admissions(user_id, 'tasks',
 * enabled=true)` row, plus `user_orgs` for the token's tenant. Idempotent per
 * (orgId, userId). Every user id is recorded so `cleanup()` removes the rows.
 */
export function createActorFixture(emailDomain: string, jwtSecret: string): {
  bearer: (orgId: string, userId: string) => Promise<string>
  cleanup: () => Promise<void>
} {
  const created = new Set<string>()
  return {
    async bearer(orgId, userId) {
      const db = poolManager.get()
      const roleId = `role_${userId}`
      created.add(userId)
      await db.query('INSERT INTO roles (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [roleId, roleId])
      await db.query(
        `INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, 'tasks:read'), ($1, 'tasks:write')
         ON CONFLICT (role_id, permission_code) DO NOTHING`,
        [roleId],
      )
      await db.query(
        `INSERT INTO users (
           id, email, name, password_hash, role, permissions,
           is_active, activation_status, local_password_set, must_change_password
         ) VALUES ($1, $2, $3, 'x', 'user', '[]'::jsonb, TRUE, 'activated', TRUE, FALSE)
         ON CONFLICT (id) DO NOTHING`,
        [userId, `${userId}@${emailDomain}`, userId],
      )
      await db.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT (user_id, role_id) DO NOTHING', [userId, roleId])
      await db.query(
        'INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE) ON CONFLICT (user_id, org_id) DO NOTHING',
        [userId, orgId],
      )
      await db.query(
        `INSERT INTO user_namespace_admissions (user_id, namespace, enabled, source, created_at, updated_at)
         VALUES ($1, 'tasks', TRUE, 'test', now(), now())
         ON CONFLICT (user_id, namespace) DO NOTHING`,
        [userId],
      )
      return jwt.sign({
        userId, sub: userId, email: `${userId}@${emailDomain}`,
        role: 'user', roles: [roleId], perms: ['tasks:read', 'tasks:write'], tenantId: orgId,
      }, jwtSecret, { expiresIn: '1h' })
    },
    async cleanup() {
      const db = poolManager.get()
      const userIds = [...created]
      if (userIds.length === 0) return
      const roleIds = userIds.map((userId) => `role_${userId}`)
      await db.query('DELETE FROM user_namespace_admissions WHERE user_id = ANY($1::text[])', [userIds])
      await db.query('DELETE FROM user_roles WHERE user_id = ANY($1::text[])', [userIds])
      await db.query('DELETE FROM user_orgs WHERE user_id = ANY($1::text[])', [userIds])
      await db.query('DELETE FROM users WHERE id = ANY($1::text[])', [userIds])
      await db.query('DELETE FROM role_permissions WHERE role_id = ANY($1::text[])', [roleIds])
      await db.query('DELETE FROM roles WHERE id = ANY($1::text[])', [roleIds])
      created.clear()
    },
  }
}
