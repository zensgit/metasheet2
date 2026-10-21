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
import { seedOrgMembers } from '../helpers/task-m4-fixtures'

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
    // RULED(2026-10-07): [N2] the M3 routes' add target, and the M4 routes' member and owner target,
    // must be active members of the org the 200 controls run in (design §4.6); `users` +
    // `user_orgs` only, swept with everything else.
    await seedOrgMembers(orgId, [M3_TARGET, M4_TARGET])
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
      ['DELETE FROM task_lists WHERE org_id LIKE $1 OR id LIKE $2', [like, likeCompact]],
      ['DELETE FROM task_groups WHERE org_id LIKE $1', [like]],
      ['DELETE FROM task_user_settings WHERE org_id LIKE $1', [like]],
      ['DELETE FROM user_namespace_admissions WHERE user_id LIKE $1', [like]],
      ['DELETE FROM user_roles WHERE user_id LIKE $1 OR role_id LIKE $1', [like]],
      ['DELETE FROM user_orgs WHERE user_id LIKE $1 OR org_id LIKE $1', [like]],
      ['DELETE FROM users WHERE id LIKE $1', [like]],
      // [N2]: the admission cell's follow target has a fixed id (no stamp).
      ['DELETE FROM user_orgs WHERE user_id = $1', ['usr_follow_target']],
      ['DELETE FROM users WHERE id = $1', ['usr_follow_target']],
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
  // Stamped so the afterAll sweep removes the users row seeded for it ([N2]).
  const M3_TARGET = `usr_m3_gate_target_${stamp}`
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

  // The 8 P0-A (M2) routes, contract §2, as literals: the route-population cell below compares
  // `tasksRouter()` with this table, M3_ROUTES and M4_ROUTES (design §10.7).
  const P0A_ROUTES: readonly string[] = [
    'GET /api/tasks/context',
    'GET /api/tasks/pending',
    'GET /api/tasks/pending-count',
    'GET /api/tasks/:id',
    'GET /api/tasks',
    'POST /api/tasks',
    'POST /api/tasks/:id/complete',
    'POST /api/tasks/:id/reopen',
  ]

  // The 30 M4 (PR-3a) routes, design §3 and §10.7: PATCH /api/tasks/:id (S4), task settings (S3),
  // lists (S5), list members (S6), list items (S7), groups in both scopes (S8). Writes take
  // tasks:write and answer 422 ORG_MISSING without an org; reads take tasks:read and answer 404
  // without an org, except the three collections marked `collection`, which answer the degraded
  // body without `total` (design §3, RULED(2026-10-07): [R18] no route here takes tasks:admin).
  // `needs` names the rows a 200 control seeds first, in this order: task, list, archived, member,
  // item, group, userGroup. Cells that stop before the handler reads a row (403, no org) use
  // M4_PLACEHOLDER ids.
  type M4Ctx = { taskId: string; version: number; listId: string; groupId: string; userGroupId: string; target: string }
  type M4Need = 'task' | 'list' | 'archived' | 'member' | 'item' | 'group' | 'userGroup'
  type M4Route = {
    label: string
    code: 'read' | 'write'
    method: 'get' | 'post' | 'patch' | 'put' | 'delete'
    path: (ctx: M4Ctx) => string
    body?: (ctx: M4Ctx) => Record<string, unknown>
    needs?: M4Need[]
    collection?: true
  }
  // Stamped so the afterAll sweep removes the users row seeded for it (RULED(2026-10-07): [R17]
  // [N2]: a new list member or owner must be an active member of the org).
  const M4_TARGET = `usr_m4_gate_target_${stamp}`
  const M4_PLACEHOLDER: M4Ctx = {
    taskId: 'tsk_missing',
    version: 1,
    listId: 'tlst_missing',
    groupId: 'tgrp_missing',
    userGroupId: 'tgrp_missing',
    target: M4_TARGET,
  }
  const M4_ROUTES: M4Route[] = [
    { label: 'PATCH /api/tasks/:id', code: 'write', method: 'patch', path: (c) => `/api/tasks/${c.taskId}`, body: (c) => ({ expectedVersion: c.version, title: '备料复核(改)' }), needs: ['task'] },
    { label: 'GET /api/task-settings', code: 'read', method: 'get', path: () => '/api/task-settings' },
    { label: 'PATCH /api/task-settings', code: 'write', method: 'patch', path: () => '/api/task-settings', body: () => ({ badgeScope: 'overdue' }) },
    { label: 'GET /api/task-lists', code: 'read', method: 'get', path: () => '/api/task-lists', collection: true },
    { label: 'POST /api/task-lists', code: 'write', method: 'post', path: () => '/api/task-lists', body: () => ({ name: '备料复核' }) },
    { label: 'GET /api/task-lists/:id/events', code: 'read', method: 'get', path: (c) => `/api/task-lists/${c.listId}/events`, needs: ['list'] },
    { label: 'POST /api/task-lists/:id/archive', code: 'write', method: 'post', path: (c) => `/api/task-lists/${c.listId}/archive`, needs: ['list'] },
    { label: 'POST /api/task-lists/:id/unarchive', code: 'write', method: 'post', path: (c) => `/api/task-lists/${c.listId}/unarchive`, needs: ['list', 'archived'] },
    { label: 'GET /api/task-lists/:id/members', code: 'read', method: 'get', path: (c) => `/api/task-lists/${c.listId}/members`, needs: ['list'] },
    { label: 'POST /api/task-lists/:id/members', code: 'write', method: 'post', path: (c) => `/api/task-lists/${c.listId}/members`, body: (c) => ({ userId: c.target, role: 'edit' }), needs: ['list'] },
    { label: 'PATCH /api/task-lists/:id/members/:userId', code: 'write', method: 'patch', path: (c) => `/api/task-lists/${c.listId}/members/${c.target}`, body: () => ({ role: 'read' }), needs: ['list', 'member'] },
    { label: 'DELETE /api/task-lists/:id/members/:userId', code: 'write', method: 'delete', path: (c) => `/api/task-lists/${c.listId}/members/${c.target}`, needs: ['list', 'member'] },
    { label: 'POST /api/task-lists/:id/transfer-owner', code: 'write', method: 'post', path: (c) => `/api/task-lists/${c.listId}/transfer-owner`, body: (c) => ({ userId: c.target }), needs: ['list', 'member'] },
    { label: 'GET /api/task-lists/:id/items', code: 'read', method: 'get', path: (c) => `/api/task-lists/${c.listId}/items`, needs: ['list'] },
    { label: 'POST /api/task-lists/:id/items', code: 'write', method: 'post', path: (c) => `/api/task-lists/${c.listId}/items`, body: (c) => ({ taskId: c.taskId }), needs: ['task', 'list'] },
    { label: 'DELETE /api/task-lists/:id/items/:taskId', code: 'write', method: 'delete', path: (c) => `/api/task-lists/${c.listId}/items/${c.taskId}`, needs: ['task', 'list', 'item'] },
    { label: 'GET /api/task-lists/:id/groups', code: 'read', method: 'get', path: (c) => `/api/task-lists/${c.listId}/groups`, needs: ['list'] },
    { label: 'POST /api/task-lists/:id/groups', code: 'write', method: 'post', path: (c) => `/api/task-lists/${c.listId}/groups`, body: () => ({ name: '新组' }), needs: ['list'] },
    { label: 'PATCH /api/task-lists/:id/groups/:groupId', code: 'write', method: 'patch', path: (c) => `/api/task-lists/${c.listId}/groups/${c.groupId}`, body: () => ({ name: '改名' }), needs: ['list', 'group'] },
    { label: 'DELETE /api/task-lists/:id/groups/:groupId', code: 'write', method: 'delete', path: (c) => `/api/task-lists/${c.listId}/groups/${c.groupId}`, needs: ['list', 'group'] },
    { label: 'GET /api/task-lists/:id/group-items', code: 'read', method: 'get', path: (c) => `/api/task-lists/${c.listId}/group-items`, needs: ['list'] },
    { label: 'PUT /api/task-lists/:id/group-items/:taskId', code: 'write', method: 'put', path: (c) => `/api/task-lists/${c.listId}/group-items/${c.taskId}`, body: () => ({ groupId: null, position: 0 }), needs: ['task', 'list', 'item'] },
    { label: 'GET /api/task-lists/:id', code: 'read', method: 'get', path: (c) => `/api/task-lists/${c.listId}`, needs: ['list'] },
    { label: 'PATCH /api/task-lists/:id', code: 'write', method: 'patch', path: (c) => `/api/task-lists/${c.listId}`, body: () => ({ name: '改名' }), needs: ['list'] },
    { label: 'GET /api/task-groups', code: 'read', method: 'get', path: () => '/api/task-groups', collection: true },
    { label: 'POST /api/task-groups', code: 'write', method: 'post', path: () => '/api/task-groups', body: () => ({ name: '新组' }) },
    { label: 'GET /api/task-groups/items', code: 'read', method: 'get', path: () => '/api/task-groups/items', collection: true },
    { label: 'PUT /api/task-groups/items/:taskId', code: 'write', method: 'put', path: (c) => `/api/task-groups/items/${c.taskId}`, body: () => ({ groupId: null, position: 0 }), needs: ['task'] },
    { label: 'PATCH /api/task-groups/:groupId', code: 'write', method: 'patch', path: (c) => `/api/task-groups/${c.userGroupId}`, body: () => ({ name: '改名' }), needs: ['userGroup'] },
    { label: 'DELETE /api/task-groups/:groupId', code: 'write', method: 'delete', path: (c) => `/api/task-groups/${c.userGroupId}`, needs: ['userGroup'] },
  ]

  /** The no-org answer of an M4 route, as the exact response text (design §3, [own-19]). */
  function m4NoOrgText(route: M4Route): { status: number; text: string } {
    if (route.code === 'write') return { status: 422, text: JSON.stringify({ error: { code: 'ORG_MISSING' } }) }
    if (route.collection) return { status: 200, text: JSON.stringify({ items: [], degraded: true, reason: 'org_missing' }) }
    return { status: 404, text: JSON.stringify({ error: { code: 'NOT_FOUND' } }) }
  }

  function m4Request(server: TasksClient, route: M4Route, ctx: M4Ctx, bearer: string): supertest.Test {
    const req = server[route.method](route.path(ctx)).set('Authorization', `Bearer ${bearer}`)
    return route.body ? req.send(route.body(ctx)) : req
  }

  /** The rows `route.needs` names, written over HTTP by `actor` (who holds both codes in the org of
   * `bearer`); `target` must be an active member of that org. */
  async function seedM4(server: TasksClient, route: M4Route, bearer: string, actor: string, target: string): Promise<M4Ctx> {
    const ctx: M4Ctx = { ...M4_PLACEHOLDER, target }
    const needs = new Set(route.needs ?? [])
    const call = async (test: supertest.Test, what: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const authed = test.set('Authorization', `Bearer ${bearer}`)
      const response = await (body ? authed.send(body) : authed)
      expect(response.status, `${route.label}: seed ${what}`).toBe(200)
      return response.body as Record<string, unknown>
    }
    if (needs.has('task')) {
      const created = await call(server.post('/api/tasks'), 'task', { title: '备料复核', assignees: [actor] })
      ctx.taskId = String(created.id)
      ctx.version = Number(created.version)
    }
    if (needs.has('list')) ctx.listId = String((await call(server.post('/api/task-lists'), 'list', { name: '备料复核' })).id)
    if (needs.has('archived')) await call(server.post(`/api/task-lists/${ctx.listId}/archive`), 'archive')
    if (needs.has('member')) await call(server.post(`/api/task-lists/${ctx.listId}/members`), 'member', { userId: target, role: 'edit' })
    if (needs.has('item')) await call(server.post(`/api/task-lists/${ctx.listId}/items`), 'item', { taskId: ctx.taskId })
    if (needs.has('group')) ctx.groupId = String((await call(server.post(`/api/task-lists/${ctx.listId}/groups`), 'group', { name: '组' })).id)
    if (needs.has('userGroup')) ctx.userGroupId = String((await call(server.post('/api/task-groups'), 'user group', { name: '我的' })).id)
    return ctx
  }

  /** Every task-domain row of `org` (the M2/M3 tables and the eight M4 tables), as one text. */
  async function m4OrgState(org: string): Promise<string> {
    const result = await poolManager.get().query(
      `SELECT jsonb_build_object(
         'tasks', (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id), '[]') FROM tasks t WHERE t.org_id = $1),
         'assignees', (SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.task_id, a.user_id), '[]')
                       FROM task_assignees a JOIN tasks t ON t.id = a.task_id WHERE t.org_id = $1),
         'followers', (SELECT coalesce(jsonb_agg(to_jsonb(f) ORDER BY f.task_id, f.user_id), '[]')
                       FROM task_followers f JOIN tasks t ON t.id = f.task_id WHERE t.org_id = $1),
         'events', (SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.id), '[]')
                    FROM task_events e JOIN tasks t ON t.id = e.task_id WHERE t.org_id = $1),
         'lists', (SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.id), '[]') FROM task_lists l WHERE l.org_id = $1),
         'members', (SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.list_id, m.user_id), '[]')
                     FROM task_list_members m JOIN task_lists l ON l.id = m.list_id WHERE l.org_id = $1),
         'items', (SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.list_id, i.task_id), '[]') FROM task_list_items i WHERE i.org_id = $1),
         'listEvents', (SELECT coalesce(jsonb_agg(to_jsonb(v) ORDER BY v.id), '[]')
                        FROM task_list_events v JOIN task_lists l ON l.id = v.list_id WHERE l.org_id = $1),
         'groups', (SELECT coalesce(jsonb_agg(to_jsonb(g) ORDER BY g.id), '[]') FROM task_groups g WHERE g.org_id = $1),
         'groupItems', (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.group_id, p.task_id), '[]') FROM task_group_items p WHERE p.org_id = $1),
         'settings', (SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.user_id), '[]') FROM task_user_settings s WHERE s.org_id = $1)
       )::text AS state`,
      [org],
    )
    return String(result.rows[0]?.state)
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
    // RULED(2026-10-07): [N2] `bare` deliberately has no user_orgs row (b 刻意取反), and POST
    // /api/tasks names only active members of the org as assignees (design §4.6): its assignee row
    // is written with SQL, like its follower and comment rows below.
    const created = await app()
      .post('/api/tasks')
      .set('Authorization', `Bearer ${token()}`)
      .send({ title: '备料复核', assignees: [userId] })
    expect(created.status).toBe(200)
    const taskId = String(created.body.id)
    const commentId = `tcmt_hdrtenant_${stamp.replace(/-/g, '')}`
    await db.query('INSERT INTO task_assignees (task_id, user_id, assigned_by) VALUES ($1, $2, $3)', [taskId, bare, userId])
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
    // RULED(2026-10-07): [N2] a new follower must be an active member of the org (design §4.6).
    // The target keeps its fixed id: rows a killed earlier run may have left are removed by exact
    // id first, and again at the end of this cell and in the afterAll sweep.
    await db.query('DELETE FROM user_orgs WHERE user_id = $1', ['usr_follow_target'])
    await db.query('DELETE FROM users WHERE id = $1', ['usr_follow_target'])
    await seedOrgMembers(orgId, ['usr_follow_target'])
    const allowed = await app()
      .post(`/api/tasks/${created.body.id}/followers`)
      .set('Authorization', `Bearer ${bareToken}`)
      .send({ userId: 'usr_follow_target' })
    expect(allowed.status).toBe(200)
    expect(allowed.body).toEqual({ id: created.body.id, followers: ['usr_follow_target'] })

    await db.query('DELETE FROM tasks WHERE id = $1', [created.body.id])
    await db.query('DELETE FROM user_orgs WHERE user_id = $1', ['usr_follow_target'])
    await db.query('DELETE FROM users WHERE id = $1', ['usr_follow_target'])
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
  // The same write with tenantId naming an org where the user's user_orgs row is inactive: b 刻意取反
  // (that row has is_active = false); the same 422, byte for byte, and nothing in that org.
  // The following write with tenantId=home is the control: a–i 适用, including e.
  it('gate 1: a write whose tenant claim is a different org, or an org whose membership is inactive, is 422', async () => {
    const user = `usr_tasks_xorg_${stamp}`
    const role = `tasks_xorg_${stamp}`
    const home = `org_home_${stamp}`
    const other = `org_other_${stamp}`
    const inactiveOrg = `org_inactive_${stamp}`
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
      'INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, FALSE)',
      [user, inactiveOrg],
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
    const orgMissingText = JSON.stringify({ error: { code: 'ORG_MISSING' } })
    expect(denied.text).toBe(orgMissingText)
    const inactiveClaim = jwt.sign({
      userId: user, sub: user, email: `${user}@tasks-auth-gate.test`,
      role: 'user', roles: [role], perms: ['tasks:write'], tenantId: inactiveOrg,
    }, JWT_SECRET, { expiresIn: '1h' })
    const deniedInactive = await app()
      .post('/api/tasks')
      .set('Authorization', `Bearer ${inactiveClaim}`)
      .send({ title: '备料复核' })
    expect(deniedInactive.status).toBe(422)
    expect(deniedInactive.text).toBe(orgMissingText)
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
    const m3DeniedInactive = await app()
      .patch(`/api/tasks/${allowed.body.id}/completion-mode`)
      .set('Authorization', `Bearer ${inactiveClaim}`)
      .send({ completionMode: 'any' })
    expect(m3DeniedInactive.status).toBe(422)
    expect(m3DeniedInactive.text).toBe(orgMissingText)
    // Nothing reached the org whose membership is inactive.
    const inInactiveOrg = await db.query('SELECT count(*)::int AS n FROM tasks WHERE org_id = $1', [inactiveOrg])
    expect(inInactiveOrg.rows[0]?.n).toBe(0)
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

  // M4 PR-3a design §10.7 `M4|1|清单第二租户` (candidate row, not scored until the lock names it).
  // Gate 1 org-isolation read for task lists. §12.0: a–d, f–i 适用; e 不适用 (read cell).
  // b 适用: user_orgs has one row, org A, is_active; token tenantId = org A, checked against the
  // database under RBAC_TOKEN_TRUST=false. The token carries no perms claim. LB and its member row
  // exist only through SQL here.
  it('gate 1 (M4 lists): a list read stays inside the caller org until the list org predicate is removed', async () => {
    const compact = stamp.replace(/-/g, '')
    const user = `usr_tasks_liso_${stamp}`
    const role = `tasks_liso_${stamp}`
    const orgA = `orgLA_${stamp}`
    const orgB = `orgLB_${stamp}`
    const listA = `tlst_A${compact}`
    const listB = `tlst_B${compact}`
    const taskA = `tskLA${compact}`
    const taskB = `tskLB${compact}`
    const creator = `usr_tasks_liso_creator_${stamp}`
    const db = poolManager.get()
    await db.query('INSERT INTO roles (id, name) VALUES ($1, $2)', [role, role])
    await db.query(`INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, 'tasks:read')`, [role])
    await db.query(
      `INSERT INTO users (
         id, email, name, password_hash, role, permissions,
         is_active, activation_status, local_password_set, must_change_password
       ) VALUES (
         $1, $2, $3, 'x', 'user', '[]'::jsonb, TRUE, 'activated', TRUE, FALSE
       )`,
      [user, `${user}@tasks-auth-gate.test`, 'tasks-list-isolation'],
    )
    await db.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [user, role])
    await db.query('INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)', [user, orgA])
    await db.query(
      `INSERT INTO user_namespace_admissions (
         user_id, namespace, enabled, source, created_at, updated_at
       ) VALUES ($1, 'tasks', TRUE, 'test', now(), now())`,
      [user],
    )
    for (const [listId, taskId, org] of [[listA, taskA, orgA], [listB, taskB, orgB]] as const) {
      await db.query(`INSERT INTO task_lists (id, org_id, name, created_by) VALUES ($1, $2, '备料复核', $3)`, [listId, org, creator])
      await db.query(`INSERT INTO task_list_members (list_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'edit')`, [listId, creator, user])
      await db.query(
        `INSERT INTO tasks (id, org_id, title, status, completion_mode, created_by) VALUES ($1, $2, '备料复核', 'open', 'all', $3)`,
        [taskId, org, creator],
      )
      await db.query(`INSERT INTO task_list_items (list_id, task_id, org_id) VALUES ($1, $2, $3)`, [listId, taskId, org])
    }
    const bearer = jwt.sign({
      userId: user, sub: user, email: `${user}@tasks-auth-gate.test`,
      role: 'user', roles: [role], tenantId: orgA,
    }, JWT_SECRET, { expiresIn: '1h' })
    const accessFile = new URL('../../src/tasks/task-list-access.ts', import.meta.url).pathname
    const listRecordsFile = new URL('../../src/services/task-list-records.ts', import.meta.url).pathname
    const needle = '(task_lists.org_id = ${ORG_PLACEHOLDER}) AND '
    const original = readFileSync(accessFile, 'utf8')
    const backup = `/tmp/task-list-access-org-${stamp}.bak`
    const script = `/tmp/task-list-org-mutant-${stamp}.mts`
    try {
      // Positive control first.
      const mine = await app().get('/api/task-lists').set('Authorization', `Bearer ${bearer}`)
      expect(mine.status).toBe(200)
      expect((mine.body.items as { id: string }[]).map((item) => item.id)).toEqual([listA])
      const readA = await app().get(`/api/task-lists/${listA}`).set('Authorization', `Bearer ${bearer}`)
      expect(readA.status).toBe(200)
      expect(readA.body.id).toBe(listA)
      const missing = await app().get(`/api/task-lists/tlst_missing${compact}`).set('Authorization', `Bearer ${bearer}`)
      expect(missing.status).toBe(404)
      // S7: the item read of the caller's own list lists its task.
      const itemsA = await app().get(`/api/task-lists/${listA}/items`).set('Authorization', `Bearer ${bearer}`)
      expect(itemsA.status).toBe(200)
      expect((itemsA.body.items as { id: string }[]).map((item) => item.id)).toEqual([taskA])
      // Every read under one list id (S5–S8): the list, its events, members, items, groups and
      // group placements. Each is 200 on LA and, on LB, the 404 of a list id that does not exist.
      for (const suffix of ['', '/events', '/members', '/items', '/groups', '/group-items']) {
        const own = await app().get(`/api/task-lists/${listA}${suffix}`).set('Authorization', `Bearer ${bearer}`)
        expect(own.status, `LA${suffix}`).toBe(200)
        const hidden = await app().get(`/api/task-lists/${listB}${suffix}`).set('Authorization', `Bearer ${bearer}`)
        expect(hidden.status, `LB${suffix}`).toBe(404)
        expect(hidden.text, `LB${suffix}`).toBe(missing.text)
      }

      expect(original.split(needle).length - 1).toBe(1)
      copyFileSync(accessFile, backup)
      writeFileSync(accessFile, original.replace(needle, '(${ORG_PLACEHOLDER}::text IS NOT NULL) AND '))
      writeFileSync(script, `
        const { listTaskLists, getTaskList } = await import(${JSON.stringify(listRecordsFile)})
        const mine = await listTaskLists({ orgId: ${JSON.stringify(orgA)}, actorId: ${JSON.stringify(user)}, query: {} })
        const listed = mine.items.map((item) => item.id).includes(${JSON.stringify(listB)})
        let byId = false
        try {
          const list = await getTaskList({ orgId: ${JSON.stringify(orgA)}, actorId: ${JSON.stringify(user)}, listId: ${JSON.stringify(listB)} })
          byId = list.id === ${JSON.stringify(listB)}
        } catch { byId = false }
        console.log(JSON.stringify({ gate1lists: 'red', listed, byId }))
        process.exit(listed && byId ? 0 : 1)
      `)
      const tsx = createRequire(import.meta.url).resolve('tsx/cli')
      execFileSync(process.execPath, [tsx, script], {
        cwd: accessFile.slice(0, accessFile.indexOf('/src/tasks/')),
        env: process.env,
        stdio: 'inherit',
        timeout: 120000,
      })
    } finally {
      try { copyFileSync(backup, accessFile) } catch { /* backup was not written */ }
      try { unlinkSync(script) } catch { /* script was not written */ }
      try { unlinkSync(backup) } catch { /* backup was not written */ }
      expect(readFileSync(accessFile, 'utf8')).toBe(original)
      await db.query('DELETE FROM tasks WHERE id = ANY($1::text[])', [[taskA, taskB]])
      await db.query('DELETE FROM task_lists WHERE id = ANY($1::text[])', [[listA, listB]])
      await db.query('DELETE FROM user_namespace_admissions WHERE user_id = $1', [user])
      await db.query('DELETE FROM user_roles WHERE user_id = $1', [user])
      await db.query('DELETE FROM user_orgs WHERE user_id = $1', [user])
      await db.query('DELETE FROM users WHERE id = $1', [user])
      await db.query('DELETE FROM role_permissions WHERE role_id = $1', [role])
      await db.query('DELETE FROM roles WHERE id = $1', [role])
    }
  }, 180000)

  // ---------------------------------------------------------------------------------------------
  // M4 PR-3a S10 (design §10.7): the 30 M4 routes under RBAC_TOKEN_TRUST=false.
  // ---------------------------------------------------------------------------------------------

  type M4GateUser = { userId: string; roleId: string }

  /** A user whose grants stay fixed for every cell that uses it (so the RBAC permission cache
   * cannot mask a cell): a role carrying `codes`, an active `user_orgs` row in `org`, and the tasks
   * namespace admission when `admission` is true. */
  async function seedGateUser(label: string, codes: string[], admission: boolean, org: string): Promise<M4GateUser> {
    const user = `usr_tasks_${label}_${stamp}`
    const role = `tasks_${label}_${stamp}`
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
      [user, `${user}@tasks-auth-gate.test`, `tasks-${label}`],
    )
    await db.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [user, role])
    await db.query('INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)', [user, org])
    if (admission) {
      await db.query(
        `INSERT INTO user_namespace_admissions (
           user_id, namespace, enabled, source, created_at, updated_at
         ) VALUES ($1, 'tasks', TRUE, 'test', now(), now())`,
        [user],
      )
    }
    return { userId: user, roleId: role }
  }

  /** A bearer for `who`; `tenant` null signs a token with no tenant claim. */
  function gateToken(who: M4GateUser, tenant: string | null): string {
    return jwt.sign({
      userId: who.userId, sub: who.userId, email: `${who.userId}@tasks-auth-gate.test`,
      role: 'user', roles: [who.roleId], perms: ['tasks:read', 'tasks:write'],
      ...(tenant === null ? {} : { tenantId: tenant }),
    }, JWT_SECRET, { expiresIn: '1h' })
  }

  async function dropGateUsers(who: M4GateUser[]): Promise<void> {
    const db = poolManager.get()
    for (const { userId: user, roleId: role } of who) {
      await db.query('DELETE FROM tasks WHERE created_by = $1', [user])
      await db.query('DELETE FROM task_lists WHERE created_by = $1', [user])
      await db.query('DELETE FROM task_groups WHERE user_id = $1', [user])
      await db.query('DELETE FROM task_user_settings WHERE user_id = $1', [user])
      await db.query('DELETE FROM user_namespace_admissions WHERE user_id = $1', [user])
      await db.query('DELETE FROM user_orgs WHERE user_id = $1', [user])
      await db.query('DELETE FROM user_roles WHERE user_id = $1', [user])
      await db.query('DELETE FROM users WHERE id = $1', [user])
      await db.query('DELETE FROM role_permissions WHERE role_id = $1', [role])
      await db.query('DELETE FROM roles WHERE id = $1', [role])
    }
  }

  // Gates 1 / 2 / 16, route population (design §10.7). The routes `tasksRouter()` registers, as
  // "METHOD path", equal the union of P0A_ROUTES, M3_ROUTES and M4_ROUTES: 8 + 13 + 30 = 51 at the
  // end of PR-3a. Every route is registered directly on the factory's router, so each stack layer
  // carries one route; any other layer (a nested router, a middleware) fails the comparison.
  // Each M3 and M4 row is also bound to its label through the request the per-route cells send:
  // the row's method and its path with the placeholder ids are resolved the way Express
  // dispatches them (the first stack layer whose route has that method and whose path matches),
  // and that layer's "METHOD path" must be the row's label. A row whose method or path drifted to
  // a sibling route fails here even though its label still matches the router.
  it('gates 1/2/16 (M4): tasksRouter() registers exactly the P0-A, M3 and M4 route tables, no table repeats a route, and every M3 / M4 row requests the route its label names', () => {
    const router = tasksRouter()
    expect(router).not.toBeNull()
    type StackLayer = { route?: { path: unknown; methods: Record<string, boolean> }; match: (path: string) => boolean }
    const stack = (router as unknown as { stack: StackLayer[] }).stack
    const registered: string[] = []
    for (const layer of stack) {
      if (!layer.route) {
        registered.push('(a layer without a route)')
        continue
      }
      for (const method of Object.keys(layer.route.methods)) registered.push(`${method.toUpperCase()} ${String(layer.route.path)}`)
    }
    const tables = [...P0A_ROUTES, ...M3_ROUTES.map((route) => route.label), ...M4_ROUTES.map((route) => route.label)]
    expect(new Set(tables).size, 'a route appears twice in the tables').toBe(tables.length)
    expect(new Set(registered).size, 'the router registers a route twice').toBe(registered.length)
    expect([P0A_ROUTES.length, M3_ROUTES.length, M4_ROUTES.length]).toEqual([8, 13, 30])
    expect([...registered].sort()).toEqual([...tables].sort())
    const dispatchedTo = (method: string, url: string): string => {
      const layer = stack.find((candidate) => candidate.route?.methods[method] === true && candidate.match(url))
      return layer?.route ? `${method.toUpperCase()} ${String(layer.route.path)}` : `(no route for ${method.toUpperCase()} ${url})`
    }
    for (const route of M3_ROUTES) {
      expect(dispatchedTo(route.method, route.path(M3_PLACEHOLDER)), route.label).toBe(route.label)
    }
    for (const route of M4_ROUTES) {
      expect(dispatchedTo(route.method, route.path(M4_PLACEHOLDER)), route.label).toBe(route.label)
    }
  })

  // Gate 1 for every M4 route (design §10.7 ①; candidate subset rows of gate 1, not scored until
  // the lock carries them). One user with both codes, the admission and an active user_orgs row in
  // its home org. Four tokens:
  // - no tenant claim, sent with x-tenant-id / x-org-id headers that name the home org:
  //   a, c, d, f–i 适用; b 刻意取反 (no tenantId claim); e 适用 on write routes;
  // - a tenant claim for an org the user has no user_orgs row in:
  //   a, c, d, f–i 适用; b 刻意取反 (tenantId ≠ every user_orgs.org_id); e 适用 on write routes;
  // - a tenant claim for an org where the user's user_orgs row is inactive:
  //   a, c, d, f–i 适用; b 刻意取反 (that row has is_active = false); e 适用 on write routes;
  // - the home org as tenant claim, for the rows a cell seeds first and for its 200 control:
  //   a–i 适用, including e.
  // Without an org a write is 422 ORG_MISSING, a collection read the degraded body without
  // `total`, a read under one id 404, byte for byte; no row of the home org or of the inactive
  // org changes.
  describe('gate 1: every M4 route without an org', () => {
    const home = `org_tasks_auth_m4home_${stamp}`
    const foreignOrg = `org_tasks_auth_m4foreign_${stamp}`
    const inactiveOrg = `org_tasks_auth_m4inactive_${stamp}`
    const target = `usr_m4_noorg_target_${stamp}`
    let user: M4GateUser
    let tokens: { member: string; noClaim: string; foreign: string; inactive: string }

    beforeAll(async () => {
      user = await seedGateUser('m4noorg', ['tasks:read', 'tasks:write'], true, home)
      // The user's relation to `inactiveOrg` exists but is deactivated (a user who left that org).
      await poolManager.get().query(
        'INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, FALSE)',
        [user.userId, inactiveOrg],
      )
      tokens = {
        member: gateToken(user, home),
        noClaim: gateToken(user, null),
        foreign: gateToken(user, foreignOrg),
        inactive: gateToken(user, inactiveOrg),
      }
      // RULED(2026-10-07): [R17] [N2] the member and owner target of the 200 controls.
      await seedOrgMembers(home, [target])
    })

    afterAll(async () => {
      await dropGateUsers([user])
      const db = poolManager.get()
      await db.query('DELETE FROM user_orgs WHERE user_id = $1', [target])
      await db.query('DELETE FROM users WHERE id = $1', [target])
    })

    it.each(M4_ROUTES)('$label: no tenant claim, a claim without membership and a claim with an inactive membership all get the no-org answer; nothing is written; the member control is 200', async (route) => {
      const server = app()
      const ctx = await seedM4(server, route, tokens.member, user.userId, target)
      const expected = m4NoOrgText(route)
      const before = await m4OrgState(home)
      const beforeInactive = await m4OrgState(inactiveOrg)

      const noClaim = await m4Request(server, route, ctx, tokens.noClaim)
        .set('x-tenant-id', home)
        .set('x-org-id', home)
      expect(noClaim.status, route.label).toBe(expected.status)
      expect(noClaim.text, route.label).toBe(expected.text)

      const foreign = await m4Request(server, route, ctx, tokens.foreign)
      expect(foreign.status, route.label).toBe(expected.status)
      expect(foreign.text, route.label).toBe(expected.text)

      const inactive = await m4Request(server, route, ctx, tokens.inactive)
      expect(inactive.status, `${route.label} (inactive membership)`).toBe(expected.status)
      expect(inactive.text, `${route.label} (inactive membership)`).toBe(expected.text)

      expect(await m4OrgState(home), route.label).toBe(before)
      expect(await m4OrgState(inactiveOrg), `${route.label} (inactive membership)`).toBe(beforeInactive)

      const allowed = await m4Request(server, route, ctx, tokens.member)
      expect(allowed.status, route.label).toBe(200)
    })
  })

  // Gate 2/16 for every M4 route, one it() per route (design §10.7; candidate subset rows of gates
  // 2 / 16, not scored until the lock carries them). §12.0: a–d, f–i 适用; e 适用 on write routes.
  // Each user's grants are fixed for the whole block:
  // - noAdmit: both codes and user_orgs, no namespace admission ⇒ 403;
  // - wrongCode: admission and user_orgs, but only the other code ⇒ 403;
  // - adminOnly: admission and user_orgs, and only tasks:admin ⇒ 403 (RULED(2026-10-07): [R18] no
  //   route here takes tasks:admin, so that code alone opens none of them);
  // - control: both codes, admission, user_orgs ⇒ 200 on rows it created.
  // The 403 cells use placeholder ids and bodies the handler would answer 404 or 422 to, or a route
  // whose handler answers 200; a 403 can only come from the route's rbacGuard carrying its code.
  describe('gate 2/16: every M4 route', () => {
    const users = {} as Record<'noAdmit' | 'readOnly' | 'writeOnly' | 'adminOnly' | 'control', M4GateUser>
    const bearer = (who: M4GateUser): string => gateToken(who, orgId)

    beforeAll(async () => {
      users.noAdmit = await seedGateUser('m4gate_noadmit', ['tasks:read', 'tasks:write'], false, orgId)
      users.readOnly = await seedGateUser('m4gate_readonly', ['tasks:read'], true, orgId)
      users.writeOnly = await seedGateUser('m4gate_writeonly', ['tasks:write'], true, orgId)
      users.adminOnly = await seedGateUser('m4gate_adminonly', ['tasks:admin'], true, orgId)
      users.control = await seedGateUser('m4gate_control', ['tasks:read', 'tasks:write'], true, orgId)
    })

    afterAll(async () => {
      await dropGateUsers(Object.values(users))
    })

    it.each(M4_ROUTES)('$label: 403 without admission, 403 with only the other code, 403 with only tasks:admin, 200 for the control', async (route) => {
      const server = app()
      const noAdmit = await m4Request(server, route, M4_PLACEHOLDER, bearer(users.noAdmit))
      expect(noAdmit.status, route.label).toBe(403)
      expect(noAdmit.body, route.label).toEqual({ error: 'Insufficient permissions' })

      const wrongCode = route.code === 'write' ? users.readOnly : users.writeOnly
      const denied = await m4Request(server, route, M4_PLACEHOLDER, bearer(wrongCode))
      expect(denied.status, route.label).toBe(403)
      expect(denied.body, route.label).toEqual({ error: 'Insufficient permissions' })

      const adminOnly = await m4Request(server, route, M4_PLACEHOLDER, bearer(users.adminOnly))
      expect(adminOnly.status, `${route.label} (tasks:admin only)`).toBe(403)
      expect(adminOnly.body, `${route.label} (tasks:admin only)`).toEqual({ error: 'Insufficient permissions' })

      const ctx = await seedM4(server, route, bearer(users.control), users.control.userId, M4_TARGET)
      const allowed = await m4Request(server, route, ctx, bearer(users.control))
      expect(allowed.status, route.label).toBe(200)
    })
  })

  // RULED(2026-10-07): [own-53] under RBAC_TOKEN_TRUST=false (design §3.4, §6.3; the realdb files
  // hold the full grid under token trust). Adding or removing an assignee or a follower takes a
  // direct role on the task, creator or assignee. A caller whose `edit` comes from a list role is
  // answered like a task that does not exist, before the body and the path user id are read, and
  // keeps PATCH. §12.0: a–i 适用, including e, for both users (b: user_orgs.org_id = token tenantId,
  // checked against the database).
  it('[own-53] (M4, trust-off): the four assignee and follower writes take a direct role on the task; a list edit member gets the missing-task 404, the creator 200', async () => {
    const org = `org_tasks_auth_own53_${stamp}`
    const follower = `usr_own53_target_${stamp}`
    const creator = await seedGateUser('own53creator', ['tasks:read', 'tasks:write'], true, org)
    const editor = await seedGateUser('own53editor', ['tasks:read', 'tasks:write'], true, org)
    await seedOrgMembers(org, [follower])
    const asCreator = gateToken(creator, org)
    const asEditor = gateToken(editor, org)
    try {
      const server = app()
      const send = async (test: supertest.Test, bearerToken: string, body?: Record<string, unknown>) => {
        const authed = test.set('Authorization', `Bearer ${bearerToken}`)
        return body ? authed.send(body) : authed
      }
      const created = await send(server.post('/api/tasks'), asCreator, { title: '备料复核', assignees: [creator.userId] })
      expect(created.status).toBe(200)
      const taskId = String(created.body.id)
      expect((await send(server.post(`/api/tasks/${taskId}/followers`), asCreator, { userId: follower })).status).toBe(200)
      const list = await send(server.post('/api/task-lists'), asCreator, { name: '备料复核' })
      expect(list.status).toBe(200)
      const listId = String(list.body.id)
      expect((await send(server.post(`/api/task-lists/${listId}/members`), asCreator, { userId: editor.userId, role: 'edit' })).status).toBe(200)
      expect((await send(server.post(`/api/task-lists/${listId}/items`), asCreator, { taskId })).status).toBe(200)

      const detail = await send(server.get(`/api/tasks/${taskId}`), asEditor)
      expect(detail.status).toBe(200)
      expect(detail.body).toMatchObject({ canEdit: true, canManageMembers: false })

      const missingTask = `tsk_missing_${stamp.replace(/-/g, '')}`
      const writes: Array<{ method: 'post' | 'delete'; path: (id: string) => string; body?: Record<string, unknown> }> = [
        { method: 'post', path: (id) => `/api/tasks/${id}/assignees`, body: { userId: editor.userId } },
        { method: 'delete', path: (id) => `/api/tasks/${id}/assignees/${creator.userId}` },
        { method: 'post', path: (id) => `/api/tasks/${id}/followers`, body: { userId: editor.userId } },
        { method: 'delete', path: (id) => `/api/tasks/${id}/followers/${follower}` },
      ]
      const before = await m4OrgState(org)
      for (const write of writes) {
        const missing = await send(server[write.method](write.path(missingTask)), asEditor, write.body)
        expect(missing.status).toBe(404)
        const refused = await send(server[write.method](write.path(taskId)), asEditor, write.body)
        expect(refused.status, write.path(taskId)).toBe(404)
        expect(refused.text, write.path(taskId)).toBe(missing.text)
      }
      expect(await m4OrgState(org)).toBe(before)

      // The list edit member keeps PATCH.
      const patched = await send(server.patch(`/api/tasks/${taskId}`), asEditor, { expectedVersion: Number(detail.body.version), title: '备料复核(改)' })
      expect(patched.status).toBe(200)

      // The creator holds a direct role: the same four writes are 200.
      for (const write of writes) {
        const response = await send(server[write.method](write.path(taskId)), asCreator, write.body)
        expect(response.status, write.path(taskId)).toBe(200)
      }
    } finally {
      await dropGateUsers([creator, editor])
      const db = poolManager.get()
      await db.query('DELETE FROM user_orgs WHERE user_id = $1', [follower])
      await db.query('DELETE FROM users WHERE id = $1', [follower])
    }
  })

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
