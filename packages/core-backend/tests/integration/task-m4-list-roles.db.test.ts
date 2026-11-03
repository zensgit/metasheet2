import '../helpers/assert-rbac-optional-off'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import type supertest from 'supertest'
import { poolManager } from '../../src/integration/db/connection-pool'
import { completeTask, createTask, listTasks } from '../../src/services/task-records'
import { setTaskParent } from '../../src/services/task-structure'
import { newTaskListId } from '../../src/services/task-ids-runtime'
import { can, resolveTaskRoles, taskMatchesView, type TaskView } from '../../src/tasks/task-access'
import { toTaskListMemberships, type TaskListMemberRole } from '../../src/tasks/task-lists'
import { dropTaskM4Fixtures, runSourceMutant, seedOrgMembers, seedTaskActor, signTaskToken, type SeededTaskActor } from '../helpers/task-m4-fixtures'
import { startTasksListener, tasksClient, type TasksClient, type TasksListener } from '../helpers/tasks-http-harness'

/**
 * M4 PR-3a S2 (design task-m4-pr3a-backend-design-20260930.md §6, §10.3, §10.4 task side).
 * RULED(2026-10-07): [R04] list identity (task_list_items + task_list_members) enters the
 * single-object role set and never a list-view arm. List, member and item rows are seeded with
 * SQL here; the list routes arrive in later slices.
 */

if (process.env.EXPECT_DB !== '1') {
  throw new Error('task-m4-list-roles.db.test.ts requires EXPECT_DB=1')
}

const ORG_PREFIX = 'org_tasks_m4roles_'
const seededUsers: string[] = []
const seededRoles: string[] = []

const req = createRequire(import.meta.url)
const EXPRESS_PATH = req.resolve('express')
const SUPERTEST_PATH = req.resolve('supertest')
const ACCESS_FILE = new URL('../../src/tasks/task-access.ts', import.meta.url).pathname
const ROUTES_FILE = new URL('../../src/routes/tasks.ts', import.meta.url).pathname
const RECORDS_FILE = new URL('../../src/services/task-records.ts', import.meta.url).pathname

function stampOf(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12)
}

function orgOf(label: string, stamp: string): string {
  return `${ORG_PREFIX}${label}_${stamp}`
}

async function actor(label: string, stamp: string, orgId: string): Promise<SeededTaskActor> {
  const seeded = await seedTaskActor({
    label, stamp, orgId, codes: ['tasks:read', 'tasks:write'], admission: true,
  })
  seededUsers.push(seeded.userId)
  seededRoles.push(seeded.roleId)
  return seeded
}

/** Users without a token who are written into a task: `users` + an active `user_orgs` row. */
async function orgUsers(orgId: string, userIds: string[]): Promise<void> {
  await seedOrgMembers(orgId, userIds)
  seededUsers.push(...userIds)
}

/** One list in `orgId` that contains `taskIds`, with `members` as (user, role) rows. */
async function seedList(
  orgId: string,
  createdBy: string,
  members: Array<[string, TaskListMemberRole]>,
  taskIds: string[],
): Promise<string> {
  const db = poolManager.get()
  const listId = newTaskListId()
  await db.query(
    `INSERT INTO task_lists (id, org_id, name, created_by) VALUES ($1, $2, $3, $4)`,
    [listId, orgId, '备料复核', createdBy],
  )
  for (const [userId, role] of members) {
    await db.query(`INSERT INTO task_list_members (list_id, user_id, role) VALUES ($1, $2, $3)`, [listId, userId, role])
  }
  for (const taskId of taskIds) {
    await db.query(`INSERT INTO task_list_items (list_id, task_id, org_id) VALUES ($1, $2, $3)`, [listId, taskId, orgId])
  }
  return listId
}

let listener: TasksListener | undefined

beforeAll(async () => {
  listener = await startTasksListener()
})

/** The file's one listener (tests/helpers/tasks-http-harness.ts): `Connection: close`, no keep-alive. */
function app(): TasksClient {
  return tasksClient(listener?.baseUrl ?? '')
}

function auth(who: SeededTaskActor): { Authorization: string } {
  return { Authorization: `Bearer ${who.bearer}` }
}

/** Task row, assignee rows, follower rows and event rows, for "nothing was written" assertions. */
async function snapshot(taskId: string): Promise<string> {
  const db = poolManager.get()
  const task = await db.query(
    `SELECT status, version, completed_at, completion_mode, deleted_at, updated_at FROM tasks WHERE id = $1`,
    [taskId],
  )
  const assignees = await db.query(
    `SELECT user_id, completed_at FROM task_assignees WHERE task_id = $1 ORDER BY user_id`,
    [taskId],
  )
  const followers = await db.query(
    `SELECT user_id FROM task_followers WHERE task_id = $1 ORDER BY user_id`,
    [taskId],
  )
  const events = await db.query(
    `SELECT id, event_type, actor_id FROM task_events WHERE task_id = $1 ORDER BY id`,
    [taskId],
  )
  return JSON.stringify({ task: task.rows, assignees: assignees.rows, followers: followers.rows, events: events.rows })
}

async function eventTypes(taskId: string): Promise<string[]> {
  const result = await poolManager.get().query(
    `SELECT event_type, actor_id FROM task_events WHERE task_id = $1 ORDER BY occurred_at, id`,
    [taskId],
  )
  return result.rows.map((row) => `${row.event_type}:${row.actor_id}`)
}

afterAll(async () => {
  await dropTaskM4Fixtures({ orgPrefix: ORG_PREFIX, userIds: seededUsers, roleIds: seededRoles })
  await listener?.close()
})

// ---------------------------------------------------------------------------------------------
// §10.3 i-m4 view grid (candidate cells, not scored: the i-m4 block lives in the design doc,
// ASSUMPTION(task-m4): [own-20]). Names use the `gate19m4|` prefix so the M2 extraction
// (`-t 'gate19[|]'`) never sees them.
// ---------------------------------------------------------------------------------------------

const GRID_VIEWS: readonly TaskView[] = ['assigned', 'following', 'created', 'delegated', 'any_role']

/** Expected row set per identity: the identity with its list role removed, per lock §6.1. */
const EXPECTED: Record<string, Record<TaskView, boolean>> = {
  'list-reader': { assigned: false, following: false, created: false, delegated: false, any_role: false },
  'list-editor': { assigned: false, following: false, created: false, delegated: false, any_role: false },
  'follower+list-reader': { assigned: false, following: true, created: false, delegated: false, any_role: true },
  'assignee+list-reader': { assigned: true, following: false, created: false, delegated: false, any_role: true },
  'creator+list-editor': { assigned: false, following: false, created: true, delegated: true, any_role: true },
}

describe('M4 list-role view grid (i-m4)', () => {
  const cells = [
    'gate19m4|assignee+list-reader|any_role',
    'gate19m4|assignee+list-reader|assigned',
    'gate19m4|assignee+list-reader|created',
    'gate19m4|assignee+list-reader|delegated',
    'gate19m4|assignee+list-reader|following',
    'gate19m4|creator+list-editor|any_role',
    'gate19m4|creator+list-editor|assigned',
    'gate19m4|creator+list-editor|created',
    'gate19m4|creator+list-editor|delegated',
    'gate19m4|creator+list-editor|following',
    'gate19m4|follower+list-reader|any_role',
    'gate19m4|follower+list-reader|assigned',
    'gate19m4|follower+list-reader|created',
    'gate19m4|follower+list-reader|delegated',
    'gate19m4|follower+list-reader|following',
    'gate19m4|list-editor|any_role',
    'gate19m4|list-editor|assigned',
    'gate19m4|list-editor|created',
    'gate19m4|list-editor|delegated',
    'gate19m4|list-editor|following',
    'gate19m4|list-reader|any_role',
    'gate19m4|list-reader|assigned',
    'gate19m4|list-reader|created',
    'gate19m4|list-reader|delegated',
    'gate19m4|list-reader|following',
  ]

  // Gate 17② counts each array row of this it.each (25 names, no header).
  it.each(cells)('%s', async (name) => {
    const [, identity, view] = name.split('|') as [string, string, TaskView]
    expect(GRID_VIEWS.includes(view)).toBe(true)
    const roles = identity.split('+')
    const stamp = stampOf()
    const orgId = orgOf('g19m4', stamp)
    const me = await actor('g19m4', stamp, orgId)
    const other = `usrO_g19m4_${stamp}`
    const createdByMe = roles.includes('creator')
    const meAssigned = roles.includes('assignee')
    const meFollowing = roles.includes('follower')
    const listRole: TaskListMemberRole = roles.includes('list-editor') ? 'edit' : 'read'
    // Lock §6.1 ambient fixture (same rule as the M2 grid): another assignee only where the
    // creator's delegated / any_role cell needs one.
    const othersAssigned = createdByMe && (view === 'delegated' || view === 'any_role')
    const creator = createdByMe ? me.userId : other
    const assignees = [...(meAssigned ? [me.userId] : []), ...(othersAssigned ? [other] : [])]
    // RULED(2026-10-07): [N2] the other assignee the creator names must be an active org member.
    if (othersAssigned) await orgUsers(orgId, [other])
    const created = await createTask({ orgId, creatorId: creator, title: '备料复核', assignees, completionMode: 'all' })
    if (meFollowing) {
      await poolManager.get().query('INSERT INTO task_followers (task_id, user_id) VALUES ($1, $2)', [created.id, me.userId])
    }
    const listId = await seedList(orgId, other, [[other, 'owner'], [me.userId, listRole]], [created.id])

    const row = { createdBy: creator, assigneeIds: assignees, followerIds: meFollowing ? [me.userId] : [] }
    const expected = EXPECTED[identity]?.[view]
    expect(typeof expected).toBe('boolean')
    expect(taskMatchesView(row, me.userId, view)).toBe(expected)
    const rows = await listTasks({ orgId, actorId: me.userId, view })
    expect(rows.map((entry) => entry.id).includes(created.id)).toBe(expected)

    // Positive control: the list identity does make the task visible as a single object.
    const memberships = toTaskListMemberships([{ listId, role: listRole }])
    expect(can(resolveTaskRoles(row, me.userId, memberships), 'view')).toBe(true)
    const detail = await app().get(`/api/tasks/${created.id}`).set(auth(me))
    expect(detail.status).toBe(200)
    expect(detail.body.id).toBe(created.id)
  })

  it('negative control 4: a list arm added to any_role puts a list-reader-only task into the view', async () => {
    const stamp = stampOf()
    const orgId = orgOf('nc4', stamp)
    const me = await actor('nc4', stamp, orgId)
    const other = `usrO_nc4_${stamp}`
    const created = await createTask({ orgId, creatorId: other, title: '备料复核', assignees: [], completionMode: 'all' })
    await seedList(orgId, other, [[other, 'owner'], [me.userId, 'read']], [created.id])
    const before = await listTasks({ orgId, actorId: me.userId, view: 'any_role' })
    expect(before.map((entry) => entry.id)).not.toContain(created.id)

    const listArm = "(EXISTS (SELECT 1 FROM task_list_items tli JOIN task_list_members tlm ON tlm.list_id = tli.list_id WHERE tli.task_id = tasks.id AND tlm.user_id = $1))"
    runSourceMutant(ACCESS_FILE, ".join(' OR ')", `.concat([${JSON.stringify(listArm)}]).join(' OR ')`, `
      const { listTasks } = await import(${JSON.stringify(RECORDS_FILE)})
      const rows = await listTasks({ orgId: ${JSON.stringify(orgId)}, actorId: ${JSON.stringify(me.userId)}, view: 'any_role' })
      const hit = rows.map((row) => row.id).includes(${JSON.stringify(created.id)})
      console.log(JSON.stringify({ nc4: 'red', hit }))
      process.exit(hit ? 0 : 1)
    `, {}, { unique: true })
  }, 180000)
})

// ---------------------------------------------------------------------------------------------
// §10.4 m4list task side: list identity in single-object abilities.
// ---------------------------------------------------------------------------------------------

describe('m4list task side', () => {
  it('m4list|list-reader|detail is 200 with view-only flags', async () => {
    const stamp = stampOf()
    const orgId = orgOf('lrdet', stamp)
    const reader = await actor('lrdet', stamp, orgId)
    const other = `usrO_lrdet_${stamp}`
    const created = await createTask({ orgId, creatorId: other, title: '备料复核', assignees: [other], completionMode: 'all' })
    await seedList(orgId, other, [[other, 'owner'], [reader.userId, 'read']], [created.id])
    const detail = await app().get(`/api/tasks/${created.id}`).set(auth(reader))
    expect(detail.status).toBe(200)
    expect({
      canComplete: detail.body.canComplete,
      canReopen: detail.body.canReopen,
      canEdit: detail.body.canEdit,
      canDelete: detail.body.canDelete,
      canComment: detail.body.canComment,
      canLeave: detail.body.canLeave,
    }).toEqual({ canComplete: false, canReopen: false, canEdit: false, canDelete: false, canComment: true, canLeave: false })
  })

  it('m4list|list-reader|complete, completion-mode and add-follower are the missing-id 404, nothing written', async () => {
    const stamp = stampOf()
    const orgId = orgOf('lrw', stamp)
    const reader = await actor('lrw', stamp, orgId)
    const other = `usrO_lrw_${stamp}`
    const created = await createTask({ orgId, creatorId: other, title: '备料复核', assignees: [other], completionMode: 'all' })
    await seedList(orgId, other, [[other, 'owner'], [reader.userId, 'read']], [created.id])
    const missing = `tsk_missing_${stamp}`
    const before = await snapshot(created.id)
    const server = app()
    const writes: Array<[string, string, object]> = [
      ['post', '/complete', {}],
      ['patch', '/completion-mode', { completionMode: 'any' }],
      ['post', '/followers', { userId: reader.userId }],
    ]
    for (const [method, suffix, body] of writes) {
      const call = (id: string) => (method === 'post'
        ? server.post(`/api/tasks/${id}${suffix}`)
        : server.patch(`/api/tasks/${id}${suffix}`)).set(auth(reader)).send(body)
      const real = await call(created.id)
      const absent = await call(missing)
      expect(real.status).toBe(404)
      expect(real.text).toBe(absent.text)
    }
    expect(await snapshot(created.id)).toBe(before)
    const followers = await poolManager.get().query('SELECT count(*)::int AS n FROM task_followers WHERE task_id = $1', [created.id])
    expect(followers.rows[0].n).toBe(0)
  })

  it('m4list|list-reader|comment is 200', async () => {
    const stamp = stampOf()
    const orgId = orgOf('lrcom', stamp)
    const reader = await actor('lrcom', stamp, orgId)
    const other = `usrO_lrcom_${stamp}`
    const created = await createTask({ orgId, creatorId: other, title: '备料复核', assignees: [other], completionMode: 'all' })
    await seedList(orgId, other, [[other, 'owner'], [reader.userId, 'read']], [created.id])
    const posted = await app().post(`/api/tasks/${created.id}/comments`).set(auth(reader)).send({ body: '备料' })
    expect(posted.status).toBe(200)
    expect(posted.body.authorId).toBe(reader.userId)
    const listed = await app().get(`/api/tasks/${created.id}/comments`).set(auth(reader))
    expect(listed.status).toBe(200)
    expect(listed.body.total).toBe(1)
  })

  it('m4list|list-editor|complete in any mode stamps the other assignee and writes one completed_by_any', async () => {
    const stamp = stampOf()
    const orgId = orgOf('leany', stamp)
    const editor = await actor('leany', stamp, orgId)
    const other = `usrO_leany_${stamp}`
    const created = await createTask({ orgId, creatorId: other, title: '备料复核', assignees: [other], completionMode: 'any' })
    await seedList(orgId, other, [[other, 'owner'], [editor.userId, 'edit']], [created.id])
    const db = poolManager.get()
    // Fixture mode pinned: `any`, one open assignee row that is not the list-editor's.
    const fixture = await db.query(`SELECT completion_mode, status FROM tasks WHERE id = $1`, [created.id])
    expect(fixture.rows[0]).toEqual({ completion_mode: 'any', status: 'open' })
    const response = await app().post(`/api/tasks/${created.id}/complete`).set(auth(editor)).send({})
    expect(response.status).toBe(200)
    expect(response.body.done).toBe(true)
    const task = await db.query(`SELECT status FROM tasks WHERE id = $1`, [created.id])
    expect(task.rows[0].status).toBe('done')
    const rows = await db.query(`SELECT user_id, completed_at FROM task_assignees WHERE task_id = $1`, [created.id])
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0].user_id).toBe(other)
    expect(rows.rows[0].completed_at).not.toBeNull()
    expect(await eventTypes(created.id)).toEqual([`created:${other}`, `completed_by_any:${editor.userId}`])
  })

  it('m4list|list-editor|complete in all mode without an own row is the no-op 200', async () => {
    const stamp = stampOf()
    const orgId = orgOf('leall', stamp)
    const editor = await actor('leall', stamp, orgId)
    const other = `usrO_leall_${stamp}`
    const created = await createTask({ orgId, creatorId: other, title: '备料复核', assignees: [other], completionMode: 'all' })
    await seedList(orgId, other, [[other, 'owner'], [editor.userId, 'edit']], [created.id])
    const fixture = await poolManager.get().query(`SELECT completion_mode FROM tasks WHERE id = $1`, [created.id])
    expect(fixture.rows[0].completion_mode).toBe('all')
    const before = await snapshot(created.id)
    const response = await app().post(`/api/tasks/${created.id}/complete`).set(auth(editor)).send({})
    expect(response.status).toBe(200)
    expect(response.body.done).toBe(false)
    expect(await snapshot(created.id)).toBe(before)
  })

  it('m4list|list-editor|complete on a zero-assignee task is the missing-id 404, not 500; canComplete is false', async () => {
    const stamp = stampOf()
    const orgId = orgOf('lez', stamp)
    const editor = await actor('lez', stamp, orgId)
    const other = `usrO_lez_${stamp}`
    const created = await createTask({ orgId, creatorId: other, title: '备料复核', assignees: [], completionMode: 'all' })
    await seedList(orgId, other, [[other, 'owner'], [editor.userId, 'edit']], [created.id])
    const before = await snapshot(created.id)
    const response = await app().post(`/api/tasks/${created.id}/complete`).set(auth(editor)).send({})
    const absent = await app().post(`/api/tasks/tsk_missing_${stamp}/complete`).set(auth(editor)).send({})
    expect(response.status).toBe(404)
    expect(response.text).toBe(absent.text)
    expect(await snapshot(created.id)).toBe(before)
    const detail = await app().get(`/api/tasks/${created.id}`).set(auth(editor))
    expect(detail.status).toBe(200)
    expect(detail.body.canEdit).toBe(true)
    expect(detail.body.canComplete).toBe(false)
    expect(detail.body.canReopen).toBe(false)
  })

  it('m4list|list-editor|reopen on a done zero-assignee task is the missing-id 404, not 500; canReopen is false', async () => {
    const stamp = stampOf()
    const orgId = orgOf('lezr', stamp)
    const editor = await actor('lezr', stamp, orgId)
    const other = `usrO_lezr_${stamp}`
    const created = await createTask({ orgId, creatorId: other, title: '备料复核', assignees: [], completionMode: 'all' })
    expect(await completeTask({ orgId, actorId: other, taskId: created.id })).toEqual({ done: true, version: 2 })
    await seedList(orgId, other, [[other, 'owner'], [editor.userId, 'edit']], [created.id])
    const before = await snapshot(created.id)
    const response = await app().post(`/api/tasks/${created.id}/reopen`).set(auth(editor)).send({ scope: 'all' })
    const absent = await app().post(`/api/tasks/tsk_missing_${stamp}/reopen`).set(auth(editor)).send({ scope: 'all' })
    expect(response.status).toBe(404)
    expect(response.text).toBe(absent.text)
    expect(await snapshot(created.id)).toBe(before)
    const task = await poolManager.get().query(`SELECT status FROM tasks WHERE id = $1`, [created.id])
    expect(task.rows[0].status).toBe('done')
    const detail = await app().get(`/api/tasks/${created.id}`).set(auth(editor))
    expect(detail.body.canReopen).toBe(false)
  })

  it('m4list|creator|complete on a zero-assignee task is 200 with one completed event (positive control)', async () => {
    const stamp = stampOf()
    const orgId = orgOf('crz', stamp)
    const creator = await actor('crz', stamp, orgId)
    const created = await createTask({ orgId, creatorId: creator.userId, title: '备料复核', assignees: [], completionMode: 'all' })
    await seedList(orgId, creator.userId, [[creator.userId, 'owner']], [created.id])
    const detail = await app().get(`/api/tasks/${created.id}`).set(auth(creator))
    expect(detail.body.canComplete).toBe(true)
    const response = await app().post(`/api/tasks/${created.id}/complete`).set(auth(creator)).send({})
    expect(response.status).toBe(200)
    expect(response.body.done).toBe(true)
    expect(await eventTypes(created.id)).toEqual([`created:${creator.userId}`, `completed:${creator.userId}`])
  })

  it('m4list|list-editor|delete is the missing-id 404 and the task stays live', async () => {
    const stamp = stampOf()
    const orgId = orgOf('ledel', stamp)
    const editor = await actor('ledel', stamp, orgId)
    const other = `usrO_ledel_${stamp}`
    const created = await createTask({ orgId, creatorId: other, title: '备料复核', assignees: [other], completionMode: 'all' })
    await seedList(orgId, other, [[other, 'owner'], [editor.userId, 'edit']], [created.id])
    const before = await snapshot(created.id)
    const response = await app().delete(`/api/tasks/${created.id}`).set(auth(editor))
    const absent = await app().delete(`/api/tasks/tsk_missing_${stamp}`).set(auth(editor))
    expect(response.status).toBe(404)
    expect(response.text).toBe(absent.text)
    expect(await snapshot(created.id)).toBe(before)
  })

  // RULED(2026-10-07): [own-53]: adding or removing an assignee or a follower takes a
  // direct role on the task (creator or assignee). List identity keeps the other `edit` writes.
  it('m4list|list-editor|assignee and follower changes require a direct role: the four member writes are the missing-id 404 for a list-only editor and for a follower who edits through a list, whatever the body or path user id, nothing written; the same editor still PATCHes, sets the parent, switches the completion mode, comments and completes; leaving as a follower is unchanged', async () => {
    const stamp = stampOf()
    const orgId = orgOf('leedit', stamp)
    const editor = await actor('leedit', stamp, orgId)
    const both = await actor('leeditf', stamp, orgId)
    const other = `usrO_leedit_${stamp}`
    const watcher = `usrW_leedit_${stamp}`
    const newcomer = `usrN_leedit_${stamp}`
    await orgUsers(orgId, [other, watcher, newcomer])
    const parent = await createTask({ orgId, creatorId: other, title: '备料父', assignees: [other], completionMode: 'all' })
    const created = await createTask({ orgId, creatorId: other, title: '备料复核', assignees: [other], completionMode: 'all' })
    for (const userId of [watcher, both.userId]) {
      await poolManager.get().query('INSERT INTO task_followers (task_id, user_id) VALUES ($1, $2)', [created.id, userId])
    }
    await seedList(orgId, other, [[other, 'owner'], [editor.userId, 'edit'], [both.userId, 'edit']], [parent.id, created.id])
    const server = app()
    for (const who of [editor, both]) {
      const detail = await server.get(`/api/tasks/${created.id}`).set(auth(who))
      expect(detail.status, who.userId).toBe(200)
      expect([detail.body.canEdit, detail.body.canManageMembers], who.userId).toEqual([true, false])
    }
    const before = await snapshot(created.id)
    const missing = `tsk_missing_${stamp}`
    for (const who of [editor, both]) {
      const writes: Array<[string, (id: string) => supertest.Test]> = [
        ['add assignee: the caller', (id) => server.post(`/api/tasks/${id}/assignees`).set(auth(who)).send({ userId: who.userId })],
        ['add assignee: another user', (id) => server.post(`/api/tasks/${id}/assignees`).set(auth(who)).send({ userId: newcomer })],
        ['add assignee: invalid userId', (id) => server.post(`/api/tasks/${id}/assignees`).set(auth(who)).send({ userId: 'usr x' })],
        ['add assignee: empty body', (id) => server.post(`/api/tasks/${id}/assignees`).set(auth(who)).send({})],
        ['remove assignee: an assignee', (id) => server.delete(`/api/tasks/${id}/assignees/${other}`).set(auth(who))],
        ['remove assignee: invalid path id', (id) => server.delete(`/api/tasks/${id}/assignees/usr%20x`).set(auth(who))],
        ['add follower: the caller', (id) => server.post(`/api/tasks/${id}/followers`).set(auth(who)).send({ userId: who.userId })],
        ['add follower: another user', (id) => server.post(`/api/tasks/${id}/followers`).set(auth(who)).send({ userId: newcomer })],
        ['add follower: invalid userId', (id) => server.post(`/api/tasks/${id}/followers`).set(auth(who)).send({ userId: 7 })],
        ['remove follower: a follower', (id) => server.delete(`/api/tasks/${id}/followers/${watcher}`).set(auth(who))],
        ['remove follower: the caller', (id) => server.delete(`/api/tasks/${id}/followers/${who.userId}`).set(auth(who))],
        ['remove follower: invalid path id', (id) => server.delete(`/api/tasks/${id}/followers/usr%20x`).set(auth(who))],
      ]
      for (const [label, call] of writes) {
        const real = await call(created.id)
        const absent = await call(missing)
        expect(real.status, `${who.userId} ${label}`).toBe(404)
        expect(real.text, `${who.userId} ${label}`).toBe(absent.text)
      }
    }
    expect(await snapshot(created.id)).toBe(before)

    // A follower leaves through `leave`, its own ability.
    const left = await server.post(`/api/tasks/${created.id}/leave`).set(auth(both)).send({})
    expect(left.status).toBe(200)
    expect(left.body.followers).toEqual([watcher])

    // The other `edit` writes stay open to the list-only editor.
    const patched = await server.patch(`/api/tasks/${created.id}`).set(auth(editor)).send({ expectedVersion: 1, title: '备料复核(改)' })
    expect(patched.status).toBe(200)
    expect(patched.body).toEqual({ id: created.id, version: 2 })
    const mode = await server.patch(`/api/tasks/${created.id}/completion-mode`).set(auth(editor)).send({ completionMode: 'any' })
    expect(mode.status).toBe(200)
    expect(mode.body.completionMode).toBe('any')
    const reparented = await server.patch(`/api/tasks/${created.id}/parent`).set(auth(editor)).send({ parentId: parent.id })
    expect(reparented.status).toBe(200)
    expect(reparented.body.parentId).toBe(parent.id)
    const commented = await server.post(`/api/tasks/${created.id}/comments`).set(auth(editor)).send({ body: '备料' })
    expect(commented.status).toBe(200)
    // `any` mode with another user's open assignee row: a real completion, not the all-mode no-op.
    const completed = await server.post(`/api/tasks/${created.id}/complete`).set(auth(editor)).send({})
    expect(completed.status).toBe(200)
    expect(completed.body.done).toBe(true)
    const db = poolManager.get()
    const assignees = await db.query(`SELECT user_id, completed_at IS NOT NULL AS done FROM task_assignees WHERE task_id = $1`, [created.id])
    expect(assignees.rows).toEqual([{ user_id: other, done: true }])
    const followers = await db.query(`SELECT user_id FROM task_followers WHERE task_id = $1`, [created.id])
    expect(followers.rows).toEqual([{ user_id: watcher }])
    expect((await eventTypes(created.id)).sort()).toEqual([
      `created:${other}`,
      `left:${both.userId}`,
      `title_changed:${editor.userId}`,
      `completion_mode_changed:${editor.userId}`,
      `parent_set:${editor.userId}`,
      `commented:${editor.userId}`,
      `completed_by_any:${editor.userId}`,
    ].sort())
  })

  it('m4list|direct roles|assignee and follower changes require a direct role: the creator and an assignee add and remove assignees and followers; canManageMembers is true for them and false for a follower and a list-only editor', async () => {
    const stamp = stampOf()
    const orgId = orgOf('dirmem', stamp)
    const creator = await actor('dirmemc', stamp, orgId)
    const assignee = await actor('dirmema', stamp, orgId)
    const follower = await actor('dirmemf', stamp, orgId)
    const editor = await actor('dirmeme', stamp, orgId)
    const targets = [`usrX_dirmem_${stamp}`, `usrY_dirmem_${stamp}`]
    await orgUsers(orgId, targets)
    const created = await createTask({ orgId, creatorId: creator.userId, title: '备料复核', assignees: [assignee.userId], completionMode: 'all' })
    await poolManager.get().query('INSERT INTO task_followers (task_id, user_id) VALUES ($1, $2)', [created.id, follower.userId])
    // The creator also owns a list holding the task; the editor holds it only through that list.
    await seedList(orgId, creator.userId, [[creator.userId, 'owner'], [editor.userId, 'edit']], [created.id])
    const server = app()
    for (const [who, expected] of [[creator, true], [assignee, true], [follower, false], [editor, false]] as const) {
      const detail = await server.get(`/api/tasks/${created.id}`).set(auth(who))
      expect(detail.status, who.userId).toBe(200)
      expect(detail.body.canManageMembers, who.userId).toBe(expected)
    }
    for (const [who, target] of [[creator, targets[0]], [assignee, targets[1]]] as const) {
      const invalid = await server.post(`/api/tasks/${created.id}/assignees`).set(auth(who)).send({ userId: 'usr x' })
      expect(invalid.status, who.userId).toBe(422)
      expect(invalid.body).toEqual({ error: { code: 'INVALID_ASSIGNEES' } })
      const addAssignee = await server.post(`/api/tasks/${created.id}/assignees`).set(auth(who)).send({ userId: target })
      expect(addAssignee.status, who.userId).toBe(200)
      expect(addAssignee.body.assignees.map((row: { userId: string }) => row.userId)).toEqual([assignee.userId, target].sort())
      const removeAssignee = await server.delete(`/api/tasks/${created.id}/assignees/${target}`).set(auth(who))
      expect(removeAssignee.status, who.userId).toBe(200)
      expect(removeAssignee.body.assignees.map((row: { userId: string }) => row.userId)).toEqual([assignee.userId])
      const addFollower = await server.post(`/api/tasks/${created.id}/followers`).set(auth(who)).send({ userId: target })
      expect(addFollower.status, who.userId).toBe(200)
      expect([...addFollower.body.followers].sort()).toEqual([follower.userId, target].sort())
      const removeFollower = await server.delete(`/api/tasks/${created.id}/followers/${target}`).set(auth(who))
      expect(removeFollower.status, who.userId).toBe(200)
      expect(removeFollower.body.followers).toEqual([follower.userId])
    }
    const memberEvents = (await eventTypes(created.id)).filter((entry) => /^(assignee|follower)_/.test(entry))
    expect(memberEvents.sort()).toEqual([
      `assignee_added:${creator.userId}`, `assignee_removed:${creator.userId}`, `follower_added:${creator.userId}`, `follower_removed:${creator.userId}`,
      `assignee_added:${assignee.userId}`, `assignee_removed:${assignee.userId}`, `follower_added:${assignee.userId}`, `follower_removed:${assignee.userId}`,
    ].sort())
  })

  // PATCH /api/tasks/:id (S4, design §10.4 task side): list identity and the `edit` ability.
  it('m4list|list-editor|PATCH is 200: version + 1, one title_changed with the editor as actor', async () => {
    const stamp = stampOf()
    const orgId = orgOf('lepatch', stamp)
    const editor = await actor('lepatch', stamp, orgId)
    const other = `usrO_lepatch_${stamp}`
    const created = await createTask({ orgId, creatorId: other, title: '备料复核', assignees: [other], completionMode: 'all' })
    await seedList(orgId, other, [[other, 'owner'], [editor.userId, 'edit']], [created.id])
    const response = await app().patch(`/api/tasks/${created.id}`).set(auth(editor)).send({ expectedVersion: 1, title: '备料复核(改)' })
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ id: created.id, version: 2 })
    const task = await poolManager.get().query(`SELECT title, version FROM tasks WHERE id = $1`, [created.id])
    expect(task.rows[0]).toEqual({ title: '备料复核(改)', version: 2 })
    expect(await eventTypes(created.id)).toEqual([`created:${other}`, `title_changed:${editor.userId}`])
  })

  it('m4list|list-reader|PATCH is the missing-id 404 for a valid, a stale and an invalid body; nothing written', async () => {
    const stamp = stampOf()
    const orgId = orgOf('lrpatch', stamp)
    const reader = await actor('lrpatch', stamp, orgId)
    const other = `usrO_lrpatch_${stamp}`
    const created = await createTask({ orgId, creatorId: other, title: '备料复核', assignees: [other], completionMode: 'all' })
    await seedList(orgId, other, [[other, 'owner'], [reader.userId, 'read']], [created.id])
    const before = await snapshot(created.id)
    const server = app()
    for (const body of [{ expectedVersion: 1, title: '备料复核(改)' }, { expectedVersion: 7, title: '备料复核(改)' }, { title: null }]) {
      const response = await server.patch(`/api/tasks/${created.id}`).set(auth(reader)).send(body)
      const absent = await server.patch(`/api/tasks/tsk_missing_${stamp}`).set(auth(reader)).send(body)
      expect(response.status, JSON.stringify(body)).toBe(404)
      expect(response.text).toBe(absent.text)
    }
    expect(await snapshot(created.id)).toBe(before)
    const detail = await server.get(`/api/tasks/${created.id}`).set(auth(reader))
    expect(detail.status).toBe(200)
    expect(detail.body.canEdit).toBe(false)
  })

  // RULED(2026-10-07): [R08] a follower who is also a list reader has no `edit`.
  it('m4list|follower+list-reader|PATCH is the missing-id 404; nothing written', async () => {
    const stamp = stampOf()
    const orgId = orgOf('flrpatch', stamp)
    const both = await actor('flrpatch', stamp, orgId)
    const other = `usrO_flrpatch_${stamp}`
    const created = await createTask({ orgId, creatorId: other, title: '备料复核', assignees: [other], completionMode: 'all' })
    await poolManager.get().query(`INSERT INTO task_followers (task_id, user_id) VALUES ($1, $2)`, [created.id, both.userId])
    await seedList(orgId, other, [[other, 'owner'], [both.userId, 'read']], [created.id])
    const before = await snapshot(created.id)
    const server = app()
    const response = await server.patch(`/api/tasks/${created.id}`).set(auth(both)).send({ expectedVersion: 1, title: '备料复核(改)' })
    const absent = await server.patch(`/api/tasks/tsk_missing_${stamp}`).set(auth(both)).send({ expectedVersion: 1, title: '备料复核(改)' })
    expect(response.status).toBe(404)
    expect(response.text).toBe(absent.text)
    expect(await snapshot(created.id)).toBe(before)
    const detail = await server.get(`/api/tasks/${created.id}`).set(auth(both))
    expect(detail.status).toBe(200)
    expect(detail.body.canEdit).toBe(false)
  })

  it('m4list|list-editor|parent candidates, reparent and children see same-list tasks', async () => {
    const stamp = stampOf()
    const orgId = orgOf('letree', stamp)
    const editor = await actor('letree', stamp, orgId)
    const outsider = await actor('letreeo', stamp, orgId)
    const other = `usrO_letree_${stamp}`
    const parent = await createTask({ orgId, creatorId: other, title: '备料父', assignees: [other], completionMode: 'all' })
    const child = await createTask({ orgId, creatorId: other, title: '备料子', assignees: [other], completionMode: 'all' })
    // Same org, outside the list, no direct role for the editor: not a candidate (M4G1T-05).
    const outside = await createTask({ orgId, creatorId: other, title: '备料外', assignees: [other], completionMode: 'all' })
    await seedList(orgId, other, [[other, 'owner'], [editor.userId, 'edit']], [parent.id, child.id])
    const server = app()

    const candidates = await server.get(`/api/tasks/${child.id}/parent-candidates`).set(auth(editor))
    expect(candidates.status).toBe(200)
    const candidateIds = (candidates.body.items as { id: string }[]).map((item) => item.id)
    expect(candidateIds).toContain(parent.id)
    expect(candidateIds).not.toContain(outside.id)
    const outsiderCandidates = await server.get(`/api/tasks/${child.id}/parent-candidates`).set(auth(outsider))
    expect(outsiderCandidates.status).toBe(404)

    const reparent = await server.patch(`/api/tasks/${child.id}/parent`).set(auth(editor)).send({ parentId: parent.id })
    expect(reparent.status).toBe(200)
    expect(reparent.body.parentId).toBe(parent.id)

    const detail = await server.get(`/api/tasks/${parent.id}`).set(auth(editor))
    expect(detail.status).toBe(200)
    expect((detail.body.children as { id: string }[]).map((entry) => entry.id)).toEqual([child.id])
  })

  it('m4list|removed-member|detail is 404 on the next request', async () => {
    const stamp = stampOf()
    const orgId = orgOf('rm', stamp)
    const reader = await actor('rm', stamp, orgId)
    const other = `usrO_rm_${stamp}`
    const created = await createTask({ orgId, creatorId: other, title: '备料复核', assignees: [other], completionMode: 'all' })
    const listId = await seedList(orgId, other, [[other, 'owner'], [reader.userId, 'read']], [created.id])
    const server = app()
    expect((await server.get(`/api/tasks/${created.id}`).set(auth(reader))).status).toBe(200)
    await poolManager.get().query('DELETE FROM task_list_members WHERE list_id = $1 AND user_id = $2', [listId, reader.userId])
    const after = await server.get(`/api/tasks/${created.id}`).set(auth(reader))
    const absent = await server.get(`/api/tasks/tsk_missing_${stamp}`).set(auth(reader))
    expect(after.status).toBe(404)
    expect(after.text).toBe(absent.text)
  })

  it('m4list|non-member|detail, complete, comment and delete are each the missing-id 404, while the caller edits another list of the org', async () => {
    const stamp = stampOf()
    const orgId = orgOf('nm', stamp)
    const stranger = await actor('nm', stamp, orgId)
    const other = `usrO_nm_${stamp}`
    const created = await createTask({ orgId, creatorId: other, title: '备料复核', assignees: [other], completionMode: 'any' })
    // The task is in a list with members, just not this caller.
    await seedList(orgId, other, [[other, 'owner'], [`usrE_nm_${stamp}`, 'edit'], [`usrR_nm_${stamp}`, 'read']], [created.id])
    // The caller is an `edit` member of another list of the same org, which holds another task (M4G1T-02).
    const elsewhere = await createTask({ orgId, creatorId: other, title: '备料别处', assignees: [other], completionMode: 'any' })
    await seedList(orgId, other, [[other, 'owner'], [stranger.userId, 'edit']], [elsewhere.id])
    expect((await app().get(`/api/tasks/${elsewhere.id}`).set(auth(stranger))).status).toBe(200)
    const before = await snapshot(created.id)
    const server = app()
    const missing = `tsk_missing_${stamp}`
    const calls: Array<(id: string) => supertest.Test> = [
      (id) => server.get(`/api/tasks/${id}`).set(auth(stranger)),
      (id) => server.post(`/api/tasks/${id}/complete`).set(auth(stranger)).send({}),
      (id) => server.post(`/api/tasks/${id}/comments`).set(auth(stranger)).send({ body: '备料' }),
      (id) => server.get(`/api/tasks/${id}/comments`).set(auth(stranger)),
      (id) => server.delete(`/api/tasks/${id}`).set(auth(stranger)),
    ]
    for (const call of calls) {
      const real = await call(created.id)
      const absent = await call(missing)
      expect(real.status).toBe(404)
      expect(real.text).toBe(absent.text)
    }
    expect(await snapshot(created.id)).toBe(before)
    const listed = await listTasks({ orgId, actorId: stranger.userId, view: 'any_role' })
    expect(listed).toEqual([])
  })

  // M4G1T-01: list identity enters single-object abilities only, never a view, /pending or the badge.
  it('m4list|list-only identities stay out of the view totals, /pending and the badge; an assignee who also reads the list is counted', async () => {
    const stamp = stampOf()
    const orgId = orgOf('lpend', stamp)
    const reader = await actor('lpendr', stamp, orgId)
    const editor = await actor('lpende', stamp, orgId)
    const both = await actor('lpendb', stamp, orgId)
    const other = `usrO_lpend_${stamp}`
    const due = String((await poolManager.get().query(`SELECT ((now() AT TIME ZONE 'UTC')::date - 3)::text AS d`)).rows[0].d)
    const created = await createTask({
      orgId, creatorId: other, title: '逾期备料', assignees: [other, both.userId], completionMode: 'all', dueDate: due, timeZone: 'UTC',
    })
    await seedList(orgId, other, [[other, 'owner'], [reader.userId, 'read'], [editor.userId, 'edit'], [both.userId, 'read']], [created.id])
    for (const [who, expected] of [[reader, 0], [editor, 0], [both, 1]] as const) {
      const ids = expected === 1 ? [created.id] : []
      const anyRole = await app().get('/api/tasks').query({ view: 'any_role' }).set(auth(who))
      expect(anyRole.body.items.map((row: { id: string }) => row.id), who.userId).toEqual(ids)
      expect(anyRole.body.total, who.userId).toBe(expected)
      const pending = await app().get('/api/tasks/pending').set(auth(who))
      expect(pending.body.items.map((row: { id: string }) => row.id), who.userId).toEqual(ids)
      expect(pending.body.total, who.userId).toBe(expected)
      const badge = await app().get('/api/tasks/pending-count').set(auth(who)).set('x-viewer-time-zone', 'UTC')
      expect(badge.body, who.userId).toEqual({ count: expected })
      expect((await app().get(`/api/tasks/${created.id}`).set(auth(who))).status, who.userId).toBe(200)
    }
  })

  // M4G1T-08 (P09): a list-reader of both parent and child sees the child.
  it('m4list|list-reader|the children of a parent include a same-list child', async () => {
    const stamp = stampOf()
    const orgId = orgOf('lrkid', stamp)
    const reader = await actor('lrkid', stamp, orgId)
    const other = `usrO_lrkid_${stamp}`
    const parent = await createTask({ orgId, creatorId: other, title: '备料父', assignees: [other], completionMode: 'all' })
    const child = await createTask({ orgId, creatorId: other, title: '备料子', assignees: [other], completionMode: 'all' })
    await setTaskParent({ orgId, actorId: other, taskId: child.id, body: { parentId: parent.id } })
    await seedList(orgId, other, [[other, 'owner'], [reader.userId, 'read']], [parent.id, child.id])
    const detail = await app().get(`/api/tasks/${parent.id}`).set(auth(reader))
    expect(detail.status).toBe(200)
    expect((detail.body.children as { id: string }[]).map((entry) => entry.id)).toEqual([child.id])
  })

  // M4G1T-08 (P10): the owner row is a list-editor identity too.
  it('m4list|list owner|a member whose only role is the list owner row edits a list task (completion-mode 200)', async () => {
    const stamp = stampOf()
    const orgId = orgOf('lown', stamp)
    const owner = await actor('lown', stamp, orgId)
    const other = `usrO_lown_${stamp}`
    const created = await createTask({ orgId, creatorId: other, title: '备料复核', assignees: [other], completionMode: 'all' })
    await seedList(orgId, other, [[owner.userId, 'owner']], [created.id])
    const mode = await app().patch(`/api/tasks/${created.id}/completion-mode`).set(auth(owner)).send({ completionMode: 'any' })
    expect(mode.status).toBe(200)
    expect(mode.body.completionMode).toBe('any')
  })

  // M4G1T-08 (P11): the list identities of one task are a union. Two users hold `read` and `edit` on
  // the same two lists with the roles swapped: whatever order the two lists come back in, one of the
  // users meets `read` last and the other meets it first.
  it('m4list|a reader of one list who edits another list holding the same task can edit it, whatever the row order', async () => {
    const stamp = stampOf()
    const orgId = orgOf('lunion', stamp)
    const userA = await actor('lunionA', stamp, orgId)
    const userB = await actor('lunionB', stamp, orgId)
    const other = `usrO_lunion_${stamp}`
    const created = await createTask({ orgId, creatorId: other, title: '备料复核', assignees: [other], completionMode: 'all' })
    await seedList(orgId, other, [[other, 'owner'], [userA.userId, 'read'], [userB.userId, 'edit']], [created.id])
    await seedList(orgId, other, [[other, 'owner'], [userA.userId, 'edit'], [userB.userId, 'read']], [created.id])
    let version = 1
    for (const who of [userA, userB]) {
      const detail = await app().get(`/api/tasks/${created.id}`).set(auth(who))
      expect(detail.body.canEdit, who.userId).toBe(true)
      const patched = await app().patch(`/api/tasks/${created.id}`).set(auth(who)).send({ expectedVersion: version, title: `备料复核 ${version}` })
      expect(patched.status, who.userId).toBe(200)
      version += 1
    }
  })

  it('m4list|second-tenant|task: a member of an org-B list holding an org-A token gets the missing-id 404; negative control 1 turns it 200', async () => {
    const stamp = stampOf()
    const orgA = orgOf('stA', stamp)
    const orgB = orgOf('stB', stamp)
    const member = await actor('st', stamp, orgA)
    const other = `usrO_st_${stamp}`
    const created = await createTask({ orgId: orgB, creatorId: other, title: '备料复核', assignees: [other], completionMode: 'any' })
    await seedList(orgB, other, [[other, 'owner'], [member.userId, 'edit']], [created.id])
    const before = await snapshot(created.id)
    const server = app()
    const detail = await server.get(`/api/tasks/${created.id}`).set(auth(member))
    const absent = await server.get(`/api/tasks/tsk_missing_${stamp}`).set(auth(member))
    expect(detail.status).toBe(404)
    expect(detail.text).toBe(absent.text)
    const complete = await server.post(`/api/tasks/${created.id}/complete`).set(auth(member)).send({})
    expect(complete.status).toBe(404)
    expect(await snapshot(created.id)).toBe(before)

    // Negative control 1 (task half): the gate 1 needle, rewritten to always-true. The by-id path
    // rides on the same single emission, so the same request now reads org B's task.
    runSourceMutant(ACCESS_FILE, '(tasks.org_id = ${ORG_PLACEHOLDER}) AND ', '(${ORG_PLACEHOLDER}::text IS NOT NULL) AND ', `
      process.env.TASKS_ENABLED = 'true'
      const express = (await import(${JSON.stringify(EXPRESS_PATH)})).default
      const request = (await import(${JSON.stringify(SUPERTEST_PATH)})).default
      const { tasksRouter } = await import(${JSON.stringify(ROUTES_FILE)})
      const server = express()
      server.use(express.json())
      server.use(tasksRouter())
      const detail = await request(server).get('/api/tasks/' + ${JSON.stringify(created.id)}).set('Authorization', 'Bearer ' + ${JSON.stringify(member.bearer)})
      console.log(JSON.stringify({ nc1task: 'red', status: detail.status }))
      process.exit(detail.status === 200 && detail.body.id === ${JSON.stringify(created.id)} ? 0 : 1)
    `, {}, { unique: true })
  }, 180000)

  // ASSUMPTION(task-m4): [own-37] list identity is org-bound twice: the composite FKs refuse an item
  // whose list and task are in different orgs, and `loadActorListMemberships` counts a list only
  // when its org equals the task row's org. The two rows below get past the FKs only because the
  // seeding connection runs with `session_replication_role = replica` (FK triggers skipped).
  it('m4list|cross-org item: the schema refuses it; written past the FKs it grants no list role in either direction; negative control 7 turns both 200', async () => {
    const stamp = stampOf()
    const orgA = orgOf('xoA', stamp)
    const orgB = orgOf('xoB', stamp)
    const member = await actor('xo', stamp, orgA)
    const bearerB = signTaskToken(member.userId, member.roleId, orgB)
    const other = `usrO_xo_${stamp}`
    // Direction 1: task in A, list in B (token A). Direction 2: task in B, list in A (token B).
    const taskA = await createTask({ orgId: orgA, creatorId: other, title: '备料复核', assignees: [other], completionMode: 'any' })
    const taskB = await createTask({ orgId: orgB, creatorId: other, title: '备料复核', assignees: [other], completionMode: 'any' })
    const listB = await seedList(orgB, other, [[other, 'owner'], [member.userId, 'edit']], [])
    const listA = await seedList(orgA, other, [[other, 'owner'], [member.userId, 'edit']], [])
    // Direction 1 carries the task's org, direction 2 the list's org.
    const crossRows: Array<[string, string, string, string]> = [
      [listB, taskA.id, orgA, 'task_list_items_list_fk'],
      [listA, taskB.id, orgA, 'task_list_items_task_fk'],
    ]
    const db = poolManager.get()
    for (const [listId, taskId, orgId, constraint] of crossRows) {
      await expect(db.query('INSERT INTO task_list_items (list_id, task_id, org_id) VALUES ($1, $2, $3)', [listId, taskId, orgId]))
        .rejects.toMatchObject({ code: '23503', constraint })
    }
    const seeder = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await seeder.connect()
    try {
      const su = await seeder.query(`SELECT current_setting('is_superuser') AS su`)
      if (su.rows[0].su !== 'on') throw new Error('the cross-org seed needs a superuser connection (session_replication_role)')
      await seeder.query('SET session_replication_role = replica')
      for (const [listId, taskId, orgId] of crossRows) {
        await seeder.query('INSERT INTO task_list_items (list_id, task_id, org_id) VALUES ($1, $2, $3)', [listId, taskId, orgId])
      }
      await seeder.query('RESET session_replication_role')
    } finally {
      await seeder.end()
    }
    try {
      const seeded = await db.query(
        'SELECT count(*)::int AS n FROM task_list_items WHERE (list_id, task_id) IN (($1, $2), ($3, $4))',
        [listB, taskA.id, listA, taskB.id],
      )
      expect(seeded.rows[0].n).toBe(2)
      const server = app()
      for (const [taskId, bearer] of [[taskA.id, member.bearer], [taskB.id, bearerB]] as const) {
        const before = await snapshot(taskId)
        const header = { Authorization: `Bearer ${bearer}` }
        const missing = `tsk_missing_${stamp}`
        const calls: Array<(id: string) => supertest.Test> = [
          (id) => server.get(`/api/tasks/${id}`).set(header),
          (id) => server.post(`/api/tasks/${id}/complete`).set(header).send({}),
          (id) => server.patch(`/api/tasks/${id}/completion-mode`).set(header).send({ completionMode: 'all' }),
          (id) => server.post(`/api/tasks/${id}/followers`).set(header).send({ userId: member.userId }),
          (id) => server.patch(`/api/tasks/${id}`).set(header).send({ expectedVersion: 1, title: '备料复核(改)' }),
          (id) => server.get(`/api/tasks/${id}/comments`).set(header),
          (id) => server.get(`/api/tasks/${id}/parent-candidates`).set(header),
        ]
        for (const call of calls) {
          const real = await call(taskId)
          const absent = await call(missing)
          expect(real.status, taskId).toBe(404)
          expect(real.text).toBe(absent.text)
        }
        expect(await snapshot(taskId)).toBe(before)
      }

      // Negative control 7: without the list-org = task-org join condition, the same two rows grant
      // list-editor, so both details read 200.
      runSourceMutant(RECORDS_FILE, ' AND tl.org_id = t.org_id', '', `
        process.env.TASKS_ENABLED = 'true'
        const express = (await import(${JSON.stringify(EXPRESS_PATH)})).default
        const request = (await import(${JSON.stringify(SUPERTEST_PATH)})).default
        const { tasksRouter } = await import(${JSON.stringify(ROUTES_FILE)})
        const server = express()
        server.use(express.json())
        server.use(tasksRouter())
        const a = await request(server).get('/api/tasks/' + ${JSON.stringify(taskA.id)}).set('Authorization', 'Bearer ' + ${JSON.stringify(member.bearer)})
        const b = await request(server).get('/api/tasks/' + ${JSON.stringify(taskB.id)}).set('Authorization', 'Bearer ' + ${JSON.stringify(bearerB)})
        console.log(JSON.stringify({ nc7: 'red', a: a.status, b: b.status, aEdit: a.body.canEdit, bEdit: b.body.canEdit }))
        process.exit(a.status === 200 && b.status === 200 && a.body.canEdit === true && b.body.canEdit === true ? 0 : 1)
      `, {}, { unique: true })
    } finally {
      await db.query(
        'DELETE FROM task_list_items WHERE (list_id, task_id) IN (($1, $2), ($3, $4))',
        [listB, taskA.id, listA, taskB.id],
      )
    }
  }, 180000)

  it('negative control 6: an always-true zero-assignee conjunct turns both zero-assignee 404s into 500', async () => {
    const stamp = stampOf()
    const orgId = orgOf('nc6', stamp)
    const editor = await actor('nc6', stamp, orgId)
    const other = `usrO_nc6_${stamp}`
    const openTask = await createTask({ orgId, creatorId: other, title: '备料复核', assignees: [], completionMode: 'all' })
    const doneTask = await createTask({ orgId, creatorId: other, title: '备料复核', assignees: [], completionMode: 'all' })
    await completeTask({ orgId, actorId: other, taskId: doneTask.id })
    await seedList(orgId, other, [[other, 'owner'], [editor.userId, 'edit']], [openTask.id, doneTask.id])
    const beforeOpen = await snapshot(openTask.id)
    const beforeDone = await snapshot(doneTask.id)
    const server = app()
    expect((await server.post(`/api/tasks/${openTask.id}/complete`).set(auth(editor)).send({})).status).toBe(404)
    expect((await server.post(`/api/tasks/${doneTask.id}/reopen`).set(auth(editor)).send({ scope: 'all' })).status).toBe(404)

    runSourceMutant(ACCESS_FILE, "(assigneeCount > 0 || roles.includes('creator'))", '(true)', `
      process.env.TASKS_ENABLED = 'true'
      const express = (await import(${JSON.stringify(EXPRESS_PATH)})).default
      const request = (await import(${JSON.stringify(SUPERTEST_PATH)})).default
      const { tasksRouter } = await import(${JSON.stringify(ROUTES_FILE)})
      const server = express()
      server.use(express.json())
      server.use(tasksRouter())
      const bearer = 'Bearer ' + ${JSON.stringify(editor.bearer)}
      const complete = await request(server).post('/api/tasks/' + ${JSON.stringify(openTask.id)} + '/complete').set('Authorization', bearer).send({})
      const reopen = await request(server).post('/api/tasks/' + ${JSON.stringify(doneTask.id)} + '/reopen').set('Authorization', bearer).send({ scope: 'all' })
      console.log(JSON.stringify({ nc6: 'red', complete: complete.status, reopen: reopen.status }))
      process.exit(complete.status === 500 && reopen.status === 500 ? 0 : 1)
    `, {}, { unique: true })
    // The thrown transition rolls its transaction back: nothing was written under the mutant either.
    expect(await snapshot(openTask.id)).toBe(beforeOpen)
    expect(await snapshot(doneTask.id)).toBe(beforeDone)
  }, 180000)
})
