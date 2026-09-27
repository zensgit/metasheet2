import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
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

  it('rejects GET /api/tasks/:id when the database does not grant tasks:read', async () => {
    const response = await request(app())
      .get('/api/tasks/tsk_missing')
      .set('Authorization', `Bearer ${token()}`)
    expect(response.status).toBe(403)
    expect(response.body).toEqual({ error: 'Insufficient permissions' })
  })

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
    const read = await request(app())
      .get('/api/tasks')
      .set('Authorization', `Bearer ${bareToken}`)
    expect(read.status).toBe(200)
    expect(read.body).toEqual({ items: [], degraded: true, reason: 'org_missing' })
    const write = await request(app())
      .post('/api/tasks')
      .set('Authorization', `Bearer ${bareToken}`)
      .send({ title: '备料复核' })
    expect(write.status).toBe(422)
    expect(write.body).toEqual({ error: { code: 'ORG_MISSING' } })
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
    const allowed = await request(app())
      .post('/api/tasks')
      .set('Authorization', `Bearer ${orgToken}`)
      .send({ title: '备料复核' })
    expect(allowed.status).toBe(200)
    await db.query('DELETE FROM user_orgs WHERE user_id = $1', [bare])
    await db.query('DELETE FROM user_namespace_admissions WHERE user_id = $1', [bare])
    await db.query('DELETE FROM user_roles WHERE user_id = $1', [bare])
    await db.query('DELETE FROM users WHERE id = $1', [bare])
    await db.query('DELETE FROM role_permissions WHERE role_id = $1', [bareRole])
    await db.query('DELETE FROM roles WHERE id = $1', [bareRole])
  })

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
    const response = await request(app())
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
    const denied = await request(app())
      .post('/api/tasks')
      .set('Authorization', `Bearer ${foreign}`)
      .send({ title: '备料复核' })
    expect(denied.status).toBe(422)
    expect(denied.body).toEqual({ error: { code: 'ORG_MISSING' } })
    const member = jwt.sign({
      userId: user, sub: user, email: `${user}@tasks-auth-gate.test`,
      role: 'user', roles: [role], perms: ['tasks:write'], tenantId: home,
    }, JWT_SECRET, { expiresIn: '1h' })
    const allowed = await request(app())
      .post('/api/tasks')
      .set('Authorization', `Bearer ${member}`)
      .send({ title: '备料复核' })
    expect(allowed.status).toBe(200)
    await db.query('DELETE FROM tasks WHERE org_id = $1', [home])
    await db.query('DELETE FROM user_namespace_admissions WHERE user_id = $1', [user])
    await db.query('DELETE FROM user_roles WHERE user_id = $1', [user])
    await db.query('DELETE FROM user_orgs WHERE user_id = $1', [user])
    await db.query('DELETE FROM users WHERE id = $1', [user])
    await db.query('DELETE FROM role_permissions WHERE role_id = $1', [role])
    await db.query('DELETE FROM roles WHERE id = $1', [role])
  })

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
    const listed = await request(server)
      .get('/api/tasks')
      .query({ view: 'any_role' })
      .set('Authorization', `Bearer ${bearer}`)
    const pending = await request(server)
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
    copyFileSync(accessFile, backup)
    writeFileSync(accessFile, original.replace(
      needle,
      '(${ORG_PLACEHOLDER}::text IS NOT NULL) AND ',
    ))
    const recordsFile = new URL('../../src/services/task-records.ts', import.meta.url).pathname
    const script = `/tmp/task-org-mutant-${stamp}.mts`
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
    try {
      execFileSync(process.execPath, [tsx, script], {
        cwd: accessFile.slice(0, accessFile.indexOf('/src/tasks/')),
        env: process.env,
        stdio: 'inherit',
        timeout: 120000,
      })
    } finally {
      copyFileSync(backup, accessFile)
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

  it('allows POST /api/tasks when the database grants tasks:write', async () => {
    const response = await request(app())
      .post('/api/tasks')
      .set('Authorization', `Bearer ${token()}`)
      .send({ title: '备料复核' })
    expect(response.status).toBe(200)
    expect(String(response.body.id)).toMatch(/^tsk_/)
  })
})
