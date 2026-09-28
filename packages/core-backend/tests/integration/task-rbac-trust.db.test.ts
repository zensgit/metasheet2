/**
 * Gate 2 and gate 13 under RBAC_TOKEN_TRUST=true (integration setup).
 * Tokens do not carry perms. Static paths are registered before /:id.
 */
import '../helpers/assert-rbac-optional-off'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFileSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import express from 'express'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { poolManager } from '../../src/integration/db/connection-pool'
import { MetaSheetServer } from '../../src/index'
import { completeTask, countPending, createTask } from '../../src/services/task-records'
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

  it('returns different rows for assigned and created', async () => {
    const actor = await userWith({ label: 'views', codes: ['tasks:read'], admission: true })
    const other = `usr_other_views_${stamp}`
    const createdOnly = await createTask({
      orgId, creatorId: actor.userId, title: '备料复核', assignees: [other], completionMode: 'all',
    })
    const assignedOnly = await createTask({
      orgId, creatorId: other, title: '备料复核', assignees: [actor.userId], completionMode: 'all',
    })
    const server = app()
    const assigned = await request(server)
      .get('/api/tasks')
      .query({ view: 'assigned' })
      .set('Authorization', `Bearer ${actor.bearer}`)
    const created = await request(server)
      .get('/api/tasks')
      .query({ view: 'created' })
      .set('Authorization', `Bearer ${actor.bearer}`)
    expect(assigned.status).toBe(200)
    expect(created.status).toBe(200)
    const assignedIds = (assigned.body.items as { id: string }[]).map((row) => row.id)
    const createdIds = (created.body.items as { id: string }[]).map((row) => row.id)
    expect(assignedIds).toContain(assignedOnly.id)
    expect(assignedIds).not.toContain(createdOnly.id)
    expect(createdIds).toContain(createdOnly.id)
    expect(createdIds).not.toContain(assignedOnly.id)
  })

  it('degrades an unknown view instead of failing the request', async () => {
    const actor = await userWith({ label: 'badview', codes: ['tasks:read'], admission: true })
    const response = await request(app())
      .get('/api/tasks')
      .query({ view: 'not-a-view' })
      .set('Authorization', `Bearer ${actor.bearer}`)
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ items: [], degraded: true, reason: 'predicate_error' })
  })

  it('pending routes degrade when the tenant is missing and do not read org default', async () => {
    const actor = await userWith({ label: 'notenant', codes: ['tasks:read'], admission: true })
    const bare = jwt.sign({
      userId: actor.userId,
      sub: actor.userId,
      email: `${actor.userId}@tasks-trust.test`,
      role: 'user',
      roles: [actor.roleId],
    }, JWT_SECRET, { expiresIn: '1h' })
    const planted = await createTask({
      orgId: 'default',
      creatorId: `usr_def_${stamp}`,
      title: '备料复核',
      assignees: [actor.userId],
      completionMode: 'all',
    })
    try {
      await poolManager.get().query(
        `UPDATE tasks
         SET due_date = ((now() AT TIME ZONE 'UTC')::date - 1),
             due_time = TIME '12:00',
             due_at = now() - interval '2 hours',
             time_zone = 'UTC'
         WHERE id = $1`,
        [planted.id],
      )
      const server = app()
      const pending = await request(server)
        .get('/api/tasks/pending')
        .set('Authorization', `Bearer ${bare}`)
      const count = await request(server)
        .get('/api/tasks/pending-count')
        .set('Authorization', `Bearer ${bare}`)
      expect(pending.status).toBe(200)
      expect(pending.body).toEqual({ items: [], degraded: true, reason: 'org_missing' })
      expect(count.status).toBe(200)
      expect(count.body).toEqual({ count: 0, degraded: true, reason: 'org_missing' })
    } finally {
      await poolManager.get().query('DELETE FROM tasks WHERE id = $1', [planted.id])
    }
  })

  it('gate 8: invalid and missing viewer zones follow the task zone on pending-count', async () => {
    const actor = await userWith({ label: 'g8', codes: ['tasks:read'], admission: true })
    const picked = zoneThatDisagreesWithUtc(new Date())
    const created = await createTask({
      orgId, creatorId: `usr_g8c_${stamp}`, title: '备料复核', assignees: [actor.userId], completionMode: 'all',
    })
    await poolManager.get().query(
      `UPDATE tasks SET due_date = $2, due_time = NULL, due_at = NULL, time_zone = $3 WHERE id = $1`,
      [created.id, picked.dueDate, picked.timeZone],
    )
    expect(await countPending({ orgId, actorId: actor.userId, viewerTz: picked.timeZone })).toBe(picked.taskCount)
    expect(await countPending({ orgId, actorId: actor.userId, viewerTz: null })).toBe(picked.taskCount)
    expect(await countPending({ orgId, actorId: actor.userId, viewerTz: 'UTC' })).toBe(picked.utcCount)
    const server = app()
    const explicit = await httpCount(server, actor.bearer, picked.timeZone)
    const invalid = await httpCount(server, actor.bearer, 'Not/AZone')
    const missing = await httpCount(server, actor.bearer)
    expect(explicit).toBe(picked.taskCount)
    expect(invalid).toBe(explicit)
    expect(missing).toBe(explicit)
  })

  it('gate 8 negative: a UTC fallback on the count route separates invalid and missing headers', async () => {
    const actor = await userWith({ label: 'g8neg', codes: ['tasks:read'], admission: true })
    const picked = zoneThatDisagreesWithUtc(new Date())
    const created = await createTask({
      orgId, creatorId: `usr_g8n_${stamp}`, title: '备料复核', assignees: [actor.userId], completionMode: 'all',
    })
    await poolManager.get().query(
      `UPDATE tasks SET due_date = $2, due_time = NULL, due_at = NULL, time_zone = $3 WHERE id = $1`,
      [created.id, picked.dueDate, picked.timeZone],
    )
    const route = new URL('../../src/routes/tasks.ts', import.meta.url)
    const nodeRequire = createRequire(import.meta.url)
    const expressEntry = nodeRequire.resolve('express')
    const supertestEntry = nodeRequire.resolve('supertest')
    const jwtEntry = nodeRequire.resolve('jsonwebtoken')
    const needle = `const viewerTz = validateViewerTimeZoneHeader(req.header('x-viewer-time-zone'))
      const count = await countPending({ orgId: org, actorId: actorId(req), viewerTz })`
    runRouteMutant(route.pathname, needle, needle.replace(
      'validateViewerTimeZoneHeader(req.header(\'x-viewer-time-zone\'))',
      'validateViewerTimeZoneHeader(req.header(\'x-viewer-time-zone\')) ?? \'UTC\'',
    ), `
      const expressMod = await import(${JSON.stringify(expressEntry)})
      const supertestMod = await import(${JSON.stringify(supertestEntry)})
      const jwtMod = await import(${JSON.stringify(jwtEntry)})
      const express = expressMod.default ?? expressMod
      const request = supertestMod.default ?? supertestMod
      const jwt = jwtMod.default ?? jwtMod
      const { tasksRouter } = await import(${JSON.stringify(route.pathname)})
      const token = jwt.sign({
        userId: process.env.GATE8_USER,
        sub: process.env.GATE8_USER,
        email: process.env.GATE8_USER + '@tasks-trust.test',
        role: 'user',
        roles: [process.env.GATE8_ROLE],
        tenantId: process.env.GATE8_ORG,
      }, process.env.JWT_SECRET, { expiresIn: '1h' })
      const router = tasksRouter()
      if (!router) process.exit(1)
      const server = express()
      server.use(express.json())
      server.use(router)
      async function count(header) {
        const req = request(server).get('/api/tasks/pending-count').set('Authorization', 'Bearer ' + token)
        if (header) req.set('x-viewer-time-zone', header)
        const res = await req
        if (res.status !== 200 || typeof res.body.count !== 'number') process.exit(1)
        return res.body.count
      }
      const explicit = await count(process.env.GATE8_TZ)
      const invalid = await count('Not/AZone')
      const missing = await count('')
      console.log(JSON.stringify({ gate8route: 'red', explicit, invalid, missing }))
      if (invalid === explicit || missing === explicit) process.exit(1)
      process.exit(0)
    `, {
      GATE8_USER: actor.userId,
      GATE8_ROLE: actor.roleId,
      GATE8_ORG: orgId,
      GATE8_TZ: picked.timeZone,
    })
  }, 180000)

  it('gate 13: MetaSheetServer mounts the tasks router from index.ts', async () => {
    const actor = await userWith({ label: 'mount', codes: ['tasks:read'], admission: true })
    const server = new MetaSheetServer({
      port: 0,
      host: '127.0.0.1',
      pluginDirs: [],
      manageProcessSignals: false,
    })
    const mounted = (server as unknown as { app: express.Express }).app
    const response = await request(mounted)
      .get('/api/tasks/context')
      .set('Authorization', `Bearer ${actor.bearer}`)
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ orgId })
  })

  it('POST /complete persists the assignee completion', async () => {
    const actor = await userWith({ label: 'httpdone', codes: ['tasks:read', 'tasks:write'], admission: true })
    const created = await createTask({
      orgId, creatorId: `usr_creator_httpdone_${stamp}`, title: '备料复核',
      assignees: [actor.userId], completionMode: 'all',
    })
    const response = await request(app())
      .post(`/api/tasks/${created.id}/complete`)
      .set('Authorization', `Bearer ${actor.bearer}`)
      .send({})
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ done: true })
    const row = await poolManager.get().query<{ status: string; stamped: boolean }>(
      `SELECT t.status, a.completed_at IS NOT NULL AS stamped
       FROM tasks t JOIN task_assignees a ON a.task_id = t.id
       WHERE t.id = $1 AND a.user_id = $2`,
      [created.id, actor.userId],
    )
    expect(row.rows[0]).toEqual({ status: 'done', stamped: true })
  })

  it('POST /reopen with scope all clears every assignee', async () => {
    const actor = await userWith({ label: 'httpreopen', codes: ['tasks:read', 'tasks:write'], admission: true })
    const other = `usr_other_httpreopen_${stamp}`
    const created = await createTask({
      orgId, creatorId: actor.userId, title: '备料复核',
      assignees: [actor.userId, other], completionMode: 'all',
    })
    await completeTask({ orgId, actorId: actor.userId, taskId: created.id })
    await completeTask({ orgId, actorId: other, taskId: created.id })
    const response = await request(app())
      .post(`/api/tasks/${created.id}/reopen`)
      .set('Authorization', `Bearer ${actor.bearer}`)
      .send({ scope: 'all' })
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ ok: true })
    const rows = await poolManager.get().query<{ user_id: string; stamped: boolean }>(
      `SELECT user_id, completed_at IS NOT NULL AS stamped FROM task_assignees WHERE task_id = $1 ORDER BY user_id`,
      [created.id],
    )
    expect(rows.rows).toEqual([
      { user_id: actor.userId, stamped: false },
      { user_id: other, stamped: false },
    ])
    const status = await poolManager.get().query<{ status: string }>(
      'SELECT status FROM tasks WHERE id = $1',
      [created.id],
    )
    expect(status.rows[0]?.status).toBe('open')
  })
})

function httpCount(server: express.Express, bearer: string, header?: string): Promise<number> {
  const req = request(server).get('/api/tasks/pending-count').set('Authorization', `Bearer ${bearer}`)
  if (header !== undefined) req.set('x-viewer-time-zone', header)
  return req.then((response) => {
    expect(response.status).toBe(200)
    return response.body.count as number
  })
}

function civilDate(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now)
}

function minutesInZone(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now)
  const hour = Number(parts.find((part) => part.type === 'hour')?.value)
  const minute = Number(parts.find((part) => part.type === 'minute')?.value)
  return hour * 60 + minute
}

function zoneThatDisagreesWithUtc(now: Date): {
  timeZone: string
  dueDate: string
  taskCount: number
  utcCount: number
} {
  const utcDate = civilDate(now, 'UTC')
  for (const timeZone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Asia/Shanghai']) {
    const localDate = civilDate(now, timeZone)
    if (localDate === utcDate) continue
    const minutes = minutesInZone(now, timeZone)
    if (minutes < 2 || minutes > 24 * 60 - 2) continue
    if (localDate > utcDate) return { timeZone, dueDate: utcDate, taskCount: 1, utcCount: 0 }
    return { timeZone, dueDate: localDate, taskCount: 0, utcCount: 1 }
  }
  throw new Error('no viewer zone is a different civil date from UTC')
}

function runRouteMutant(
  file: string,
  needle: string,
  replacement: string,
  body: string,
  extraEnv: Record<string, string>,
): void {
  const backup = `/tmp/task-mutant-${randomUUID()}.bak`
  const script = `/tmp/task-probe-${randomUUID()}.mts`
  copyFileSync(file, backup)
  const original = readFileSync(file, 'utf8')
  let failed: unknown
  try {
    expect(original.includes(needle)).toBe(true)
    writeFileSync(file, original.replace(needle, replacement))
    writeFileSync(script, body)
    const tsx = createRequire(import.meta.url).resolve('tsx/cli')
    const at = file.lastIndexOf('/src/')
    execFileSync(process.execPath, [tsx, script], {
      cwd: file.slice(0, at),
      env: { ...process.env, ...extraEnv },
      stdio: 'inherit',
      timeout: 120000,
    })
  } catch (err) {
    failed = err
  } finally {
    copyFileSync(backup, file)
    for (const path of [script, backup]) {
      try { unlinkSync(path) } catch { /* already removed */ }
    }
  }
  expect(readFileSync(file, 'utf8')).toBe(original)
  if (failed) throw failed
}
