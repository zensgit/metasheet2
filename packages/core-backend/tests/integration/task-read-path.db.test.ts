import '../helpers/assert-rbac-optional-off'
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import express from 'express'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { poolManager } from '../../src/integration/db/connection-pool'
import { execFileSync } from 'node:child_process'
import { copyFileSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { completeTask, countPending, createTask, listPending, listTasks } from '../../src/services/task-records'
import { tasksRouter } from '../../src/routes/tasks'
import { isOverdueOrToday, resolveViewerTimeZone } from '../../src/tasks/task-dates'
import { taskMatchesView, type TaskView } from '../../src/tasks/task-access'
import { orgMemberSeeds } from '../helpers/task-m4-fixtures'

if (process.env.EXPECT_DB !== '1') {
  throw new Error('task-read-path.db.test.ts requires EXPECT_DB=1')
}

const ORG_PREFIX = 'org_tasks_read_'

// RULED(2026-10-07): [N2] an assignee other than the creator must be an active member of the
// org (design §4.6), so a cell that names one seeds it here; the two afterAll hooks drop exactly
// those rows.
const orgMembers = orgMemberSeeds()

function ids(label: string): { orgId: string; creator: string; me: string; other: string } {
  const stamp = randomUUID()
  return {
    orgId: `${ORG_PREFIX}${label}_${stamp}`,
    creator: `usrC_${label}_${stamp}`,
    me: `usrM_${label}_${stamp}`,
    other: `usrO_${label}_${stamp}`,
  }
}

async function seedPastDue(taskId: string): Promise<void> {
  await poolManager.get().query(
    `UPDATE tasks
     SET due_date = ((now() AT TIME ZONE 'UTC')::date - 1),
         due_time = TIME '12:00',
         due_at = now() - interval '2 hours',
         time_zone = 'UTC'
     WHERE id = $1`,
    [taskId],
  )
}

describe('tasks read path', () => {
  afterAll(async () => {
    await poolManager.get().query('DELETE FROM tasks WHERE org_id LIKE $1', [`${ORG_PREFIX}%`])
    await orgMembers.drop()
  })

  it('gate 4 negative: a completed assignee stays in assigned and leaves pending and the overdue count', async () => {
    const { orgId, creator, me, other } = ids('g4neg')
    await orgMembers.seed(orgId, [me, other])
    const created = await createTask({
      orgId,
      creatorId: creator,
      title: '备料复核',
      assignees: [me, other],
      completionMode: 'all',
    })
    const counted = await poolManager.get().query<{ n: string }>(
      'SELECT count(*)::text AS n FROM task_assignees WHERE task_id = $1',
      [created.id],
    )
    expect(counted.rows[0]?.n).toBe('2')
    await seedPastDue(created.id)
    await completeTask({ orgId, actorId: me, taskId: created.id })

    const assigned = await listTasks({ orgId, actorId: me, view: 'assigned' })
    expect(assigned.map((row) => row.id)).toContain(created.id)
    const pending = await listPending({ orgId, actorId: me, viewerTz: null })
    expect(pending.map((row) => row.id)).not.toContain(created.id)
    expect(await countPending({ orgId, actorId: me, viewerTz: null })).toBe(0)
  })

  it('gate 4 positive: an overdue open assignment is pending and counts as 1', async () => {
    const { orgId, creator, me, other } = ids('g4pos')
    await orgMembers.seed(orgId, [me, other])
    const created = await createTask({
      orgId,
      creatorId: creator,
      title: '备料复核',
      assignees: [me, other],
      completionMode: 'all',
    })
    await seedPastDue(created.id)

    const pending = await listPending({ orgId, actorId: me, viewerTz: null })
    expect(pending.map((row) => row.id)).toEqual([created.id])
    expect(await countPending({ orgId, actorId: me, viewerTz: null })).toBe(1)
  })

  it('keeps an undated open assignment on the pending list and out of the overdue count', async () => {
    // Lock §13-4: /pending passes all_open; /pending-count uses default badge_scope overdue.
    // Gate 4's two cells are both already overdue, so they do not collapse those parameters.
    const { orgId, creator, me } = ids('split')
    await orgMembers.seed(orgId, [me])
    const created = await createTask({
      orgId,
      creatorId: creator,
      title: '备料复核',
      assignees: [me],
      completionMode: 'all',
    })

    const pending = await listPending({ orgId, actorId: me, viewerTz: null })
    expect(pending.map((row) => row.id)).toEqual([created.id])
    expect(await countPending({ orgId, actorId: me, viewerTz: null })).toBe(0)
  })

  it('gate 5: one all-day task has the same dueAt bytes for UTC+14 and UTC-11 viewers', async () => {
    const { orgId, creator, me } = ids('g5')
    await orgMembers.seed(orgId, [me])
    const created = await createTask({
      orgId,
      creatorId: creator,
      title: '备料复核',
      assignees: [me],
      completionMode: 'all',
    })
    await poolManager.get().query(
      `UPDATE tasks
       SET due_date = '2026-09-28', due_time = NULL, due_at = NULL, time_zone = 'Asia/Shanghai'
       WHERE id = $1`,
      [created.id],
    )
    const east = await listPending({ orgId, actorId: me, viewerTz: 'Pacific/Kiritimati' })
    const west = await listPending({ orgId, actorId: me, viewerTz: 'Pacific/Pago_Pago' })
    const eastItem = east.find((row) => row.id === created.id)
    const westItem = west.find((row) => row.id === created.id)
    expect(eastItem?.dueAt).toBe('2026-09-28T15:59:59.999Z')
    expect(westItem?.dueAt).toBe(eastItem?.dueAt)
    expect(eastItem && 'description' in eastItem).toBe(false)
  })

  it('gate 8: invalid and missing viewer zones fall back to the task zone, and a UTC fallback disagrees', () => {
    const now = new Date('2026-09-15T12:30:00.000Z')
    const task = { dueAt: new Date('2026-09-15T18:00:00.000Z'), dueDate: null, dueTime: '00:00', timeZone: 'Asia/Shanghai' }
    const explicit = isOverdueOrToday(task, now, 'Asia/Shanghai')
    expect(isOverdueOrToday(task, now, resolveViewerTimeZone('Not/AZone', 'Asia/Shanghai'))).toBe(explicit)
    expect(isOverdueOrToday(task, now, resolveViewerTimeZone(undefined, 'Asia/Shanghai'))).toBe(explicit)
    const utcFallback = isOverdueOrToday(task, now, 'UTC')
    expect(utcFallback).not.toBe(explicit)
  })

  it('gate 8 negative: changing the viewer fallback to UTC makes both cells disagree', () => {
    const dates = new URL('../../src/tasks/task-dates.ts', import.meta.url)
    const needle = 'return validateViewerTimeZoneHeader(headerValue) ?? taskTimeZone'
    runSourceMutant(dates.pathname, needle, "return validateViewerTimeZoneHeader(headerValue) ?? 'UTC'", `
      const { isOverdueOrToday, resolveViewerTimeZone } = await import(${JSON.stringify(dates.pathname)})
      const now = new Date('2026-09-15T12:30:00.000Z')
      const task = { dueAt: new Date('2026-09-15T18:00:00.000Z'), dueDate: null, dueTime: '00:00', timeZone: 'Asia/Shanghai' }
      const explicit = isOverdueOrToday(task, now, 'Asia/Shanghai')
      const invalid = isOverdueOrToday(task, now, resolveViewerTimeZone('Not/AZone', 'Asia/Shanghai'))
      const missing = isOverdueOrToday(task, now, resolveViewerTimeZone(undefined, 'Asia/Shanghai'))
      console.log(JSON.stringify({ gate8: 'red', explicit, invalid, missing }))
      if (invalid === explicit || missing === explicit) process.exit(1)
      process.exit(0)
    `)
  }, 180000)
})

const ACCESS = new URL('../../src/tasks/task-access.ts', import.meta.url)
const VIEWS = new Set(['assigned', 'following', 'created', 'delegated', 'any_role'])
const SUFFIXES = new Set(['noa', 'oa', 'of'])

function parseCell(name: string): { roles: string[]; view: TaskView; suffix: string } {
  const parts = name.split('|')
  let suffix = ''
  if (SUFFIXES.has(parts[parts.length - 1] ?? '')) suffix = parts.pop() ?? ''
  const view = parts.pop()
  if (!view || !VIEWS.has(view)) throw new Error(name)
  const raw = parts.slice(1).join('|')
  return { roles: raw === 'none' ? [] : raw.split('+'), view: view as TaskView, suffix }
}

describe('gate 19 view grid', () => {
  afterAll(async () => {
    await poolManager.get().query('DELETE FROM tasks WHERE org_id LIKE $1', ['org_g19_%'])
    await orgMembers.drop()
  })

  const cells = [
    'gate19|assignee+creator+follower|any_role',
    'gate19|assignee+creator+follower|assigned',
    'gate19|assignee+creator+follower|created',
    'gate19|assignee+creator+follower|delegated',
    'gate19|assignee+creator+follower|delegated|noa',
    'gate19|assignee+creator+follower|following',
    'gate19|assignee+creator|any_role',
    'gate19|assignee+creator|assigned',
    'gate19|assignee+creator|created',
    'gate19|assignee+creator|delegated',
    'gate19|assignee+creator|delegated|noa',
    'gate19|assignee+creator|following',
    'gate19|assignee+follower|any_role',
    'gate19|assignee+follower|assigned',
    'gate19|assignee+follower|created',
    'gate19|assignee+follower|delegated',
    'gate19|assignee+follower|following',
    'gate19|assignee|any_role',
    'gate19|assignee|assigned',
    'gate19|assignee|created',
    'gate19|assignee|delegated',
    'gate19|assignee|following',
    'gate19|creator+follower|any_role',
    'gate19|creator+follower|assigned',
    'gate19|creator+follower|created',
    'gate19|creator+follower|delegated',
    'gate19|creator+follower|delegated|noa',
    'gate19|creator+follower|following',
    'gate19|creator|any_role',
    'gate19|creator|any_role|noa',
    'gate19|creator|assigned',
    'gate19|creator|created',
    'gate19|creator|delegated',
    'gate19|creator|delegated|noa',
    'gate19|creator|following',
    'gate19|follower|any_role',
    'gate19|follower|assigned',
    'gate19|follower|created',
    'gate19|follower|delegated',
    'gate19|follower|following',
    'gate19|none|any_role',
    'gate19|none|any_role|oa',
    'gate19|none|assigned',
    'gate19|none|assigned|oa',
    'gate19|none|created',
    'gate19|none|delegated',
    'gate19|none|delegated|oa',
    'gate19|none|following',
    'gate19|none|following|of'
  ]

  // Gate 17② counts each array row of this it.each (49 names, no header).
  it.each(cells)('%s', async (name) => {
      const { roles, view, suffix } = parseCell(name)
      const stamp = randomUUID()
      const orgId = `org_g19_${stamp}`
      const me = `usrM_${stamp}`
      const other = `usrO_${stamp}`
      const createdByMe = roles.includes('creator')
      const meInAssignees = roles.includes('assignee')
      const meInFollowers = roles.includes('follower')
      let othersAssigned = (view === 'delegated' || view === 'any_role') && createdByMe
      if (suffix === 'noa') othersAssigned = false
      if (suffix === 'oa') othersAssigned = true
      const creator = createdByMe ? me : other
      const assignees: string[] = []
      if (meInAssignees) assignees.push(me)
      if (othersAssigned) assignees.push(createdByMe ? other : `usrA_${stamp}`)
      // [N2]: only the assignees the creator names besides themselves are looked up.
      const named = assignees.filter((userId) => userId !== creator)
      if (named.length > 0) await orgMembers.seed(orgId, named)
      const created = await createTask({
        orgId, creatorId: creator, title: '备料复核', assignees, completionMode: 'all',
      })
      const db = poolManager.get()
      if (meInFollowers) {
        await db.query('INSERT INTO task_followers (task_id, user_id) VALUES ($1, $2)', [created.id, me])
      }
      if (suffix === 'of') {
        await db.query('INSERT INTO task_followers (task_id, user_id) VALUES ($1, $2)', [created.id, `usrF_${stamp}`])
      }
      const expectRow = taskMatchesView({
        createdBy: creator,
        assigneeIds: assignees,
        followerIds: [...(meInFollowers ? [me] : []), ...(suffix === 'of' ? [`usrF_${stamp}`] : [])],
      }, me, view)
      const rows = await listTasks({ orgId, actorId: me, view })
      expect(rows.map((row) => row.id).includes(created.id)).toBe(expectRow)
  })
})

function packageRoot(file: string): string {
  const at = file.lastIndexOf('/src/')
  if (at < 0) throw new Error(`not a package source file: ${file}`)
  return file.slice(0, at)
}

function runSourceMutant(file: string, needle: string, replacement: string, body: string): void {
  const backup = `/tmp/task-mutant-${randomUUID()}.bak`
  const root = packageRoot(file)
  const script = `${root}/.task-probe-${randomUUID()}.mts`
  copyFileSync(file, backup)
  const original = readFileSync(file, 'utf8')
  expect(original.includes(needle)).toBe(true)
  let failed: unknown
  try {
    writeFileSync(file, original.replace(needle, replacement))
    writeFileSync(script, body)
    const tsx = createRequire(import.meta.url).resolve('tsx/cli')
    execFileSync(process.execPath, [tsx, script], {
      cwd: root, env: process.env, stdio: 'inherit', timeout: 120000,
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

function tasksApp(): express.Express {
  const router = tasksRouter()
  if (!router) throw new Error('probe HTTP requires TASKS_ENABLED=true')
  const server = express()
  server.use(express.json())
  server.use(router)
  return server
}

async function grantProbeActor(label: string): Promise<{
  orgId: string
  creator: string
  me: string
  roleId: string
  bearer: string
}> {
  const secret = process.env.JWT_SECRET
  if (!secret || secret.length < 32) throw new Error('probe HTTP requires JWT_SECRET')
  const stamp = randomUUID().replace(/-/g, '')
  const orgId = `org${label}${stamp}`
  const me = `usrM${label}${stamp}`
  const creator = `usrC${label}${stamp}`
  const roleId = `role${label}${stamp}`
  const db = poolManager.get()
  await db.query(
    `INSERT INTO permissions (code, name, description) VALUES
       ('tasks:read', 'Tasks Read', 'read'),
       ('tasks:write', 'Tasks Write', 'write')
     ON CONFLICT (code) DO NOTHING`,
  )
  await db.query('INSERT INTO roles (id, name) VALUES ($1, $2)', [roleId, roleId])
  await db.query(
    `INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, 'tasks:read'), ($1, 'tasks:write')`,
    [roleId],
  )
  await db.query(
    `INSERT INTO users (
       id, email, name, password_hash, role, permissions,
       is_active, activation_status, local_password_set, must_change_password
     ) VALUES ($1, $2, $3, 'x', 'user', '[]'::jsonb, TRUE, 'activated', TRUE, FALSE)`,
    [me, `${me}@probe.test`, label],
  )
  await db.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [me, roleId])
  await db.query('INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)', [me, orgId])
  await db.query(
    `INSERT INTO user_namespace_admissions (
       user_id, namespace, enabled, source, created_at, updated_at
     ) VALUES ($1, 'tasks', TRUE, 'test', now(), now())`,
    [me],
  )
  const bearer = jwt.sign({
    userId: me, sub: me, email: `${me}@probe.test`, role: 'user', roles: [roleId], tenantId: orgId,
  }, secret, { expiresIn: '1h' })
  return { orgId, creator, me, roleId, bearer }
}

async function dropProbeActor(actor: { orgId: string; me: string; roleId: string }): Promise<void> {
  const db = poolManager.get()
  await db.query('DELETE FROM tasks WHERE org_id = $1', [actor.orgId])
  await db.query('DELETE FROM user_namespace_admissions WHERE user_id = $1', [actor.me])
  await db.query('DELETE FROM user_roles WHERE user_id = $1', [actor.me])
  await db.query('DELETE FROM user_orgs WHERE user_id = $1', [actor.me])
  await db.query('DELETE FROM users WHERE id = $1', [actor.me])
  await db.query('DELETE FROM role_permissions WHERE role_id = $1', [actor.roleId])
  await db.query('DELETE FROM roles WHERE id = $1', [actor.roleId])
}

describe('gate 19 probes', () => {
  const file = ACCESS.pathname

  afterAll(() => {
    const live = readFileSync(file, 'utf8')
    expect(live.includes("return 'FALSE'")).toBe(false)
  })

  it('probe 1: replacing the assigned arm with FALSE drops assigned, pending, and the count', async () => {
    const actor = await grantProbeActor('p1g')
    try {
      const created = await createTask({
        orgId: actor.orgId, creatorId: actor.creator, title: '备料复核', assignees: [actor.me], completionMode: 'all',
      })
      await seedPastDue(created.id)
      const server = tasksApp()
      const assigned = await request(server).get('/api/tasks').query({ view: 'assigned' }).set('Authorization', `Bearer ${actor.bearer}`)
      const pending = await request(server).get('/api/tasks/pending').set('Authorization', `Bearer ${actor.bearer}`)
      const count = await request(server).get('/api/tasks/pending-count').set('Authorization', `Bearer ${actor.bearer}`)
      expect(assigned.status).toBe(200)
      expect(pending.status).toBe(200)
      expect(count.status).toBe(200)
      expect((assigned.body.items as { id: string }[]).map((row) => row.id)).toContain(created.id)
      expect((pending.body.items as { id: string }[]).map((row) => row.id)).toContain(created.id)
      expect(count.body).toEqual({ count: 1 })
    } finally {
      await dropProbeActor(actor)
    }

    const needle = "case 'assigned':\n      return `EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = tasks.id AND ta.user_id = ${ME_PLACEHOLDER})`"
    const routesFile = new URL('../../src/routes/tasks.ts', import.meta.url).pathname
    const poolFile = new URL('../../src/integration/db/connection-pool.ts', import.meta.url).pathname
    const recordsFile = new URL('../../src/services/task-records.ts', import.meta.url).pathname
    runSourceMutant(file, needle, "case 'assigned':\n      return 'FALSE'", `
      process.env.TASKS_ENABLED = 'true'
      const express = (await import('express')).default
      const jwt = (await import('jsonwebtoken')).default
      const request = (await import('supertest')).default
      const { tasksRouter } = await import(${JSON.stringify(routesFile)})
      const { poolManager } = await import(${JSON.stringify(poolFile)})
      const { createTask } = await import(${JSON.stringify(recordsFile)})
      const stamp = Date.now().toString()
      const orgId = 'orgp1' + stamp
      const me = 'usrMp1' + stamp
      const creator = 'usrCp1' + stamp
      const roleId = 'rolep1' + stamp
      const db = poolManager.get()
      await db.query("INSERT INTO permissions (code, name, description) VALUES ('tasks:read','Tasks Read','read'), ('tasks:write','Tasks Write','write') ON CONFLICT (code) DO NOTHING")
      await db.query('INSERT INTO roles (id, name) VALUES ($1, $2)', [roleId, roleId])
      await db.query("INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, 'tasks:read'), ($1, 'tasks:write')", [roleId])
      await db.query("INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, activation_status, local_password_set, must_change_password) VALUES ($1, $2, 'p1', 'x', 'user', '[]'::jsonb, TRUE, 'activated', TRUE, FALSE)", [me, me + '@probe.test'])
      await db.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [me, roleId])
      await db.query('INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)', [me, orgId])
      await db.query("INSERT INTO user_namespace_admissions (user_id, namespace, enabled, source, created_at, updated_at) VALUES ($1, 'tasks', TRUE, 'test', now(), now())", [me])
      const bearer = jwt.sign({ userId: me, sub: me, email: me + '@probe.test', role: 'user', roles: [roleId], tenantId: orgId }, process.env.JWT_SECRET, { expiresIn: '1h' })
      const created = await createTask({ orgId, creatorId: creator, title: '备料复核', assignees: [me], completionMode: 'all' })
      await db.query("UPDATE tasks SET due_at = now() - interval '2 hours', due_time = TIME '12:00', time_zone = 'UTC', due_date = (now() AT TIME ZONE 'UTC')::date - 1 WHERE id = $1", [created.id])
      const router = tasksRouter()
      if (!router) process.exit(2)
      const server = express()
      server.use(express.json())
      server.use(router)
      const assigned = await request(server).get('/api/tasks').query({ view: 'assigned' }).set('Authorization', 'Bearer ' + bearer)
      const pending = await request(server).get('/api/tasks/pending').set('Authorization', 'Bearer ' + bearer)
      const count = await request(server).get('/api/tasks/pending-count').set('Authorization', 'Bearer ' + bearer)
      const assignedIds = (assigned.body.items ?? []).map((row) => row.id)
      const pendingIds = (pending.body.items ?? []).map((row) => row.id)
      const assignedRed = assigned.status !== 200 || !assignedIds.includes(created.id)
      await db.query('DELETE FROM tasks WHERE org_id = $1', [orgId])
      await db.query('DELETE FROM user_namespace_admissions WHERE user_id = $1', [me])
      await db.query('DELETE FROM user_roles WHERE user_id = $1', [me])
      await db.query('DELETE FROM user_orgs WHERE user_id = $1', [me])
      await db.query('DELETE FROM users WHERE id = $1', [me])
      await db.query('DELETE FROM role_permissions WHERE role_id = $1', [roleId])
      await db.query('DELETE FROM roles WHERE id = $1', [roleId])
      console.log(JSON.stringify({ gate19probe1: 'red', assignedStatus: assigned.status, assignedRed, pendingHasRow: pendingIds.includes(created.id), count: count.body.count }))
      if (!assignedRed || pending.status !== 200 || pendingIds.includes(created.id) || count.status !== 200 || count.body.count !== 0) process.exit(1)
      process.exit(0)
    `)
  }, 180000)

  it('probe 2: flipping assignee complete makes complete fail and leaves the list row', async () => {
    const actor = await grantProbeActor('p2g')
    try {
      const created = await createTask({
        orgId: actor.orgId, creatorId: actor.creator, title: '备料复核', assignees: [actor.me], completionMode: 'all',
      })
      await seedPastDue(created.id)
      const server = tasksApp()
      const before = await request(server).get('/api/tasks/pending-count').set('Authorization', `Bearer ${actor.bearer}`)
      expect(before.body).toEqual({ count: 1 })
      const completed = await request(server)
        .post('/api/tasks/' + created.id + '/complete')
        .set('Authorization', `Bearer ${actor.bearer}`)
        .send({})
      expect(completed.status).toBe(200)
      expect(completed.body).toEqual({ done: true, version: 2 })
    } finally {
      await dropProbeActor(actor)
    }

    const needle = `  assignee: {
    view: true,
    edit: true,
    complete: true,`
    const routesFile = new URL('../../src/routes/tasks.ts', import.meta.url).pathname
    const poolFile = new URL('../../src/integration/db/connection-pool.ts', import.meta.url).pathname
    const recordsFile = new URL('../../src/services/task-records.ts', import.meta.url).pathname
    runSourceMutant(file, needle, needle.replace('complete: true', 'complete: false'), `
      process.env.TASKS_ENABLED = 'true'
      const express = (await import('express')).default
      const jwt = (await import('jsonwebtoken')).default
      const request = (await import('supertest')).default
      const { tasksRouter } = await import(${JSON.stringify(routesFile)})
      const { poolManager } = await import(${JSON.stringify(poolFile)})
      const { createTask } = await import(${JSON.stringify(recordsFile)})
      const stamp = Date.now().toString()
      const orgId = 'orgp2' + stamp
      const me = 'usrMp2' + stamp
      const creator = 'usrCp2' + stamp
      const roleId = 'rolep2' + stamp
      const db = poolManager.get()
      await db.query("INSERT INTO permissions (code, name, description) VALUES ('tasks:read','Tasks Read','read'), ('tasks:write','Tasks Write','write') ON CONFLICT (code) DO NOTHING")
      await db.query('INSERT INTO roles (id, name) VALUES ($1, $2)', [roleId, roleId])
      await db.query("INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, 'tasks:read'), ($1, 'tasks:write')", [roleId])
      await db.query("INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, activation_status, local_password_set, must_change_password) VALUES ($1, $2, 'p2', 'x', 'user', '[]'::jsonb, TRUE, 'activated', TRUE, FALSE)", [me, me + '@probe.test'])
      await db.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [me, roleId])
      await db.query('INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)', [me, orgId])
      await db.query("INSERT INTO user_namespace_admissions (user_id, namespace, enabled, source, created_at, updated_at) VALUES ($1, 'tasks', TRUE, 'test', now(), now())", [me])
      const bearer = jwt.sign({ userId: me, sub: me, email: me + '@probe.test', role: 'user', roles: [roleId], tenantId: orgId }, process.env.JWT_SECRET, { expiresIn: '1h' })
      const created = await createTask({ orgId, creatorId: creator, title: '备料复核', assignees: [me], completionMode: 'all' })
      await db.query("UPDATE tasks SET due_at = now() - interval '2 hours', due_time = TIME '12:00', time_zone = 'UTC', due_date = (now() AT TIME ZONE 'UTC')::date - 1 WHERE id = $1", [created.id])
      const router = tasksRouter()
      if (!router) process.exit(2)
      const server = express()
      server.use(express.json())
      server.use(router)
      const auth = { Authorization: 'Bearer ' + bearer }
      const completed = await request(server).post('/api/tasks/' + created.id + '/complete').set(auth).send({})
      const assigned = await request(server).get('/api/tasks').query({ view: 'assigned' }).set(auth)
      const pending = await request(server).get('/api/tasks/pending').set(auth)
      const count = await request(server).get('/api/tasks/pending-count').set(auth)
      const assignedIds = (assigned.body.items ?? []).map((row) => row.id)
      const pendingIds = (pending.body.items ?? []).map((row) => row.id)
      await db.query('DELETE FROM tasks WHERE org_id = $1', [orgId])
      await db.query('DELETE FROM user_namespace_admissions WHERE user_id = $1', [me])
      await db.query('DELETE FROM user_roles WHERE user_id = $1', [me])
      await db.query('DELETE FROM user_orgs WHERE user_id = $1', [me])
      await db.query('DELETE FROM users WHERE id = $1', [me])
      await db.query('DELETE FROM role_permissions WHERE role_id = $1', [roleId])
      await db.query('DELETE FROM roles WHERE id = $1', [roleId])
      console.log(JSON.stringify({ gate19probe2: 'red', status: completed.status, assigned: assignedIds.includes(created.id), pending: pendingIds.includes(created.id), count: count.body.count }))
      if (completed.status !== 404 || completed.body?.error?.code !== 'NOT_FOUND' || !assignedIds.includes(created.id) || !pendingIds.includes(created.id) || count.body.count !== 1) process.exit(1)
      process.exit(0)
    `)
  }, 180000)
})
