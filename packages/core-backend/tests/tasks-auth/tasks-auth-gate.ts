import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFileSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import jwt from 'jsonwebtoken'
import type supertest from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { poolManager } from '../../src/integration/db/connection-pool'
import { tasksRouter } from '../../src/routes/tasks'
import {
  startTasksListener,
  tasksClient,
  type TasksClient,
  type TasksListener,
} from '../helpers/tasks-http-harness'

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

  // §12.0 shared control fixture. a–i 适用. 刻意取反 is the lock's 故意否定.
  // a active+activated, role ≠ disabled; b user_orgs.is_active and org_id = token tenantId;
  // c no sid; d not revoked; e applies on write cells; f TASKS_ENABLED=true in setup;
  // g tasksRouter() mounts; h write body { title }; i must_change_password=false.
  // One listener for the whole file, `Connection: close` on every request
  // (M3R2-CONC-6); see tests/helpers/tasks-http-harness.ts.
  let listener: TasksListener | undefined

  beforeAll(async () => {
    listener = await startTasksListener(tasksRouter())
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

  // Every id this file creates (users, roles, orgs, tasks) contains `stamp`,
  // so one sweep removes whatever a cell left behind, including a cell that
  // failed before its own cleanup ran (R3-TAM-2). Each statement runs on its
  // own so one failure does not skip the rest.
  afterAll(async () => {
    const db = poolManager.get()
    const like = `%${stamp}%`
    const likeCompact = `%${stamp.replace(/-/g, '')}%`
    const sweep: Array<[string, unknown[]]> = [
      ['DELETE FROM tasks WHERE org_id LIKE $1 OR created_by LIKE $1 OR id LIKE $2', [like, likeCompact]],
      ['DELETE FROM user_namespace_admissions WHERE user_id LIKE $1', [like]],
      ['DELETE FROM user_roles WHERE user_id LIKE $1 OR role_id LIKE $1', [like]],
      ['DELETE FROM user_orgs WHERE user_id LIKE $1 OR org_id LIKE $1', [like]],
      ['DELETE FROM users WHERE id LIKE $1', [like]],
      ['DELETE FROM role_permissions WHERE role_id LIKE $1', [like]],
      ['DELETE FROM roles WHERE id LIKE $1', [like]],
    ]
    const errors: unknown[] = []
    for (const [sql, params] of sweep) {
      try { await db.query(sql, params) } catch (err) { errors.push(err) }
    }
    await listener?.close()
    if (errors.length > 0) throw errors[0]
  })

  // §12.0 token for the shared fixture: b 适用 (tenantId = user_orgs.org_id); c 适用 (no sid).
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

  /** Client for the file's shared listener: the router from the feature
   * flag, behind express.json() and nothing else. */
  function app(): TasksClient {
    return tasksClient(listener?.baseUrl ?? '')
  }

  // The 13 M3 (P0-B) routes, contract §3: 11 writes (rbacGuard tasks:write;
  // no org ⇒ 422 ORG_MISSING) and 2 reads (rbacGuard tasks:read; no org ⇒
  // 404 NOT_FOUND). `needs` names the extra row a 200 control seeds first.
  // Cells that stop before the handler reads a row (403, no org) use
  // M3_PLACEHOLDER ids.
  type M3Ctx = { taskId: string; commentId: string; actor: string }
  type M3Route = {
    label: string
    code: 'read' | 'write'
    method: 'get' | 'post' | 'patch' | 'delete'
    path: (ctx: M3Ctx) => string
    body?: Record<string, unknown>
    needs?: 'follower' | 'comment'
  }
  const M3_TARGET = 'usr_m3_gate_target'
  const M3_PLACEHOLDER: M3Ctx = { taskId: 'tsk_missing', commentId: 'tcmt_missing', actor: 'usr_missing' }
  const M3_ROUTES: M3Route[] = [
    { label: 'PATCH /api/tasks/:id/parent', code: 'write', method: 'patch', path: (c) => `/api/tasks/${c.taskId}/parent`, body: { parentId: null } },
    { label: 'GET /api/tasks/:id/parent-candidates', code: 'read', method: 'get', path: (c) => `/api/tasks/${c.taskId}/parent-candidates` },
    { label: 'POST /api/tasks/:id/assignees', code: 'write', method: 'post', path: (c) => `/api/tasks/${c.taskId}/assignees`, body: { userId: M3_TARGET } },
    { label: 'DELETE /api/tasks/:id/assignees/:userId', code: 'write', method: 'delete', path: (c) => `/api/tasks/${c.taskId}/assignees/${M3_TARGET}` },
    { label: 'PATCH /api/tasks/:id/completion-mode', code: 'write', method: 'patch', path: (c) => `/api/tasks/${c.taskId}/completion-mode`, body: { completionMode: 'any' } },
    { label: 'POST /api/tasks/:id/followers', code: 'write', method: 'post', path: (c) => `/api/tasks/${c.taskId}/followers`, body: { userId: M3_TARGET } },
    { label: 'DELETE /api/tasks/:id/followers/:userId', code: 'write', method: 'delete', path: (c) => `/api/tasks/${c.taskId}/followers/${M3_TARGET}` },
    { label: 'POST /api/tasks/:id/leave', code: 'write', method: 'post', path: (c) => `/api/tasks/${c.taskId}/leave`, needs: 'follower' },
    { label: 'GET /api/tasks/:id/comments', code: 'read', method: 'get', path: (c) => `/api/tasks/${c.taskId}/comments` },
    { label: 'POST /api/tasks/:id/comments', code: 'write', method: 'post', path: (c) => `/api/tasks/${c.taskId}/comments`, body: { body: '备料复核' } },
    { label: 'PATCH /api/tasks/:id/comments/:commentId', code: 'write', method: 'patch', path: (c) => `/api/tasks/${c.taskId}/comments/${c.commentId}`, body: { body: '备料复核(改)' }, needs: 'comment' },
    { label: 'DELETE /api/tasks/:id/comments/:commentId', code: 'write', method: 'delete', path: (c) => `/api/tasks/${c.taskId}/comments/${c.commentId}`, needs: 'comment' },
    { label: 'DELETE /api/tasks/:id', code: 'write', method: 'delete', path: (c) => `/api/tasks/${c.taskId}` },
  ]

  function m3Request(server: TasksClient, route: M3Route, ctx: M3Ctx, bearer: string): supertest.Test {
    const agent = server
    const url = route.path(ctx)
    const req = route.method === 'get'
      ? agent.get(url)
      : route.method === 'post'
        ? agent.post(url)
        : route.method === 'patch'
          ? agent.patch(url)
          : agent.delete(url)
    req.set('Authorization', `Bearer ${bearer}`)
    return route.body ? req.send(route.body) : req
  }

  /** A fresh task created by `actor` over HTTP, plus the row `route.needs`. */
  async function seedM3(server: TasksClient, route: M3Route, bearer: string, actor: string): Promise<M3Ctx> {
    const created = await server
      .post('/api/tasks')
      .set('Authorization', `Bearer ${bearer}`)
      .send({ title: '备料复核' })
    expect(created.status, route.label).toBe(200)
    const ctx: M3Ctx = { taskId: String(created.body.id), commentId: M3_PLACEHOLDER.commentId, actor }
    if (route.needs === 'follower') {
      const followed = await server
        .post(`/api/tasks/${ctx.taskId}/followers`)
        .set('Authorization', `Bearer ${bearer}`)
        .send({ userId: actor })
      expect(followed.status, route.label).toBe(200)
    }
    if (route.needs === 'comment') {
      const commented = await server
        .post(`/api/tasks/${ctx.taskId}/comments`)
        .set('Authorization', `Bearer ${bearer}`)
        .send({ body: '备料复核' })
      expect(commented.status, route.label).toBe(200)
      ctx.commentId = String(commented.body.id)
    }
    return ctx
  }

  // Gate 16 diagnostic ①, not a gate 1 cell. No token: a–e, h, i 不适用; f, g 适用 (else 404, not 401).
  it('mounts the read route and rejects a missing bearer', async () => {
    const response = await app().get('/api/tasks/context')
    expect(response.status).toBe(401)
    expect(response.body).toEqual({
      ok: false,
      error: { code: 'UNAUTHORIZED', message: 'Missing Bearer token' },
    })
  })

  // Gate 16 discriminant, read. §12.0: a–d, f–i 适用; e 不适用. Shared fixture and token().
  it('rejects a read route when the token claims tasks:read but the database only grants tasks:write', async () => {
    const response = await app()
      .get('/api/tasks/context')
      .set('Authorization', `Bearer ${token()}`)
    expect(response.status).toBe(403)
    expect(response.body).toEqual({ error: 'Insufficient permissions' })
  })

  // Gate 16 discriminant on the detail read. §12.0: a–d, f–i 适用; e 不适用.
  it('rejects GET /api/tasks/:id when the database does not grant tasks:read', async () => {
    const response = await app()
      .get('/api/tasks/tsk_missing')
      .set('Authorization', `Bearer ${token()}`)
    expect(response.status).toBe(403)
    expect(response.body).toEqual({ error: 'Insufficient permissions' })
  })

  // Gate 1, no claim. Read GET /api/tasks: a, c, d, f–i 适用; b 刻意取反 (no tenantId, no user_orgs); e 不适用.
  // Writes POST /complete /reopen: a, c, d, f–i 适用; b 刻意取反; e 适用.
  // After user_orgs + tenantId, the write 200 is the control: a–i 适用, including e.
  it('gate 1: a read with no tenant is org_missing and a write is 422', async () => {
    const bare = `usr_tasks_notenant_${stamp}`
    const bareRole = `tasks_both_${stamp}`
    const db = poolManager.get()
    await db.query('INSERT INTO roles (id, name) VALUES ($1, $2)', [bareRole, bareRole])
    await db.query(
      `INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, 'tasks:read'), ($1, 'tasks:write')`,
      [bareRole],
    )
    await db.query(
      `INSERT INTO users (
         id, email, name, password_hash, role, permissions,
         is_active, activation_status, local_password_set, must_change_password
       ) VALUES (
         $1, $2, $3, 'x', 'user', '[]'::jsonb,
         TRUE, 'activated', TRUE, FALSE
       )`,
      [bare, `${bare}@tasks-auth-gate.test`, 'tasks-no-tenant'],
    )
    await db.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [bare, bareRole])
    await db.query(
      `INSERT INTO user_namespace_admissions (
         user_id, namespace, enabled, source, created_at, updated_at
       ) VALUES ($1, 'tasks', TRUE, 'test', now(), now())`,
      [bare],
    )
    const bareToken = jwt.sign({
      userId: bare,
      sub: bare,
      email: `${bare}@tasks-auth-gate.test`,
      role: 'user',
      roles: [bareRole],
      perms: ['tasks:read'],
    }, JWT_SECRET, { expiresIn: '1h' })
    const read = await app()
      .get('/api/tasks')
      .set('Authorization', `Bearer ${bareToken}`)
    expect(read.status).toBe(200)
    expect(read.body).toEqual({ items: [], degraded: true, reason: 'org_missing' })
    const write = await app()
      .post('/api/tasks')
      .set('Authorization', `Bearer ${bareToken}`)
      .send({ title: '备料复核' })
    expect(write.status).toBe(422)
    expect(write.body).toEqual({ error: { code: 'ORG_MISSING' } })
    const complete = await app()
      .post('/api/tasks/tsk_missing/complete')
      .set('Authorization', `Bearer ${bareToken}`)
      .send({})
    expect(complete.status).toBe(422)
    expect(complete.body).toEqual({ error: { code: 'ORG_MISSING' } })
    const reopen = await app()
      .post('/api/tasks/tsk_missing/reopen')
      .set('Authorization', `Bearer ${bareToken}`)
      .send({ scope: 'all' })
    expect(reopen.status).toBe(422)
    expect(reopen.body).toEqual({ error: { code: 'ORG_MISSING' } })
    // Every M3 route follows the same no-org contract (§4.3: the 422 site is
    // in the handler, after rbacGuard, not a route-specific exemption): all
    // 11 writes are 422 ORG_MISSING, and both reads are 404 like
    // GET /api/tasks/:id.
    for (const route of M3_ROUTES) {
      const response = await m3Request(app(), route, M3_PLACEHOLDER, bareToken)
      if (route.code === 'write') {
        expect(response.status, route.label).toBe(422)
        expect(response.body, route.label).toEqual({ error: { code: 'ORG_MISSING' } })
      } else {
        expect(response.status, route.label).toBe(404)
        expect(response.body, route.label).toEqual({ error: { code: 'NOT_FOUND' } })
      }
    }
    await db.query(
      'INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)',
      [bare, orgId],
    )
    const orgToken = jwt.sign({
      userId: bare,
      sub: bare,
      email: `${bare}@tasks-auth-gate.test`,
      role: 'user',
      roles: [bareRole],
      perms: ['tasks:write'],
      tenantId: orgId,
    }, JWT_SECRET, { expiresIn: '1h' })
    const allowed = await app()
      .post('/api/tasks')
      .set('Authorization', `Bearer ${orgToken}`)
      .send({ title: '备料复核' })
    expect(allowed.status).toBe(200)
    // Same control, one M3 write route: ②③ present ⇒ 200.
    const modeSwitch = await app()
      .patch(`/api/tasks/${allowed.body.id}/completion-mode`)
      .set('Authorization', `Bearer ${orgToken}`)
      .send({ completionMode: 'any' })
    expect(modeSwitch.status).toBe(200)
    expect(modeSwitch.body).toMatchObject({ id: allowed.body.id, completionMode: 'any' })
    // Same fixture with a valid org, every M3 route: 200 on real rows.
    for (const route of M3_ROUTES) {
      const server = app()
      const ctx = await seedM3(server, route, orgToken, bare)
      const response = await m3Request(server, route, ctx, orgToken)
      expect(response.status, route.label).toBe(200)
    }
    await db.query('DELETE FROM tasks WHERE org_id = $1 AND created_by = $2', [orgId, bare])
    await db.query('DELETE FROM user_orgs WHERE user_id = $1', [bare])
    await db.query('DELETE FROM user_namespace_admissions WHERE user_id = $1', [bare])
    await db.query('DELETE FROM user_roles WHERE user_id = $1', [bare])
    await db.query('DELETE FROM users WHERE id = $1', [bare])
    await db.query('DELETE FROM role_permissions WHERE role_id = $1', [bareRole])
    await db.query('DELETE FROM roles WHERE id = $1', [bareRole])
  })

  // Gate 1, tenant source (M3R2-AUTHZ-3). The org comes only from the token's
  // tenant claim. A token without a tenant claim, sent with `x-tenant-id` /
  // `x-org-id` headers naming a real org, is treated as having no org: writes
  // answer 422 ORG_MISSING, single-task reads 404, the list and count routes
  // their degraded empty shape, and nothing is written in the org the headers
  // name. §12.0: a, c, d, f–i 适用; b 刻意取反 (no tenantId claim, no
  // user_orgs row); e 适用 on the write cells.
  it('gate 1: an x-tenant-id header cannot supply the org when the token has no tenant claim', async () => {
    const bare = `usr_tasks_hdrtenant_${stamp}`
    const bareRole = `tasks_hdrtenant_${stamp}`
    const db = poolManager.get()
    await db.query('INSERT INTO roles (id, name) VALUES ($1, $2)', [bareRole, bareRole])
    await db.query(
      `INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, 'tasks:read'), ($1, 'tasks:write')`,
      [bareRole],
    )
    await db.query(
      `INSERT INTO users (
         id, email, name, password_hash, role, permissions,
         is_active, activation_status, local_password_set, must_change_password
       ) VALUES ($1, $2, $3, 'x', 'user', '[]'::jsonb, TRUE, 'activated', TRUE, FALSE)`,
      [bare, `${bare}@tasks-auth-gate.test`, 'tasks-header-tenant'],
    )
    await db.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [bare, bareRole])
    await db.query(
      `INSERT INTO user_namespace_admissions (
         user_id, namespace, enabled, source, created_at, updated_at
       ) VALUES ($1, 'tasks', TRUE, 'test', now(), now())`,
      [bare],
    )
    const created = await app()
      .post('/api/tasks')
      .set('Authorization', `Bearer ${token()}`)
      .send({ title: '备料复核', assignees: [userId, bare] })
    expect(created.status).toBe(200)
    const taskId = String(created.body.id)
    const commentId = `tcmt_hdrtenant_${stamp.replace(/-/g, '')}`
    await db.query('INSERT INTO task_followers (task_id, user_id) VALUES ($1, $2)', [taskId, bare])
    await db.query('INSERT INTO task_comments (id, task_id, author_id, body) VALUES ($1, $2, $3, $4)', [commentId, taskId, bare, '备料复核'])
    const before = await db.query(
      `SELECT t.status, t.completion_mode, t.version, t.parent_id, t.deleted_at,
              (SELECT count(*) FROM task_assignees WHERE task_id = t.id)::int AS assignees,
              (SELECT count(*) FROM task_followers WHERE task_id = t.id)::int AS followers,
              (SELECT count(*) FROM task_comments WHERE task_id = t.id)::int AS comments,
              (SELECT count(*) FROM task_events WHERE task_id = t.id)::int AS events
       FROM tasks t WHERE t.id = $1`,
      [taskId],
    )

    const noClaim = jwt.sign({
      userId: bare,
      sub: bare,
      email: `${bare}@tasks-auth-gate.test`,
      role: 'user',
      roles: [bareRole],
      perms: ['tasks:read', 'tasks:write'],
    }, JWT_SECRET, { expiresIn: '1h' })
    const withHeaders = (test: supertest.Test): supertest.Test => test
      .set('Authorization', `Bearer ${noClaim}`)
      .set('x-tenant-id', orgId)
      .set('x-org-id', orgId)

    const ctx: M3Ctx = { taskId, commentId, actor: bare }
    for (const route of M3_ROUTES) {
      const response = await withHeaders(m3Request(app(), route, ctx, noClaim))
      if (route.code === 'write') {
        expect(response.status, route.label).toBe(422)
        expect(response.body, route.label).toEqual({ error: { code: 'ORG_MISSING' } })
      } else {
        expect(response.status, route.label).toBe(404)
        expect(response.body, route.label).toEqual({ error: { code: 'NOT_FOUND' } })
      }
    }
    const create = await withHeaders(app().post('/api/tasks')).send({ title: '备料复核' })
    expect(create.status).toBe(422)
    expect(create.body).toEqual({ error: { code: 'ORG_MISSING' } })
    const complete = await withHeaders(app().post(`/api/tasks/${taskId}/complete`)).send({})
    expect(complete.status).toBe(422)
    expect(complete.body).toEqual({ error: { code: 'ORG_MISSING' } })
    const reopen = await withHeaders(app().post(`/api/tasks/${taskId}/reopen`)).send({ scope: 'all' })
    expect(reopen.status).toBe(422)
    expect(reopen.body).toEqual({ error: { code: 'ORG_MISSING' } })
    const detail = await withHeaders(app().get(`/api/tasks/${taskId}`))
    expect(detail.status).toBe(404)
    expect(detail.body).toEqual({ error: { code: 'NOT_FOUND' } })
    const list = await withHeaders(app().get('/api/tasks').query({ view: 'any_role' }))
    expect(list.status).toBe(200)
    expect(list.body).toEqual({ items: [], degraded: true, reason: 'org_missing' })
    const pending = await withHeaders(app().get('/api/tasks/pending'))
    expect(pending.status).toBe(200)
    expect(pending.body).toEqual({ items: [], degraded: true, reason: 'org_missing' })
    const pendingCount = await withHeaders(app().get('/api/tasks/pending-count'))
    expect(pendingCount.status).toBe(200)
    expect(pendingCount.body).toEqual({ count: 0, degraded: true, reason: 'org_missing' })
    const context = await withHeaders(app().get('/api/tasks/context'))
    expect(context.status).toBe(200)
    expect(context.body).toEqual({ orgId: null })

    // Nothing was written in the org the header named.
    const after = await db.query(
      `SELECT t.status, t.completion_mode, t.version, t.parent_id, t.deleted_at,
              (SELECT count(*) FROM task_assignees WHERE task_id = t.id)::int AS assignees,
              (SELECT count(*) FROM task_followers WHERE task_id = t.id)::int AS followers,
              (SELECT count(*) FROM task_comments WHERE task_id = t.id)::int AS comments,
              (SELECT count(*) FROM task_events WHERE task_id = t.id)::int AS events
       FROM tasks t WHERE t.id = $1`,
      [taskId],
    )
    expect(after.rows).toEqual(before.rows)
    const byBare = await db.query('SELECT count(*)::int AS n FROM tasks WHERE created_by = $1', [bare])
    expect(byBare.rows[0]?.n).toBe(0)

    await db.query('DELETE FROM tasks WHERE id = $1', [taskId])
    await db.query('DELETE FROM user_namespace_admissions WHERE user_id = $1', [bare])
    await db.query('DELETE FROM user_roles WHERE user_id = $1', [bare])
    await db.query('DELETE FROM users WHERE id = $1', [bare])
    await db.query('DELETE FROM role_permissions WHERE role_id = $1', [bareRole])
    await db.query('DELETE FROM roles WHERE id = $1', [bareRole])
  })

  // Gate 1 read, no admission, 403. §12.0: a–d, f–i 适用; e 不适用. b 适用 (user_orgs matches tenantId).
  it('returns 403 when the role has tasks:read but there is no namespace admission', async () => {
    const bare = `usr_tasks_noadmit_${stamp}`
    const bareRole = `tasks_noadmit_${stamp}`
    const db = poolManager.get()
    await db.query('INSERT INTO roles (id, name) VALUES ($1, $2)', [bareRole, bareRole])
    await db.query(
      `INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, 'tasks:read')`,
      [bareRole],
    )
    await db.query(
      `INSERT INTO users (
         id, email, name, password_hash, role, permissions,
         is_active, activation_status, local_password_set, must_change_password
       ) VALUES (
         $1, $2, $3, 'x', 'user', '[]'::jsonb,
         TRUE, 'activated', TRUE, FALSE
       )`,
      [bare, `${bare}@tasks-auth-gate.test`, 'tasks-no-admission'],
    )
    await db.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [bare, bareRole])
    await db.query(
      'INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)',
      [bare, orgId],
    )
    const bareToken = jwt.sign({
      userId: bare,
      sub: bare,
      email: `${bare}@tasks-auth-gate.test`,
      role: 'user',
      roles: [bareRole],
      perms: ['tasks:read'],
      tenantId: orgId,
    }, JWT_SECRET, { expiresIn: '1h' })
    const response = await app()
      .get('/api/tasks/context')
      .set('Authorization', `Bearer ${bareToken}`)
    expect(response.status).toBe(403)
    expect(response.body).toEqual({ error: 'Insufficient permissions' })
    await db.query('DELETE FROM user_orgs WHERE user_id = $1', [bare])
    await db.query('DELETE FROM user_roles WHERE user_id = $1', [bare])
    await db.query('DELETE FROM users WHERE id = $1', [bare])
    await db.query('DELETE FROM role_permissions WHERE role_id = $1', [bareRole])
    await db.query('DELETE FROM roles WHERE id = $1', [bareRole])
  })

  // Gate 2/16, M3 write route: 缺 ③(admission) ⇒ 403; ②③ 齐全 ⇒ 200, both cells
  // on the SAME write route (POST .../followers) and the SAME user: the
  // admission row is inserted between the 403 and the 200. This relies on
  // rbacGuard's admission check reading the row uncached (the
  // userHasPermission path); the per-route block below ('gate 2/16: every M3
  // route') keeps independent, fixed-grant users per cell instead (M3R2-TM-11).
  it('an M3 write route is 403 without namespace admission and 200 once it is granted', async () => {
    const bare = `usr_tasks_m3admit_${stamp}`
    const bareRole = `tasks_m3admit_${stamp}`
    const db = poolManager.get()
    await db.query('INSERT INTO roles (id, name) VALUES ($1, $2)', [bareRole, bareRole])
    await db.query(
      `INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, 'tasks:read'), ($1, 'tasks:write')`,
      [bareRole],
    )
    await db.query(
      `INSERT INTO users (
         id, email, name, password_hash, role, permissions,
         is_active, activation_status, local_password_set, must_change_password
       ) VALUES ($1, $2, $3, 'x', 'user', '[]'::jsonb, TRUE, 'activated', TRUE, FALSE)`,
      [bare, `${bare}@tasks-auth-gate.test`, 'tasks-m3-admission'],
    )
    await db.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [bare, bareRole])
    await db.query('INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)', [bare, orgId])
    const bareToken = jwt.sign({
      userId: bare, sub: bare, email: `${bare}@tasks-auth-gate.test`,
      role: 'user', roles: [bareRole], perms: ['tasks:read', 'tasks:write'], tenantId: orgId,
    }, JWT_SECRET, { expiresIn: '1h' })

    // `bare` is an assignee (not just permitted by RBAC) so the 200 control
    // isolates the admission cell — without this, a task-level `edit` 404
    // would be indistinguishable from an RBAC 403 in the assertions below.
    const created = await app()
      .post('/api/tasks')
      .set('Authorization', `Bearer ${token()}`)
      .send({ title: '备料复核', assignees: [userId, bare] })
    expect(created.status).toBe(200)

    const denied = await app()
      .post(`/api/tasks/${created.body.id}/followers`)
      .set('Authorization', `Bearer ${bareToken}`)
      .send({ userId: 'usr_follow_target' })
    expect(denied.status).toBe(403)
    expect(denied.body).toEqual({ error: 'Insufficient permissions' })

    await db.query(
      `INSERT INTO user_namespace_admissions (
         user_id, namespace, enabled, source, created_at, updated_at
       ) VALUES ($1, 'tasks', TRUE, 'test', now(), now())`,
      [bare],
    )
    const allowed = await app()
      .post(`/api/tasks/${created.body.id}/followers`)
      .set('Authorization', `Bearer ${bareToken}`)
      .send({ userId: 'usr_follow_target' })
    expect(allowed.status).toBe(200)
    expect(allowed.body).toEqual({ id: created.body.id, followers: ['usr_follow_target'] })

    await db.query('DELETE FROM tasks WHERE id = $1', [created.body.id])
    await db.query('DELETE FROM user_namespace_admissions WHERE user_id = $1', [bare])
    await db.query('DELETE FROM user_orgs WHERE user_id = $1', [bare])
    await db.query('DELETE FROM user_roles WHERE user_id = $1', [bare])
    await db.query('DELETE FROM users WHERE id = $1', [bare])
    await db.query('DELETE FROM role_permissions WHERE role_id = $1', [bareRole])
    await db.query('DELETE FROM roles WHERE id = $1', [bareRole])
  })

  // Gate 2/16 for every M3 route, one it() per route. §12.0: a–d, f–i 适用;
  // e 适用 on write routes. Each user's grants are fixed for the whole block
  // (no mid-test grant changes, so the RBAC permission cache cannot mask a
  // cell):
  // - noAdmit: both codes and user_orgs, no namespace admission ⇒ 403;
  // - wrongCode: admission and user_orgs, but only the other code (tasks:read
  //   for a write route, tasks:write for a read route) ⇒ 403;
  // - control: both codes, admission, user_orgs ⇒ 200 on rows it created.
  // The 403 cells use placeholder ids: the handler answers 404 for those, so
  // a 403 can only come from the route's rbacGuard carrying the right code.
  describe('gate 2/16: every M3 route', () => {
    type GateUser = { userId: string; roleId: string; bearer: string }
    const users: Record<'noAdmit' | 'readOnly' | 'writeOnly' | 'control', GateUser> = {} as never

    async function gateUser(label: string, codes: string[], admission: boolean): Promise<GateUser> {
      const user = `usr_tasks_m3gate_${label}_${stamp}`
      const role = `tasks_m3gate_${label}_${stamp}`
      const db = poolManager.get()
      await db.query('INSERT INTO roles (id, name) VALUES ($1, $2)', [role, role])
      for (const code of codes) {
        await db.query('INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, $2)', [role, code])
      }
      await db.query(
        `INSERT INTO users (
           id, email, name, password_hash, role, permissions,
           is_active, activation_status, local_password_set, must_change_password
         ) VALUES ($1, $2, $3, 'x', 'user', '[]'::jsonb, TRUE, 'activated', TRUE, FALSE)`,
        [user, `${user}@tasks-auth-gate.test`, `tasks-m3gate-${label}`],
      )
      await db.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [user, role])
      await db.query('INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)', [user, orgId])
      if (admission) {
        await db.query(
          `INSERT INTO user_namespace_admissions (
             user_id, namespace, enabled, source, created_at, updated_at
           ) VALUES ($1, 'tasks', TRUE, 'test', now(), now())`,
          [user],
        )
      }
      const bearer = jwt.sign({
        userId: user, sub: user, email: `${user}@tasks-auth-gate.test`,
        role: 'user', roles: [role], perms: ['tasks:read', 'tasks:write'], tenantId: orgId,
      }, JWT_SECRET, { expiresIn: '1h' })
      return { userId: user, roleId: role, bearer }
    }

    beforeAll(async () => {
      users.noAdmit = await gateUser('noadmit', ['tasks:read', 'tasks:write'], false)
      users.readOnly = await gateUser('readonly', ['tasks:read'], true)
      users.writeOnly = await gateUser('writeonly', ['tasks:write'], true)
      users.control = await gateUser('control', ['tasks:read', 'tasks:write'], true)
    })

    afterAll(async () => {
      const db = poolManager.get()
      for (const { userId: user, roleId: role } of Object.values(users)) {
        await db.query('DELETE FROM tasks WHERE org_id = $1 AND created_by = $2', [orgId, user])
        await db.query('DELETE FROM user_namespace_admissions WHERE user_id = $1', [user])
        await db.query('DELETE FROM user_orgs WHERE user_id = $1', [user])
        await db.query('DELETE FROM user_roles WHERE user_id = $1', [user])
        await db.query('DELETE FROM users WHERE id = $1', [user])
        await db.query('DELETE FROM role_permissions WHERE role_id = $1', [role])
        await db.query('DELETE FROM roles WHERE id = $1', [role])
      }
    })

    it.each(M3_ROUTES)('$label: 403 without admission, 403 with only the other code, 200 for the control', async (route) => {
      const server = app()
      const noAdmit = await m3Request(server, route, M3_PLACEHOLDER, users.noAdmit.bearer)
      expect(noAdmit.status, route.label).toBe(403)
      expect(noAdmit.body, route.label).toEqual({ error: 'Insufficient permissions' })

      const wrongCode = route.code === 'write' ? users.readOnly : users.writeOnly
      const denied = await m3Request(server, route, M3_PLACEHOLDER, wrongCode.bearer)
      expect(denied.status, route.label).toBe(403)
      expect(denied.body, route.label).toEqual({ error: 'Insufficient permissions' })

      const ctx = await seedM3(server, route, users.control.bearer, users.control.userId)
      const allowed = await m3Request(server, route, ctx, users.control.bearer)
      expect(allowed.status, route.label).toBe(200)
    })
  })

  // Gate 1 cross-org write. §12.0: a 适用; b 刻意取反 (user_orgs is home, tenantId is other); c, d, f–i 适用; e 适用.
  // The following write with tenantId=home is the control: a–i 适用, including e.
  it('gate 1: a write whose tenant claim is a different org is 422', async () => {
    const user = `usr_tasks_xorg_${stamp}`
    const role = `tasks_xorg_${stamp}`
    const home = `org_home_${stamp}`
    const other = `org_other_${stamp}`
    const db = poolManager.get()
    await db.query('INSERT INTO roles (id, name) VALUES ($1, $2)', [role, role])
    await db.query(
      `INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, 'tasks:write')`,
      [role],
    )
    await db.query(
      `INSERT INTO users (
         id, email, name, password_hash, role, permissions,
         is_active, activation_status, local_password_set, must_change_password
       ) VALUES (
         $1, $2, $3, 'x', 'user', '[]'::jsonb, TRUE, 'activated', TRUE, FALSE
       )`,
      [user, `${user}@tasks-auth-gate.test`, 'tasks-cross-org'],
    )
    await db.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [user, role])
    await db.query(
      'INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)',
      [user, home],
    )
    await db.query(
      `INSERT INTO user_namespace_admissions (
         user_id, namespace, enabled, source, created_at, updated_at
       ) VALUES ($1, 'tasks', TRUE, 'test', now(), now())`,
      [user],
    )
    const foreign = jwt.sign({
      userId: user, sub: user, email: `${user}@tasks-auth-gate.test`,
      role: 'user', roles: [role], perms: ['tasks:write'], tenantId: other,
    }, JWT_SECRET, { expiresIn: '1h' })
    const denied = await app()
      .post('/api/tasks')
      .set('Authorization', `Bearer ${foreign}`)
      .send({ title: '备料复核' })
    expect(denied.status).toBe(422)
    expect(denied.body).toEqual({ error: { code: 'ORG_MISSING' } })
    const member = jwt.sign({
      userId: user, sub: user, email: `${user}@tasks-auth-gate.test`,
      role: 'user', roles: [role], perms: ['tasks:write'], tenantId: home,
    }, JWT_SECRET, { expiresIn: '1h' })
    const allowed = await app()
      .post('/api/tasks')
      .set('Authorization', `Bearer ${member}`)
      .send({ title: '备料复核' })
    expect(allowed.status).toBe(200)
    // Same cross-org cell, one M3 write route, on the task just created.
    const m3Denied = await app()
      .patch(`/api/tasks/${allowed.body.id}/completion-mode`)
      .set('Authorization', `Bearer ${foreign}`)
      .send({ completionMode: 'any' })
    expect(m3Denied.status).toBe(422)
    expect(m3Denied.body).toEqual({ error: { code: 'ORG_MISSING' } })
    const m3Allowed = await app()
      .patch(`/api/tasks/${allowed.body.id}/completion-mode`)
      .set('Authorization', `Bearer ${member}`)
      .send({ completionMode: 'any' })
    expect(m3Allowed.status).toBe(200)
    await db.query('DELETE FROM tasks WHERE org_id = $1', [home])
    await db.query('DELETE FROM user_namespace_admissions WHERE user_id = $1', [user])
    await db.query('DELETE FROM user_roles WHERE user_id = $1', [user])
    await db.query('DELETE FROM user_orgs WHERE user_id = $1', [user])
    await db.query('DELETE FROM users WHERE id = $1', [user])
    await db.query('DELETE FROM role_permissions WHERE role_id = $1', [role])
    await db.query('DELETE FROM roles WHERE id = $1', [role])
  })

  // Gate 1 org-isolation read. §12.0: a–d, f–i 适用; e 不适用. b 适用 (user_orgs.org_id = token tenantId = org A).
  it('gate 1: a read stays inside the caller org until the org predicate is removed', async () => {
    const user = `usr_tasks_iso_${stamp}`
    const role = `tasks_iso_${stamp}`
    const orgA = `orgA_${stamp}`
    const orgB = `orgB_${stamp}`
    const taskA = `tskA${stamp.replace(/-/g, '')}`
    const taskB = `tskB${stamp.replace(/-/g, '')}`
    const creator = `usr_tasks_iso_creator_${stamp}`
    const db = poolManager.get()
    await db.query('INSERT INTO roles (id, name) VALUES ($1, $2)', [role, role])
    await db.query(
      `INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, 'tasks:read')`,
      [role],
    )
    await db.query(
      `INSERT INTO users (
         id, email, name, password_hash, role, permissions,
         is_active, activation_status, local_password_set, must_change_password
       ) VALUES (
         $1, $2, $3, 'x', 'user', '[]'::jsonb, TRUE, 'activated', TRUE, FALSE
       )`,
      [user, `${user}@tasks-auth-gate.test`, 'tasks-isolation'],
    )
    await db.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [user, role])
    await db.query(
      'INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)',
      [user, orgA],
    )
    await db.query(
      `INSERT INTO user_namespace_admissions (
         user_id, namespace, enabled, source, created_at, updated_at
       ) VALUES ($1, 'tasks', TRUE, 'test', now(), now())`,
      [user],
    )
    for (const [taskId, org] of [[taskA, orgA], [taskB, orgB]] as const) {
      await db.query(
        `INSERT INTO tasks (
           id, org_id, title, status, due_date, due_time, time_zone, due_at,
           completion_mode, created_by
         ) VALUES (
           $1, $2, '备料复核', 'open',
           ((now() AT TIME ZONE 'UTC')::date - 1), TIME '12:00', 'UTC', now() - interval '2 hours',
           'all', $3
         )`,
        [taskId, org, creator],
      )
      await db.query(
        'INSERT INTO task_assignees (task_id, user_id) VALUES ($1, $2)',
        [taskId, user],
      )
    }
    const bearer = jwt.sign({
      userId: user, sub: user, email: `${user}@tasks-auth-gate.test`,
      role: 'user', roles: [role], perms: ['tasks:read'], tenantId: orgA,
    }, JWT_SECRET, { expiresIn: '1h' })
    const server = app()
    const listed = await server
      .get('/api/tasks')
      .query({ view: 'any_role' })
      .set('Authorization', `Bearer ${bearer}`)
    const pending = await server
      .get('/api/tasks/pending')
      .set('Authorization', `Bearer ${bearer}`)
    expect(listed.status).toBe(200)
    expect(pending.status).toBe(200)
    const listedIds = (listed.body.items as { id: string }[]).map((row) => row.id)
    const pendingIds = (pending.body.items as { id: string }[]).map((row) => row.id)
    expect(listedIds).toContain(taskA)
    expect(listedIds).not.toContain(taskB)
    expect(pendingIds).toContain(taskA)
    expect(pendingIds).not.toContain(taskB)

    const accessFile = new URL('../../src/tasks/task-access.ts', import.meta.url).pathname
    const needle = '(tasks.org_id = ${ORG_PLACEHOLDER}) AND '
    const original = readFileSync(accessFile, 'utf8')
    expect(original.includes(needle)).toBe(true)
    const backup = `/tmp/task-access-org-${stamp}.bak`
    const recordsFile = new URL('../../src/services/task-records.ts', import.meta.url).pathname
    const script = `/tmp/task-org-mutant-${stamp}.mts`
    copyFileSync(accessFile, backup)
    try {
    writeFileSync(accessFile, original.replace(
      needle,
      '(${ORG_PLACEHOLDER}::text IS NOT NULL) AND ',
    ))
    writeFileSync(script, `
      const { listTasks, listPending } = await import(${JSON.stringify(recordsFile)})
      const listed = await listTasks({ orgId: ${JSON.stringify(orgA)}, actorId: ${JSON.stringify(user)}, view: 'any_role' })
      const pending = await listPending({ orgId: ${JSON.stringify(orgA)}, actorId: ${JSON.stringify(user)}, viewerTz: null })
      const listedIds = listed.map((row) => row.id)
      const pendingIds = pending.map((row) => row.id)
      console.log(JSON.stringify({ gate1org: 'red', listed: listedIds.includes(${JSON.stringify(taskB)}), pending: pendingIds.includes(${JSON.stringify(taskB)}) }))
      if (!listedIds.includes(${JSON.stringify(taskB)}) || !pendingIds.includes(${JSON.stringify(taskB)})) process.exit(1)
      process.exit(0)
    `)
    const tsx = createRequire(import.meta.url).resolve('tsx/cli')
      execFileSync(process.execPath, [tsx, script], {
        cwd: accessFile.slice(0, accessFile.indexOf('/src/tasks/')),
        env: process.env,
        stdio: 'inherit',
        timeout: 120000,
      })
    } finally {
      copyFileSync(backup, accessFile)
      try { unlinkSync(script) } catch { /* script was not written */ }
      try { unlinkSync(backup) } catch { /* backup was not written */ }
      expect(readFileSync(accessFile, 'utf8')).toBe(original)
      await db.query('DELETE FROM tasks WHERE id = ANY($1::text[])', [[taskA, taskB]])
      await db.query('DELETE FROM user_namespace_admissions WHERE user_id = $1', [user])
      await db.query('DELETE FROM user_roles WHERE user_id = $1', [user])
      await db.query('DELETE FROM user_orgs WHERE user_id = $1', [user])
      await db.query('DELETE FROM users WHERE id = $1', [user])
      await db.query('DELETE FROM role_permissions WHERE role_id = $1', [role])
      await db.query('DELETE FROM roles WHERE id = $1', [role])
    }
  }, 180000)

  // Gate 1 and gate 16 control, write 200. §12.0: a–i 适用, including e. Fixture is beforeAll and token().
  it('allows POST /api/tasks when the database grants tasks:write', async () => {
    const response = await app()
      .post('/api/tasks')
      .set('Authorization', `Bearer ${token()}`)
      .send({ title: '备料复核' })
    expect(response.status).toBe(200)
    expect(String(response.body.id)).toMatch(/^tsk_/)
  })
})
