import '../helpers/assert-rbac-optional-off'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import jwt from 'jsonwebtoken'
import { poolManager } from '../../src/integration/db/connection-pool'
import { createTask } from '../../src/services/task-records'
import { newTaskGroupId, newTaskListId } from '../../src/services/task-ids-runtime'
import { TASK_DEFAULT_GROUP_NAME, TASK_GROUPS_PER_SCOPE_SOFT_LIMIT } from '../../src/tasks/task-groups'
import type { TaskListMemberRole } from '../../src/tasks/task-lists'
import {
  dropTaskM4Fixtures,
  runSourceMutant,
  seedTaskActor,
  signTaskToken,
  whileStructureLockHeld,
  type SeededTaskActor,
} from '../helpers/task-m4-fixtures'
import { rawRequest, startTasksListener, tasksClient, type TasksClient, type TasksListener } from '../helpers/tasks-http-harness'

/**
 * M4 PR-3a S8 (design task-m4-pr3a-backend-design-20260930.md §3.5, §4.3, §4.4, §10.4 groups). The
 * list scope (a list's groups and the placements of its items) and the personal scope (a user's own
 * groups in one org, for the tasks on their assigned arm).
 * RULED(2026-10-07): [R11] one default group per container. ASSUMPTION(task-m4): [own-12] [own-13]
 * [own-24] the personal one is synthetic until the first write, placements are sparse, and
 * `position` is the dense index in the group's visible set: a list's live items, or the live tasks
 * still assigned to the user. [own-09] every row-level failure is the 404 of a missing id. [own-48]
 * the list-scope group reads are 404 before paging and without an org claim. [own-49] a placement
 * checks the task (404), then `groupId` (422 INVALID_GROUP), then `position` (422
 * INVALID_POSITION). [own-50] `group_changed { listId, fromGroupId, toGroupId }` for a list-scope
 * move between groups only. [own-51] ids in byte order. [own-52] group writes check the container,
 * the ability and the group (404) before the name (422).
 * HTTP goes through `tasksRouter()` on one listener per file (tests/helpers/tasks-http-harness.ts;
 * setup.integration.ts, RBAC_TOKEN_TRUST='true'); paths whose bytes must reach the server exactly
 * as written go through `rawRequest`. What the routes cannot produce, or a cell does not exercise through them (another
 * org's lists, groups with chosen ids and positions, placements whose task left the list, groups
 * past the soft limit), is seeded with SQL. Every assignee is a seeded actor of the task's org.
 */

if (process.env.EXPECT_DB !== '1') {
  throw new Error('task-m4-groups.db.test.ts requires EXPECT_DB=1')
}

const ORG_PREFIX = 'org_tasks_m4lgrp_'
const seededUsers: string[] = []
const seededRoles: string[] = []

const req = createRequire(import.meta.url)
const EXPRESS_PATH = req.resolve('express')
const SUPERTEST_PATH = req.resolve('supertest')
const ROUTES_FILE = new URL('../../src/routes/tasks.ts', import.meta.url).pathname
const LIST_ACCESS_FILE = new URL('../../src/tasks/task-list-access.ts', import.meta.url).pathname

const NOT_FOUND_TEXT = JSON.stringify({ error: { code: 'NOT_FOUND' } })
const DEGRADED = { items: [], degraded: true, reason: 'org_missing' }

function stampOf(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12)
}

function orgOf(label: string, stamp: string): string {
  return `${ORG_PREFIX}${label}_${stamp}`
}

async function actor(label: string, stamp: string, orgId: string, codes = ['tasks:read', 'tasks:write']): Promise<SeededTaskActor> {
  const seeded = await seedTaskActor({ label, stamp, orgId, codes, admission: true })
  seededUsers.push(seeded.userId)
  seededRoles.push(seeded.roleId)
  return seeded
}

function tokenFor(who: SeededTaskActor, orgId: string | null): string {
  return jwt.sign({
    userId: who.userId,
    sub: who.userId,
    email: `${who.userId}@tasks-m4.test`,
    role: 'user',
    roles: [who.roleId],
    ...(orgId === null ? {} : { tenantId: orgId }),
  }, String(process.env.JWT_SECRET), { expiresIn: '1h' })
}

let listener: TasksListener | undefined

beforeAll(async () => {
  listener = await startTasksListener()
})

afterAll(async () => {
  await dropTaskM4Fixtures({ orgPrefix: ORG_PREFIX, userIds: seededUsers, roleIds: seededRoles })
  await listener?.close()
})

/** The file's one listener (tests/helpers/tasks-http-harness.ts): `Connection: close`, no keep-alive. */
function app(): TasksClient {
  return tasksClient(listener?.baseUrl ?? '')
}

function port(): number {
  if (!listener) throw new Error('tasks listener not started')
  return listener.port
}

function auth(bearer: string): { Authorization: string } {
  return { Authorization: `Bearer ${bearer}` }
}

type Method = 'get' | 'post' | 'patch' | 'put' | 'delete'

/** Paths whose bytes must reach the server exactly as written go through `rawRequest`. */
async function send(method: Method, path: string, bearer: string, body?: unknown): Promise<{ status: number; text: string; body: unknown }> {
  if (/\/\.\.?(\/|$|\?)/.test(path)) return rawRequest(port(), method.toUpperCase(), path, bearer, body)
  const call = app()[method](path).set(auth(bearer))
  const response = body === undefined ? await call : await call.send(body as object)
  return { status: response.status, text: response.text, body: response.body }
}

function db() {
  return poolManager.get()
}

/** A list written with SQL, with its default group (as `POST /api/task-lists` writes it). */
async function seedList(
  orgId: string,
  createdBy: string,
  members: Array<[string, TaskListMemberRole]>,
  opts: { id?: string; defaultId?: string; taskIds?: string[] } = {},
): Promise<string> {
  const listId = opts.id ?? newTaskListId()
  await db().query(`INSERT INTO task_lists (id, org_id, name, created_by) VALUES ($1, $2, '备料复核', $3)`, [listId, orgId, createdBy])
  await db().query(
    `INSERT INTO task_groups (id, org_id, scope, list_id, name, position, is_default) VALUES ($1, $2, 'list', $3, $4, 0, true)`,
    [opts.defaultId ?? newTaskGroupId(), orgId, listId, TASK_DEFAULT_GROUP_NAME],
  )
  for (const [userId, role] of members) {
    await db().query(`INSERT INTO task_list_members (list_id, user_id, role) VALUES ($1, $2, $3)`, [listId, userId, role])
  }
  for (const taskId of opts.taskIds ?? []) await seedItem(listId, taskId, orgId)
  return listId
}

/** A list created through the route by `owner` (with its default group), members added by SQL. */
async function listVia(owner: SeededTaskActor, members: Array<[string, TaskListMemberRole]> = []): Promise<string> {
  const created = await app().post('/api/task-lists').set(auth(owner.bearer)).send({ name: '备料复核' })
  expect(created.status).toBe(200)
  for (const [userId, role] of members) {
    await db().query(`INSERT INTO task_list_members (list_id, user_id, role) VALUES ($1, $2, $3)`, [created.body.id, userId, role])
  }
  return String(created.body.id)
}

async function seedItem(listId: string, taskId: string, orgId: string): Promise<void> {
  await db().query(`INSERT INTO task_list_items (list_id, task_id, org_id) VALUES ($1, $2, $3)`, [listId, taskId, orgId])
}

async function seedListGroup(orgId: string, listId: string, name: string, position: number, id = newTaskGroupId()): Promise<string> {
  await db().query(
    `INSERT INTO task_groups (id, org_id, scope, list_id, name, position, is_default) VALUES ($1, $2, 'list', $3, $4, $5, false)`,
    [id, orgId, listId, name, position],
  )
  return id
}

async function seedUserGroup(orgId: string, userId: string, name: string, position: number, isDefault: boolean, id = newTaskGroupId()): Promise<string> {
  await db().query(
    `INSERT INTO task_groups (id, org_id, scope, user_id, name, position, is_default) VALUES ($1, $2, 'user', $3, $4, $5, $6)`,
    [id, orgId, userId, name, position, isDefault],
  )
  return id
}

async function seedPlacement(groupId: string, taskId: string, orgId: string, position: number): Promise<void> {
  await db().query(`INSERT INTO task_group_items (group_id, task_id, org_id, position) VALUES ($1, $2, $3, $4)`, [groupId, taskId, orgId, position])
}

async function newTask(orgId: string, creatorId: string, assignees: string[], title = '备料复核'): Promise<string> {
  return (await createTask({ orgId, creatorId, title, assignees, completionMode: 'all' })).id
}

/** A task created by `owner` (its assignee too), made an item of `listId`. */
async function itemTask(orgId: string, owner: SeededTaskActor, listId: string, title = '备料复核'): Promise<string> {
  const taskId = await newTask(orgId, owner.userId, [owner.userId], title)
  await seedItem(listId, taskId, orgId)
  return taskId
}

async function defaultGroupOf(listId: string): Promise<string> {
  return String((await db().query(`SELECT id FROM task_groups WHERE list_id = $1 AND is_default`, [listId])).rows[0].id)
}

/** The stored rows of one group, in stored order: [task id, position]. */
async function stored(groupId: string): Promise<Array<[string, number]>> {
  const result = await db().query(
    `SELECT task_id, position FROM task_group_items WHERE group_id = $1 ORDER BY position, task_id COLLATE "C"`,
    [groupId],
  )
  return result.rows.map((row) => [String(row.task_id), Number(row.position)])
}

async function listGroupRows(listId: string): Promise<Array<Record<string, unknown>>> {
  return (await db().query(
    `SELECT id, org_id, scope, list_id, user_id, name, position, is_default FROM task_groups WHERE list_id = $1 ORDER BY position, id COLLATE "C"`,
    [listId],
  )).rows
}

async function userGroupRows(orgId: string, userId: string): Promise<Array<Record<string, unknown>>> {
  return (await db().query(
    `SELECT id, name, position, is_default FROM task_groups WHERE org_id = $1 AND user_id = $2 ORDER BY position, id COLLATE "C"`,
    [orgId, userId],
  )).rows
}

/** Everything a group write can touch in one org, as one comparable string. */
async function orgState(orgId: string): Promise<string> {
  const groups = await db().query(
    `SELECT id, scope, list_id, user_id, name, position, is_default, created_at, updated_at FROM task_groups WHERE org_id = $1 ORDER BY id`,
    [orgId],
  )
  const items = await db().query(
    `SELECT group_id, task_id, org_id, position, created_at FROM task_group_items WHERE org_id = $1 ORDER BY group_id, task_id`,
    [orgId],
  )
  const lists = await db().query(`SELECT id, name, archived_at, updated_at FROM task_lists WHERE org_id = $1 ORDER BY id`, [orgId])
  const listEvents = await db().query(
    `SELECT e.id, e.list_id, e.actor_id, e.event_type, e.payload, e.occurred_at
       FROM task_list_events e JOIN task_lists l ON l.id = e.list_id WHERE l.org_id = $1 ORDER BY e.id`,
    [orgId],
  )
  const taskEvents = await db().query(
    `SELECT e.id, e.task_id, e.actor_id, e.event_type, e.payload, e.occurred_at
       FROM task_events e JOIN tasks t ON t.id = e.task_id WHERE t.org_id = $1 ORDER BY e.id`,
    [orgId],
  )
  return JSON.stringify({ groups: groups.rows, items: items.rows, lists: lists.rows, listEvents: listEvents.rows, taskEvents: taskEvents.rows })
}

/** The group events of one list, oldest first: [actor, type, payload]. */
async function groupEvents(listId: string): Promise<unknown[]> {
  const result = await db().query(
    `SELECT actor_id, event_type, payload FROM task_list_events
      WHERE list_id = $1 AND event_type IN ('group_created', 'group_renamed', 'group_deleted') ORDER BY occurred_at, id`,
    [listId],
  )
  return result.rows.map((row) => [row.actor_id, row.event_type, row.payload])
}

/** The `group_changed` events of one task, oldest first: [actor, payload]. */
async function changedEvents(taskId: string): Promise<unknown[]> {
  const result = await db().query(
    `SELECT actor_id, payload FROM task_events WHERE task_id = $1 AND event_type = 'group_changed' ORDER BY occurred_at, id`,
    [taskId],
  )
  return result.rows.map((row) => [row.actor_id, row.payload])
}

/** For a group row: whether its stamps are later than `after`, and whether the latest group event of
 * `type` for it carries the row's `updated_at`, compared in SQL. */
async function groupStamps(groupId: string, type: string, after = '-infinity'): Promise<Record<string, unknown>> {
  const result = await db().query(
    `SELECT g.updated_at > $3::timestamptz AS later,
            (SELECT e.occurred_at FROM task_list_events e
              WHERE e.list_id = g.list_id AND e.event_type = $2 AND e.payload->>'groupId' = g.id
              ORDER BY e.occurred_at DESC, e.id DESC LIMIT 1) = g.updated_at AS event_same
       FROM task_groups g WHERE g.id = $1`,
    [groupId, type, after],
  )
  return result.rows[0]
}

/** The placements a member reads for one list, as [group, task, position]. */
async function readPlacements(listId: string, bearer: string, query = ''): Promise<{ rows: Array<[string, string, number]>; total: number }> {
  const response = await app().get(`/api/task-lists/${listId}/group-items${query}`).set(auth(bearer))
  expect(response.status).toBe(200)
  expect(Object.keys(response.body).sort()).toEqual(['items', 'total'])
  return {
    rows: response.body.items.map((item: { groupId: string; taskId: string; position: number }) => {
      expect(Object.keys(item).sort()).toEqual(['groupId', 'position', 'taskId'])
      return [item.groupId, item.taskId, item.position]
    }),
    total: response.body.total,
  }
}

/** The personal placements a user reads, as [group, task, position]. */
async function readMine(bearer: string, query = ''): Promise<{ rows: Array<[string, string, number]>; total: number }> {
  const response = await app().get(`/api/task-groups/items${query}`).set(auth(bearer))
  expect(response.status).toBe(200)
  return {
    rows: response.body.items.map((item: { groupId: string; taskId: string; position: number }) => [item.groupId, item.taskId, item.position]),
    total: response.body.total,
  }
}

function place(listId: string, taskId: string, bearer: string, body: unknown) {
  return app().put(`/api/task-lists/${listId}/group-items/${taskId}`).set(auth(bearer)).send(body as object)
}

function placeMine(taskId: string, bearer: string, body: unknown) {
  return app().put(`/api/task-groups/items/${taskId}`).set(auth(bearer)).send(body as object)
}

// ---------------------------------------------------------------------------------------------
// List scope: groups
// ---------------------------------------------------------------------------------------------

describe('list groups', () => {
  it('groups|create: the owner and an edit member append groups after the default one; rows carry the list and its org; group_created by the caller shares the row instant; the list row and another list are untouched', async () => {
    const stamp = stampOf()
    const orgId = orgOf('cr', stamp)
    const owner = await actor('crowner', stamp, orgId)
    const editor = await actor('credit', stamp, orgId)
    const listId = await listVia(owner, [[editor.userId, 'edit']])
    const other = await listVia(owner)
    const defaultId = await defaultGroupOf(listId)
    const listBefore = (await db().query(`SELECT name, archived_at, updated_at FROM task_lists WHERE id = $1`, [listId])).rows
    const otherBefore = await listGroupRows(other)

    const a = await app().post(`/api/task-lists/${listId}/groups`).set(auth(owner.bearer)).send({ name: '  待办 ' })
    expect(a.status).toBe(200)
    expect(a.body).toEqual({ id: expect.stringMatching(/^tgrp_[A-Za-z0-9]+$/), scope: 'list', name: '待办', position: 1, isDefault: false })
    const b = await app().post(`/api/task-lists/${listId}/groups`).set(auth(editor.bearer)).send({ name: '进行中' })
    expect(b.status).toBe(200)
    expect(b.body).toEqual({ id: expect.stringMatching(/^tgrp_/), scope: 'list', name: '进行中', position: 2, isDefault: false })

    expect(await listGroupRows(listId)).toEqual([
      { id: defaultId, org_id: orgId, scope: 'list', list_id: listId, user_id: null, name: TASK_DEFAULT_GROUP_NAME, position: 0, is_default: true },
      { id: a.body.id, org_id: orgId, scope: 'list', list_id: listId, user_id: null, name: '待办', position: 1, is_default: false },
      { id: b.body.id, org_id: orgId, scope: 'list', list_id: listId, user_id: null, name: '进行中', position: 2, is_default: false },
    ])
    expect(await groupEvents(listId)).toEqual([
      [owner.userId, 'group_created', { groupId: a.body.id }],
      [editor.userId, 'group_created', { groupId: b.body.id }],
    ])
    for (const id of [a.body.id, b.body.id]) {
      expect(await groupStamps(id, 'group_created')).toEqual({ later: true, event_same: true })
      const row = await db().query(`SELECT created_at = updated_at AS same FROM task_groups WHERE id = $1`, [id])
      expect(row.rows[0].same).toBe(true)
    }
    expect((await db().query(`SELECT name, archived_at, updated_at FROM task_lists WHERE id = $1`, [listId])).rows).toEqual(listBefore)
    expect(await listGroupRows(other)).toEqual(otherBefore)

    const read = await app().get(`/api/task-lists/${listId}/groups`).set(auth(editor.bearer))
    expect(read.status).toBe(200)
    expect(read.body).toEqual({
      items: [{ id: defaultId, scope: 'list', name: TASK_DEFAULT_GROUP_NAME, position: 0, isDefault: true }, a.body, b.body],
      total: 3,
    })
  })

  it('groups|read: by position, then id in byte order; pages are disjoint; another list\'s groups never appear; a read member reads; a non-member is the 404 of a missing list, also with an invalid page; a member with an invalid page is 422', async () => {
    const stamp = stampOf()
    const orgId = orgOf('rd', stamp)
    const owner = await actor('rdowner', stamp, orgId)
    const reader = await actor('rdread', stamp, orgId)
    const outsider = await actor('rdout', stamp, orgId)
    // Ids chosen so that neither the id alone nor the position with a locale tie-break gives the
    // order: z sits before m by position, and B and a tie at 3, where byte order puts B first.
    const listId = await seedList(orgId, owner.userId, [[owner.userId, 'owner'], [reader.userId, 'read']], { defaultId: `tgrp_y${stamp}` })
    const z = await seedListGroup(orgId, listId, 'Z', 1, `tgrp_z${stamp}`)
    const m = await seedListGroup(orgId, listId, 'M', 2, `tgrp_m${stamp}`)
    const a = await seedListGroup(orgId, listId, 'A', 3, `tgrp_a${stamp}`)
    const B = await seedListGroup(orgId, listId, 'B', 3, `tgrp_B${stamp}`)
    const other = await seedList(orgId, owner.userId, [[owner.userId, 'owner'], [reader.userId, 'read']], { defaultId: `tgrp_b${stamp}` })
    await seedListGroup(orgId, other, 'Other', 1, `tgrp_c${stamp}`)
    const expected = [`tgrp_y${stamp}`, z, m, B, a]
    const all = await app().get(`/api/task-lists/${listId}/groups`).set(auth(reader.bearer))
    expect(all.status).toBe(200)
    expect(all.body.total).toBe(5)
    expect(all.body.items.map((group: { id: string }) => group.id)).toEqual(expected)
    expect(all.body.items[0]).toEqual({ id: `tgrp_y${stamp}`, scope: 'list', name: TASK_DEFAULT_GROUP_NAME, position: 0, isDefault: true })
    const seen: string[] = []
    for (const offset of ['0', '2', '4']) {
      const page = await app().get(`/api/task-lists/${listId}/groups`).query({ limit: '2', offset }).set(auth(reader.bearer))
      expect(page.status).toBe(200)
      expect(Object.keys(page.body).sort()).toEqual(['items', 'total'])
      expect(page.body.total).toBe(5)
      seen.push(...page.body.items.map((group: { id: string }) => group.id))
    }
    expect(seen).toEqual(expected)
    expect((await app().get(`/api/task-lists/${listId}/groups`).query({ offset: '5' }).set(auth(reader.bearer))).body).toEqual({ items: [], total: 5 })
    for (const query of ['', '?limit=0', '?offset=-1']) {
      const hidden = await app().get(`/api/task-lists/${listId}/groups${query}`).set(auth(outsider.bearer))
      const missing = await app().get(`/api/task-lists/tlst_missing${stamp}/groups${query}`).set(auth(outsider.bearer))
      expect(hidden.status).toBe(404)
      expect(hidden.text).toBe(missing.text)
      expect(hidden.text).toBe(NOT_FOUND_TEXT)
    }
    expect((await app().get(`/api/task-lists/${listId}/groups?limit=101`).set(auth(reader.bearer))).body).toEqual({ error: { code: 'INVALID_LIMIT' } })
    expect((await app().get(`/api/task-lists/${listId}/groups?offset=x`).set(auth(reader.bearer))).body).toEqual({ error: { code: 'INVALID_OFFSET' } })
    // A delete renumbers in the same order: the tie at 3 resolves as the read does, B before a.
    expect((await app().delete(`/api/task-lists/${listId}/groups/${z}`).set(auth(owner.bearer))).status).toBe(200)
    expect((await listGroupRows(listId)).map((row) => [row.id, row.position])).toEqual([[`tgrp_y${stamp}`, 0], [m, 1], [B, 2], [a, 3]])
    expect((await listGroupRows(other)).map((row) => [row.id, row.position])).toEqual([[`tgrp_b${stamp}`, 0], [`tgrp_c${stamp}`, 1]])
  })

  it('groups|rename: an edit member renames a group and the default group; the row\'s updated_at and group_renamed share one instant; the same name is the no-op; another list\'s group through this list is the 404 of a missing group; invalid names are 422 after the group is found; nothing written by a refusal', async () => {
    const stamp = stampOf()
    const orgId = orgOf('rn', stamp)
    const owner = await actor('rnowner', stamp, orgId)
    const editor = await actor('rnedit', stamp, orgId)
    const listId = await listVia(owner, [[editor.userId, 'edit']])
    const other = await listVia(owner, [[editor.userId, 'edit']])
    const defaultId = await defaultGroupOf(listId)
    const group = (await app().post(`/api/task-lists/${listId}/groups`).set(auth(owner.bearer)).send({ name: '待办' })).body
    const foreign = (await app().post(`/api/task-lists/${other}/groups`).set(auth(owner.bearer)).send({ name: '别处' })).body

    const renamed = await app().patch(`/api/task-lists/${listId}/groups/${group.id}`).set(auth(editor.bearer)).send({ name: ' 复核中 ' })
    expect(renamed.status).toBe(200)
    expect(renamed.body).toEqual({ ...group, name: '复核中' })
    const row = await db().query(`SELECT name, updated_at > created_at AS moved FROM task_groups WHERE id = $1`, [group.id])
    expect(row.rows).toEqual([{ name: '复核中', moved: true }])
    expect(await groupStamps(group.id, 'group_renamed')).toEqual({ later: true, event_same: true })
    const defaultRenamed = await app().patch(`/api/task-lists/${listId}/groups/${defaultId}`).set(auth(editor.bearer)).send({ name: '收件箱' })
    expect(defaultRenamed.status).toBe(200)
    expect(defaultRenamed.body).toEqual({ id: defaultId, scope: 'list', name: '收件箱', position: 0, isDefault: true })
    expect(await groupEvents(listId)).toEqual([
      [owner.userId, 'group_created', { groupId: group.id }],
      [editor.userId, 'group_renamed', { groupId: group.id }],
      [editor.userId, 'group_renamed', { groupId: defaultId }],
    ])

    // The same name: 200 with the group, nothing written.
    const before = await orgState(orgId)
    const same = await app().patch(`/api/task-lists/${listId}/groups/${group.id}`).set(auth(editor.bearer)).send({ name: '复核中' })
    expect(same.status).toBe(200)
    expect(same.body).toEqual({ ...group, name: '复核中' })
    expect(await orgState(orgId)).toBe(before)

    // Another list's group, and ids that cannot be a group, through this list: the missing-group 404.
    const missing = await send('patch', `/api/task-lists/${listId}/groups/tgrp_missing${stamp}`, editor.bearer, { name: 'x' })
    expect(missing.text).toBe(NOT_FOUND_TEXT)
    for (const path of [
      `/api/task-lists/${listId}/groups/${foreign.id}`,
      `/api/task-lists/${listId}/groups/tgrp_%00`,
      `/api/task-lists/${listId}/groups/.`,
      `/api/task-lists/${listId}/groups/..`,
    ]) {
      for (const body of [{ name: 'x' }, { name: '' }]) {
        const response = await send('patch', path, editor.bearer, body)
        expect(response.status, path).toBe(404)
        expect(response.text, path).toBe(missing.text)
      }
    }
    // Invalid names on a group of this list: 422.
    for (const [body, code] of [
      [{}, 'INVALID_NAME'], [{ name: '' }, 'INVALID_NAME'], [{ name: '   ' }, 'INVALID_NAME'], [{ name: 7 }, 'INVALID_NAME'],
      [{ name: '分\u0000组' }, 'INVALID_NAME'], [{ name: '分\uD800组' }, 'INVALID_NAME'], [{ name: 'a'.repeat(101) }, 'NAME_TOO_LONG'],
      [[{ name: 'x' }], 'INVALID_NAME'],
    ] as const) {
      const response = await send('patch', `/api/task-lists/${listId}/groups/${group.id}`, editor.bearer, body)
      expect(response.status, JSON.stringify(body)).toBe(422)
      expect(response.body).toEqual({ error: { code } })
    }
    expect(await orgState(orgId)).toBe(before)
    expect((await db().query(`SELECT name FROM task_groups WHERE id = $1`, [foreign.id])).rows).toEqual([{ name: '别处' }])
  })

  it('groups|delete: placements of the deleted group go with it, so its tasks are in the default group again; reassignedTo is the default; the rest are renumbered, positions only; group_deleted and no group_changed; a group created afterwards comes last; another list keeps its positions; the default is 422 IS_DEFAULT; a deleted group is the 404', async () => {
    const stamp = stampOf()
    const orgId = orgOf('del', stamp)
    const owner = await actor('delowner', stamp, orgId)
    const listId = await listVia(owner)
    const other = await listVia(owner)
    const defaultId = await defaultGroupOf(listId)
    const create = async (id: string, name: string) => (await app().post(`/api/task-lists/${id}/groups`).set(auth(owner.bearer)).send({ name })).body
    const a = await create(listId, 'A')
    const b = await create(listId, 'B')
    const x = await create(other, 'X')
    const y = await create(other, 'Y')
    const t1 = await itemTask(orgId, owner, listId, '一')
    const t2 = await itemTask(orgId, owner, listId, '二')
    const t3 = await itemTask(orgId, owner, listId, '三')
    for (const [taskId, groupId, position] of [[t1, a.id, 0], [t2, a.id, 1], [t3, b.id, 0]] as const) {
      expect((await place(listId, taskId, owner.bearer, { groupId, position })).status).toBe(200)
    }
    const stampsBefore = (await db().query(`SELECT id, updated_at FROM task_groups WHERE list_id = $1 AND id <> $2 ORDER BY id`, [listId, a.id])).rows
    const listBefore = (await db().query(`SELECT updated_at FROM task_lists WHERE id = $1`, [listId])).rows
    const otherBefore = await listGroupRows(other)

    const deleted = await app().delete(`/api/task-lists/${listId}/groups/${a.id}`).set(auth(owner.bearer))
    expect(deleted.status).toBe(200)
    expect(deleted.body).toEqual({ id: a.id, deleted: true, reassignedTo: defaultId })
    // [own-50] a group delete writes only group_deleted: the tasks it sends back to the default group
    // get no group_changed, so the latest one of each still names the deleted group.
    for (const taskId of [t1, t2]) {
      expect(await changedEvents(taskId)).toEqual([[owner.userId, { listId, fromGroupId: defaultId, toGroupId: a.id }]])
    }
    expect((await listGroupRows(listId)).map((row) => [row.id, row.position])).toEqual([[defaultId, 0], [b.id, 1]])
    expect(await stored(a.id)).toEqual([])
    expect(await stored(b.id)).toEqual([[t3, 0]])
    // No row in any group of the list: both tasks are in the default group again, after placed ones.
    const rest = await db().query(`SELECT count(*)::int AS n FROM task_group_items WHERE task_id = ANY($1::text[])`, [[t1, t2]])
    expect(rest.rows[0].n).toBe(0)
    expect(await readPlacements(listId, owner.bearer)).toEqual({ rows: [[b.id, t3, 0]], total: 1 })
    // The renumbering writes positions only; the list row is not touched.
    const stampsAfter = (await db().query(`SELECT id, updated_at FROM task_groups WHERE list_id = $1 ORDER BY id`, [listId])).rows
    expect(stampsAfter).toEqual(stampsBefore)
    expect((await db().query(`SELECT updated_at FROM task_lists WHERE id = $1`, [listId])).rows).toEqual(listBefore)
    expect((await groupEvents(listId)).slice(-1)).toEqual([[owner.userId, 'group_deleted', { groupId: a.id }]])
    const event = await db().query(
      `SELECT occurred_at > (SELECT max(updated_at) FROM task_groups WHERE list_id = $1) AS later FROM task_list_events
        WHERE list_id = $1 AND event_type = 'group_deleted'`,
      [listId],
    )
    expect(event.rows).toEqual([{ later: true }])
    expect(await listGroupRows(other)).toEqual(otherBefore)
    expect(otherBefore.map((row) => [row.id, row.position])).toEqual([[await defaultGroupOf(other), 0], [x.id, 1], [y.id, 2]])

    // Created afterwards: after B, not beside it.
    const c = await create(listId, 'C')
    expect(c.position).toBe(2)
    expect((await listGroupRows(listId)).map((row) => row.id)).toEqual([defaultId, b.id, c.id])

    const before = await orgState(orgId)
    const isDefault = await app().delete(`/api/task-lists/${listId}/groups/${defaultId}`).set(auth(owner.bearer))
    expect(isDefault.status).toBe(422)
    expect(isDefault.body).toEqual({ error: { code: 'IS_DEFAULT' } })
    const again = await app().delete(`/api/task-lists/${listId}/groups/${a.id}`).set(auth(owner.bearer))
    const missing = await app().delete(`/api/task-lists/${listId}/groups/tgrp_missing${stamp}`).set(auth(owner.bearer))
    const foreign = await app().delete(`/api/task-lists/${listId}/groups/${x.id}`).set(auth(owner.bearer))
    for (const response of [again, foreign]) {
      expect(response.status).toBe(404)
      expect(response.text).toBe(missing.text)
    }
    expect(missing.text).toBe(NOT_FOUND_TEXT)
    expect(await orgState(orgId)).toBe(before)
  })

  it('groups|limit: a list holds 50 groups counting the default one; the next is 422 LIMIT and writes nothing', async () => {
    const stamp = stampOf()
    const orgId = orgOf('lim', stamp)
    const owner = await actor('limowner', stamp, orgId)
    const listId = await listVia(owner)
    for (let position = 1; position < TASK_GROUPS_PER_SCOPE_SOFT_LIMIT - 1; position += 1) {
      await seedListGroup(orgId, listId, `G${position}`, position)
    }
    const last = await app().post(`/api/task-lists/${listId}/groups`).set(auth(owner.bearer)).send({ name: '最后' })
    expect(last.status).toBe(200)
    expect(last.body.position).toBe(TASK_GROUPS_PER_SCOPE_SOFT_LIMIT - 1)
    const before = await orgState(orgId)
    const refused = await app().post(`/api/task-lists/${listId}/groups`).set(auth(owner.bearer)).send({ name: '多一个' })
    expect(refused.status).toBe(422)
    expect(refused.body).toEqual({ error: { code: 'LIMIT' } })
    // A bad name on a full list is the name's 422: the name is checked before the limit.
    const badName = await app().post(`/api/task-lists/${listId}/groups`).set(auth(owner.bearer)).send({ name: ' ' })
    expect(badName.body).toEqual({ error: { code: 'INVALID_NAME' } })
    expect(await orgState(orgId)).toBe(before)
  })

  it('m4list|groups: a read member and a non-member get the 404 of a missing list on every group write, whatever the body; nothing written; the read member reads both lists of groups', async () => {
    const stamp = stampOf()
    const orgId = orgOf('ro', stamp)
    const owner = await actor('roowner', stamp, orgId)
    const reader = await actor('roread', stamp, orgId)
    const outsider = await actor('roout', stamp, orgId)
    const listId = await listVia(owner, [[reader.userId, 'read']])
    const group = (await app().post(`/api/task-lists/${listId}/groups`).set(auth(owner.bearer)).send({ name: '待办' })).body
    const taskId = await itemTask(orgId, owner, listId)
    const missingList = `tlst_missing${stamp}`
    const before = await orgState(orgId)
    const calls: Array<[Method, string, unknown]> = [
      ['post', `/api/task-lists/${listId}/groups`, { name: '新组' }],
      ['post', `/api/task-lists/${listId}/groups`, {}],
      ['patch', `/api/task-lists/${listId}/groups/${group.id}`, { name: '改名' }],
      ['patch', `/api/task-lists/${listId}/groups/${group.id}`, { name: '' }],
      ['delete', `/api/task-lists/${listId}/groups/${group.id}`, undefined],
      ['put', `/api/task-lists/${listId}/group-items/${taskId}`, { groupId: null, position: 0 }],
      ['put', `/api/task-lists/${listId}/group-items/${taskId}`, { groupId: 7, position: 'x' }],
    ]
    for (const who of [reader, outsider]) {
      for (const [method, path, body] of calls) {
        const hidden = await send(method, path, who.bearer, body)
        const missing = await send(method, path.replace(listId, missingList), who.bearer, body)
        expect(hidden.status, `${method} ${path}`).toBe(404)
        expect(hidden.text).toBe(missing.text)
        expect(hidden.text).toBe(NOT_FOUND_TEXT)
      }
    }
    expect(await orgState(orgId)).toBe(before)
    expect((await app().get(`/api/task-lists/${listId}/groups`).set(auth(reader.bearer))).body.total).toBe(2)
    expect((await app().get(`/api/task-lists/${listId}/group-items`).set(auth(reader.bearer))).status).toBe(200)
  })

  it('m4list|second tenant: a member of an org B list holding an org A token gets the 404 of a missing list on the six list group routes; org B is untouched; the org B token reads the groups', async () => {
    const stamp = stampOf()
    const orgA = orgOf('stA', stamp)
    const orgB = orgOf('stB', stamp)
    const me = await actor('st', stamp, orgA)
    await db().query('INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)', [me.userId, orgB])
    const taskB = await newTask(orgB, me.userId, [me.userId])
    const listB = await seedList(orgB, me.userId, [[me.userId, 'owner']], { taskIds: [taskB] })
    const groupB = await seedListGroup(orgB, listB, 'B组', 1)
    const before = await orgState(orgB)
    const missingList = `tlst_missing${stamp}`
    for (const [method, path, body] of [
      ['get', `/api/task-lists/${listB}/groups`, undefined],
      ['post', `/api/task-lists/${listB}/groups`, { name: '新组' }],
      ['patch', `/api/task-lists/${listB}/groups/${groupB}`, { name: '改名' }],
      ['delete', `/api/task-lists/${listB}/groups/${groupB}`, undefined],
      ['get', `/api/task-lists/${listB}/group-items`, undefined],
      ['put', `/api/task-lists/${listB}/group-items/${taskB}`, { groupId: groupB, position: 0 }],
    ] as Array<[Method, string, unknown]>) {
      const hidden = await send(method, path, me.bearer, body)
      const missing = await send(method, path.replace(listB, missingList), me.bearer, body)
      expect(hidden.status, `${method} ${path}`).toBe(404)
      expect(hidden.text).toBe(missing.text)
    }
    expect(await orgState(orgB)).toBe(before)
    const asB = await app().get(`/api/task-lists/${listB}/groups`).set(auth(signTaskToken(me.userId, me.roleId, orgB)))
    expect(asB.status).toBe(200)
    expect(asB.body.items.map((group: { id: string }) => group.id)).toEqual([await defaultGroupOf(listB), groupB])
  })
})

// ---------------------------------------------------------------------------------------------
// List scope: placements
// ---------------------------------------------------------------------------------------------

describe('list placements', () => {
  // Design §10.4, the visible-set rows. The group is stored as [A, H, L, B]: H's task is deleted, L's
  // task is no longer an item of the list (a row the route removal would have deleted, seeded here).
  async function visibleFixture(label: string) {
    const stamp = stampOf()
    const orgId = orgOf(label, stamp)
    const owner = await actor(`${label}owner`, stamp, orgId)
    const listId = await listVia(owner)
    const group = (await app().post(`/api/task-lists/${listId}/groups`).set(auth(owner.bearer)).send({ name: 'G' })).body.id as string
    const A = await itemTask(orgId, owner, listId, 'A')
    const H = await itemTask(orgId, owner, listId, 'H')
    const B = await itemTask(orgId, owner, listId, 'B')
    const X = await itemTask(orgId, owner, listId, 'X')
    const L = await newTask(orgId, owner.userId, [owner.userId], 'L')
    await seedPlacement(group, A, orgId, 0)
    await seedPlacement(group, H, orgId, 1)
    await seedPlacement(group, L, orgId, 2)
    await seedPlacement(group, B, orgId, 3)
    await db().query(`UPDATE tasks SET deleted_at = now() WHERE id = $1`, [H])
    return { stamp, orgId, owner, listId, group, A, H, B, X, L }
  }

  it('groups|visible index: a group stored [A, H, L, B] reads A, B at 0, 1; X placed at 2 is appended and the hidden rows follow the visible ones in their order; X at 1 lands between A and B; 3 is 422 INVALID_POSITION', async () => {
    const { listId, owner, group, A, H, B, X, L, orgId } = await visibleFixture('vis')
    const defaultId = await defaultGroupOf(listId)
    expect(await readPlacements(listId, owner.bearer)).toEqual({ rows: [[group, A, 0], [group, B, 1]], total: 2 })

    const appended = await place(listId, X, owner.bearer, { groupId: group, position: 2 })
    expect(appended.status).toBe(200)
    expect(appended.body).toEqual({ taskId: X, groupId: group, position: 2 })
    expect(await readPlacements(listId, owner.bearer)).toEqual({ rows: [[group, A, 0], [group, B, 1], [group, X, 2]], total: 3 })
    expect(await stored(group)).toEqual([[A, 0], [B, 1], [X, 2], [H, 3], [L, 4]])
    expect(await changedEvents(X)).toEqual([[owner.userId, { listId, fromGroupId: defaultId, toGroupId: group }]])

    const between = await place(listId, X, owner.bearer, { groupId: group, position: 1 })
    expect(between.status).toBe(200)
    expect(between.body).toEqual({ taskId: X, groupId: group, position: 1 })
    expect(await readPlacements(listId, owner.bearer)).toEqual({ rows: [[group, A, 0], [group, X, 1], [group, B, 2]], total: 3 })
    expect(await stored(group)).toEqual([[A, 0], [X, 1], [B, 2], [H, 3], [L, 4]])
    // A reorder inside one group writes no event.
    expect(await changedEvents(X)).toHaveLength(1)

    const before = await orgState(orgId)
    // Past the end, and fractions inside the range: each 422, nothing written.
    for (const position of [3, 0.5, 1.5]) {
      const refused = await place(listId, X, owner.bearer, { groupId: group, position })
      expect(refused.status, String(position)).toBe(422)
      expect(refused.body).toEqual({ error: { code: 'INVALID_POSITION' } })
    }
    expect(await orgState(orgId)).toBe(before)
  })

  it('groups|no-op: the same visible order writes nothing; the hidden rows keep their places between the visible ones; no event', async () => {
    const { listId, owner, group, A, H, B, L, orgId } = await visibleFixture('noop')
    const before = await orgState(orgId)
    for (const [taskId, position] of [[A, 0], [B, 1]] as const) {
      const response = await place(listId, taskId, owner.bearer, { groupId: group, position })
      expect(response.status).toBe(200)
      expect(response.body).toEqual({ taskId, groupId: group, position })
    }
    expect(await stored(group)).toEqual([[A, 0], [H, 1], [L, 2], [B, 3]])
    expect(await orgState(orgId)).toBe(before)
  })

  it('groups|move: a move between groups deletes the row in the source group without rewriting it and writes group_changed { listId, fromGroupId, toGroupId } at the new row\'s instant; a reorder and a row-less task placed in the default group write no event; another list\'s groups and personal groups holding the task are untouched', async () => {
    const stamp = stampOf()
    const orgId = orgOf('mv', stamp)
    const owner = await actor('mvowner', stamp, orgId)
    // The groups of the other containers holding T sort before this list's groups (byte order), so
    // a source group read across containers would name one of them.
    const defaultId = `tgrp_zd${stamp}`
    const otherDefault = `tgrp_a1${stamp}`
    const listId = await seedList(orgId, owner.userId, [[owner.userId, 'owner']], { defaultId })
    const other = await seedList(orgId, owner.userId, [[owner.userId, 'owner']], { defaultId: otherDefault })
    const A = await seedListGroup(orgId, listId, 'A', 1, `tgrp_zA${stamp}`)
    const B = await seedListGroup(orgId, listId, 'B', 2, `tgrp_zB${stamp}`)
    const T = await itemTask(orgId, owner, listId, 'T')
    const U = await itemTask(orgId, owner, listId, 'U')
    const V = await itemTask(orgId, owner, listId, 'V')
    await seedItem(other, T, orgId)
    await seedPlacement(A, T, orgId, 0)
    await seedPlacement(A, U, orgId, 1)
    await seedPlacement(otherDefault, T, orgId, 0)
    const personal = await seedUserGroup(orgId, owner.userId, TASK_DEFAULT_GROUP_NAME, 0, true, `tgrp_a2${stamp}`)
    await seedPlacement(personal, T, orgId, 0)

    const moved = await place(listId, T, owner.bearer, { groupId: B, position: 0 })
    expect(moved.status).toBe(200)
    expect(moved.body).toEqual({ taskId: T, groupId: B, position: 0 })
    // The source group only loses the row; reads renumber it.
    expect(await stored(A)).toEqual([[U, 1]])
    expect(await stored(B)).toEqual([[T, 0]])
    expect(await readPlacements(listId, owner.bearer)).toEqual({ rows: [[A, U, 0], [B, T, 0]], total: 2 })
    expect(await changedEvents(T)).toEqual([[owner.userId, { listId, fromGroupId: A, toGroupId: B }]])
    const instant = await db().query(
      `SELECT (SELECT occurred_at FROM task_events WHERE task_id = $1 AND event_type = 'group_changed') = gi.created_at AS same
         FROM task_group_items gi WHERE gi.group_id = $2 AND gi.task_id = $1`,
      [T, B],
    )
    expect(instant.rows).toEqual([{ same: true }])
    expect(await stored(otherDefault)).toEqual([[T, 0]])
    expect(await stored(personal)).toEqual([[T, 0]])

    // Back to the default group by null: a move from B.
    expect((await place(listId, T, owner.bearer, { groupId: null, position: 0 })).body).toEqual({ taskId: T, groupId: defaultId, position: 0 })
    expect(await changedEvents(T)).toEqual([
      [owner.userId, { listId, fromGroupId: A, toGroupId: B }],
      [owner.userId, { listId, fromGroupId: B, toGroupId: defaultId }],
    ])
    expect(await stored(B)).toEqual([])
    // A row-less task is in the default group already: placing it there is not a move.
    expect((await place(listId, V, owner.bearer, { groupId: defaultId, position: 1 })).body).toEqual({ taskId: V, groupId: defaultId, position: 1 })
    expect(await changedEvents(V)).toEqual([])
    expect(await stored(defaultId)).toEqual([[T, 0], [V, 1]])
    // A reorder inside the default group: no event.
    expect((await place(listId, V, owner.bearer, { groupId: null, position: 0 })).status).toBe(200)
    expect(await stored(defaultId)).toEqual([[V, 0], [T, 1]])
    expect(await changedEvents(V)).toEqual([])
    expect(await changedEvents(T)).toHaveLength(2)
    expect(await stored(otherDefault)).toEqual([[T, 0]])
    expect(await stored(personal)).toEqual([[T, 0]])
  })

  it('groups|place 404: a task that is not an item of the list, a deleted item, another org\'s task, a missing id, and malformed path ids are each the same 404, also with a bad body; nothing written', async () => {
    const stamp = stampOf()
    const orgId = orgOf('p404', stamp)
    const otherOrg = orgOf('p404B', stamp)
    const owner = await actor('p404owner', stamp, orgId)
    const listId = await listVia(owner)
    const outside = await newTask(orgId, owner.userId, [owner.userId], '不在清单')
    const deleted = await itemTask(orgId, owner, listId, '已删除')
    await db().query(`UPDATE tasks SET deleted_at = now() WHERE id = $1`, [deleted])
    const foreign = await newTask(otherOrg, owner.userId, [owner.userId], '他 org')
    const live = await itemTask(orgId, owner, listId, '在清单')
    const before = await orgState(orgId)
    const beforeOther = await orgState(otherOrg)
    for (const taskId of [outside, deleted, foreign, `tsk_missing_${stamp}`, 'tsk%00x', '.', '..']) {
      for (const body of [{ groupId: null, position: 0 }, { groupId: 7, position: 'x' }, {}]) {
        const response = await send('put', `/api/task-lists/${listId}/group-items/${taskId}`, owner.bearer, body)
        expect(response.status, `${taskId} ${JSON.stringify(body)}`).toBe(404)
        expect(response.text).toBe(NOT_FOUND_TEXT)
      }
    }
    expect(await orgState(orgId)).toBe(before)
    expect(await orgState(otherOrg)).toBe(beforeOther)
    expect((await place(listId, live, owner.bearer, { groupId: null, position: 0 })).status).toBe(200)
  })

  it('groups|place 422: groupId missing, not null or an id, or naming a group of another list, a personal group or another org\'s list is 422 INVALID_GROUP; a bad position is 422 INVALID_POSITION; both bad is INVALID_GROUP; nothing written', async () => {
    const stamp = stampOf()
    const orgId = orgOf('p422', stamp)
    const otherOrg = orgOf('p422B', stamp)
    const owner = await actor('p422owner', stamp, orgId)
    const listId = await listVia(owner)
    const other = await listVia(owner)
    const group = (await app().post(`/api/task-lists/${listId}/groups`).set(auth(owner.bearer)).send({ name: 'G' })).body.id as string
    const otherGroup = (await app().post(`/api/task-lists/${other}/groups`).set(auth(owner.bearer)).send({ name: 'O' })).body.id as string
    const personal = await seedUserGroup(orgId, owner.userId, TASK_DEFAULT_GROUP_NAME, 0, true)
    const foreignList = await seedList(otherOrg, owner.userId, [[owner.userId, 'owner']])
    const foreignGroup = await seedListGroup(otherOrg, foreignList, 'F', 1)
    const taskId = await itemTask(orgId, owner, listId)
    await seedItem(other, taskId, orgId)
    const before = await orgState(orgId)
    const invalidGroup: unknown[] = [
      {}, { position: 0 }, { groupId: 7, position: 0 }, { groupId: '', position: 0 }, { groupId: ['x'], position: 0 },
      { groupId: 'tgrp_\u0000', position: 0 }, { groupId: `tgrp_missing${stamp}`, position: 0 },
      { groupId: otherGroup, position: 0 }, { groupId: await defaultGroupOf(other), position: 0 }, { groupId: personal, position: 0 },
      { groupId: foreignGroup, position: 0 }, { groupId: otherGroup, position: -1 }, { groupId: 7, position: 'x' }, [{ groupId: null, position: 0 }],
    ]
    for (const body of invalidGroup) {
      const response = await place(listId, taskId, owner.bearer, body)
      expect(response.status, JSON.stringify(body)).toBe(422)
      expect(response.body).toEqual({ error: { code: 'INVALID_GROUP' } })
    }
    for (const body of [
      { groupId: group }, { groupId: group, position: null }, { groupId: group, position: -1 }, { groupId: group, position: 1 },
      { groupId: group, position: 1.5 }, { groupId: group, position: '0' }, { groupId: null, position: true },
      { groupId: null, position: 9007199254740992 },
    ]) {
      const response = await place(listId, taskId, owner.bearer, body)
      expect(response.status, JSON.stringify(body)).toBe(422)
      expect(response.body).toEqual({ error: { code: 'INVALID_POSITION' } })
    }
    expect(await orgState(orgId)).toBe(before)
    expect((await place(listId, taskId, owner.bearer, { groupId: group, position: 0 })).status).toBe(200)
  })

  it('groups|placements: by group id in byte order, then the dense index numbered before the page is cut; total counts visible rows only; another list holding the same task never shows', async () => {
    const stamp = stampOf()
    const orgId = orgOf('pl', stamp)
    const owner = await actor('plowner', stamp, orgId)
    const reader = await actor('plread', stamp, orgId)
    // Byte order puts tgrp_B before tgrp_a before tgrp_c; a locale compare gives a, B, c.
    const listId = await seedList(orgId, owner.userId, [[owner.userId, 'owner'], [reader.userId, 'read']], { defaultId: `tgrp_c${stamp}` })
    const gB = await seedListGroup(orgId, listId, 'B', 1, `tgrp_B${stamp}`)
    const ga = await seedListGroup(orgId, listId, 'a', 2, `tgrp_a${stamp}`)
    const tasks: string[] = []
    for (let i = 0; i < 6; i += 1) tasks.push(await itemTask(orgId, owner, listId, `任务${i}`))
    // Ids in descending byte order, placed so that in each group the stored order runs against the
    // id order: an order by task id alone never gives the expected indexes.
    const [t1, h, t2, t3, t4, t5] = [...tasks].sort().reverse()
    await seedPlacement(ga, t1, orgId, 0)
    await seedPlacement(ga, h, orgId, 1)
    await seedPlacement(ga, t2, orgId, 2)
    await seedPlacement(gB, t3, orgId, 5)
    await seedPlacement(gB, t4, orgId, 9)
    await seedPlacement(`tgrp_c${stamp}`, t5, orgId, 0)
    await db().query(`UPDATE tasks SET deleted_at = now() WHERE id = $1`, [h])
    const other = await seedList(orgId, owner.userId, [[owner.userId, 'owner'], [reader.userId, 'read']], { taskIds: [t1] })
    await seedPlacement(await defaultGroupOf(other), t1, orgId, 0)
    const expected: Array<[string, string, number]> = [[gB, t3, 0], [gB, t4, 1], [ga, t1, 0], [ga, t2, 1], [`tgrp_c${stamp}`, t5, 0]]
    expect(await readPlacements(listId, reader.bearer)).toEqual({ rows: expected, total: 5 })
    const first = await readPlacements(listId, reader.bearer, '?limit=3')
    const second = await readPlacements(listId, reader.bearer, '?limit=3&offset=3')
    expect(first).toEqual({ rows: expected.slice(0, 3), total: 5 })
    // The second page starts inside group a: t2 keeps index 1.
    expect(second).toEqual({ rows: expected.slice(3), total: 5 })
    expect(await readPlacements(listId, reader.bearer, '?offset=5')).toEqual({ rows: [], total: 5 })
    expect(await readPlacements(other, reader.bearer)).toEqual({ rows: [[await defaultGroupOf(other), t1, 0]], total: 1 })
    const outsider = await actor('plout', stamp, orgId)
    for (const query of ['', '?limit=0']) {
      const hidden = await app().get(`/api/task-lists/${listId}/group-items${query}`).set(auth(outsider.bearer))
      const missing = await app().get(`/api/task-lists/tlst_missing${stamp}/group-items${query}`).set(auth(outsider.bearer))
      expect(hidden.status).toBe(404)
      expect(hidden.text).toBe(missing.text)
    }
    expect((await app().get(`/api/task-lists/${listId}/group-items?limit=101`).set(auth(reader.bearer))).body).toEqual({ error: { code: 'INVALID_LIMIT' } })
  })
})

// ---------------------------------------------------------------------------------------------
// Personal scope
// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// Archived lists (design §3.2): archiving changes only the default filter of GET /api/task-lists,
// so the six list-scope group routes answer an archived list as they answer a live one.
// ---------------------------------------------------------------------------------------------

describe('archived list', () => {
  it('groups|archived: on an archived list the group read, create, rename, place, placement read and delete answer exactly as on a live list (statuses, bodies without ids, group rows, placements, group events), and the list row keeps its archived instant', async () => {
    const stamp = stampOf()
    const orgId = orgOf('arch', stamp)
    const owner = await actor('archowner', stamp, orgId)
    const editor = await actor('archedit', stamp, orgId)
    const reader = await actor('archread', stamp, orgId)
    const live = await listVia(owner, [[editor.userId, 'edit'], [reader.userId, 'read']])
    const archived = await listVia(owner, [[editor.userId, 'edit'], [reader.userId, 'read']])
    const liveTask = await itemTask(orgId, owner, live)
    const archivedTask = await itemTask(orgId, owner, archived)
    const archiving = await app().post(`/api/task-lists/${archived}/archive`).set(auth(owner.bearer))
    expect(archiving.status).toBe(200)
    expect(typeof archiving.body.archivedAt).toBe('string')
    const listRowOf = async (listId: string) =>
      (await db().query(`SELECT archived_at, updated_at FROM task_lists WHERE id = $1`, [listId])).rows[0]
    const archivedRow = await listRowOf(archived)

    /** One pass over the six routes. Ids are replaced by names so the two lists compare. */
    const pass = async (listId: string, taskId: string): Promise<Array<{ step: string; status: number; body: unknown }>> => {
      const names = new Map<string, string>([[listId, '<list>'], [taskId, '<task>'], [await defaultGroupOf(listId), '<default>']])
      const anonymize = (value: unknown): unknown => {
        if (typeof value === 'string') return names.get(value) ?? value
        if (Array.isArray(value)) return value.map(anonymize)
        if (value && typeof value === 'object') {
          return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, inner]) => [key, anonymize(inner)]))
        }
        return value
      }
      const answers: Array<{ step: string; status: number; body: unknown }> = []
      const record = async (step: string, method: Method, path: string, bearer: string, body?: unknown) => {
        const response = await send(method, path, bearer, body)
        const parsed = JSON.parse(response.text) as Record<string, unknown>
        if (step.includes('creates') && typeof parsed.id === 'string') names.set(parsed.id, `<${step}>`)
        answers.push({ step, status: response.status, body: anonymize(parsed) })
        return parsed
      }
      await record('read member reads the groups', 'get', `/api/task-lists/${listId}/groups`, reader.bearer)
      const created = await record('edit member creates', 'post', `/api/task-lists/${listId}/groups`, editor.bearer, { name: '待办' })
      await record('read member creates', 'post', `/api/task-lists/${listId}/groups`, reader.bearer, { name: '只读' })
      await record('owner renames', 'patch', `/api/task-lists/${listId}/groups/${String(created.id)}`, owner.bearer, { name: '进行中' })
      await record('edit member places the item', 'put', `/api/task-lists/${listId}/group-items/${taskId}`, editor.bearer, { groupId: created.id, position: 0 })
      await record('read member reads the placements', 'get', `/api/task-lists/${listId}/group-items`, reader.bearer)
      await record('owner deletes the group', 'delete', `/api/task-lists/${listId}/groups/${String(created.id)}`, owner.bearer)
      await record('read member reads the groups again', 'get', `/api/task-lists/${listId}/groups`, reader.bearer)
      await record('read member reads the placements again', 'get', `/api/task-lists/${listId}/group-items`, reader.bearer)
      return answers
    }
    const livePass = await pass(live, liveTask)
    const archivedPass = await pass(archived, archivedTask)
    expect(livePass.map((answer) => answer.status)).toEqual([200, 200, 404, 200, 200, 200, 200, 200, 200])
    expect(archivedPass).toEqual(livePass)

    const shapeOf = async (listId: string, taskId: string) => {
      const groups = (await listGroupRows(listId)).map((row) => [row.name, row.position, row.is_default])
      const placements = (await db().query(
        `SELECT g.name, gi.position FROM task_group_items gi JOIN task_groups g ON g.id = gi.group_id WHERE g.list_id = $1 AND gi.task_id = $2`,
        [listId, taskId],
      )).rows.map((row) => [row.name, Number(row.position)])
      const events = (await groupEvents(listId)).map((event) => {
        const [actorId, type] = event as [string, string, unknown]
        return [actorId, type]
      })
      return { groups, placements, events, changed: (await changedEvents(taskId)).length }
    }
    expect(await shapeOf(archived, archivedTask)).toEqual(await shapeOf(live, liveTask))
    expect((await shapeOf(live, liveTask)).events).toEqual([
      [editor.userId, 'group_created'], [owner.userId, 'group_renamed'], [owner.userId, 'group_deleted'],
    ])

    // Group writes leave the list row alone: still archived, same instants.
    expect(await listRowOf(archived)).toEqual(archivedRow)
  })
})

describe('personal groups', () => {
  it('groups|personal synthetic: without rows the user sees exactly the default group with a null id and total 1, and reading writes nothing; another user\'s groups never show', async () => {
    const stamp = stampOf()
    const orgId = orgOf('syn', stamp)
    const me = await actor('syn', stamp, orgId)
    const neighbour = await actor('synnb', stamp, orgId)
    expect((await app().post('/api/task-groups').set(auth(neighbour.bearer)).send({ name: '邻居' })).status).toBe(200)
    const synthetic = { id: null, scope: 'user', name: TASK_DEFAULT_GROUP_NAME, position: 0, isDefault: true }
    const read = await app().get('/api/task-groups').set(auth(me.bearer))
    expect(read.status).toBe(200)
    expect(read.body).toEqual({ items: [synthetic], total: 1 })
    expect((await app().get('/api/task-groups?limit=1').set(auth(me.bearer))).body).toEqual({ items: [synthetic], total: 1 })
    expect((await app().get('/api/task-groups?offset=1').set(auth(me.bearer))).body).toEqual({ items: [], total: 1 })
    expect(await readMine(me.bearer)).toEqual({ rows: [], total: 0 })
    expect(await userGroupRows(orgId, me.userId)).toEqual([])
    expect((await app().get('/api/task-groups?limit=0').set(auth(me.bearer))).body).toEqual({ error: { code: 'INVALID_LIMIT' } })
    expect((await app().get('/api/task-groups/items?offset=-1').set(auth(me.bearer))).body).toEqual({ error: { code: 'INVALID_OFFSET' } })
    const theirs = await app().get('/api/task-groups').set(auth(neighbour.bearer))
    expect(theirs.body.total).toBe(2)
    expect(theirs.body.items.map((group: { name: string }) => group.name)).toEqual([TASK_DEFAULT_GROUP_NAME, '邻居'])
  })

  it('groups|personal paging: with more groups than the limit, limit=1 pages are one group each, disjoint and in order, and limit=2 with offset=2 gives the rest; the total stays 3 (RULED(2026-10-07): [R15])', async () => {
    const stamp = stampOf()
    const orgId = orgOf('ppg', stamp)
    const me = await actor('ppg', stamp, orgId)
    for (const name of ['本周', '下周']) {
      expect((await app().post('/api/task-groups').set(auth(me.bearer)).send({ name })).status).toBe(200)
    }
    const all = await app().get('/api/task-groups').set(auth(me.bearer))
    expect(all.status).toBe(200)
    expect(all.body.total).toBe(3)
    const items = all.body.items as Array<{ id: string; name: string }>
    expect(items.map((group) => group.name)).toEqual([TASK_DEFAULT_GROUP_NAME, '本周', '下周'])
    const pages: unknown[] = []
    for (const offset of [0, 1, 2]) {
      const page = await app().get(`/api/task-groups?limit=1&offset=${offset}`).set(auth(me.bearer))
      expect(page.status).toBe(200)
      expect(page.body.total).toBe(3)
      expect(page.body.items).toHaveLength(1)
      pages.push(page.body.items[0])
    }
    expect(pages).toEqual(items)
    expect((await app().get('/api/task-groups?limit=2').set(auth(me.bearer))).body).toEqual({ items: items.slice(0, 2), total: 3 })
    expect((await app().get('/api/task-groups?limit=2&offset=2').set(auth(me.bearer))).body).toEqual({ items: items.slice(2), total: 3 })
  })

  it('groups|personal first write: PUT { groupId: null } writes the default row and the placement at one instant and answers the real id; a refused first write leaves no row; nothing for list or task events', async () => {
    const stamp = stampOf()
    const orgId = orgOf('fw', stamp)
    const creator = await actor('fwcr', stamp, orgId)
    const me = await actor('fw', stamp, orgId)
    const taskId = await newTask(orgId, creator.userId, [me.userId])
    const refused = await placeMine(taskId, me.bearer, { groupId: null, position: 1 })
    expect(refused.status).toBe(422)
    expect(refused.body).toEqual({ error: { code: 'INVALID_POSITION' } })
    expect(await userGroupRows(orgId, me.userId)).toEqual([])

    const placed = await placeMine(taskId, me.bearer, { groupId: null, position: 0 })
    expect(placed.status).toBe(200)
    expect(placed.body).toEqual({ taskId, groupId: expect.stringMatching(/^tgrp_/), position: 0 })
    const groupId = placed.body.groupId as string
    expect(await userGroupRows(orgId, me.userId)).toEqual([{ id: groupId, name: TASK_DEFAULT_GROUP_NAME, position: 0, is_default: true }])
    const instant = await db().query(
      `SELECT g.created_at = gi.created_at AS same, g.created_at = g.updated_at AS row_same, g.org_id, gi.org_id AS item_org
         FROM task_groups g JOIN task_group_items gi ON gi.group_id = g.id WHERE g.id = $1`,
      [groupId],
    )
    expect(instant.rows).toEqual([{ same: true, row_same: true, org_id: orgId, item_org: orgId }])
    expect((await app().get('/api/task-groups').set(auth(me.bearer))).body).toEqual({
      items: [{ id: groupId, scope: 'user', name: TASK_DEFAULT_GROUP_NAME, position: 0, isDefault: true }],
      total: 1,
    })
    expect(await readMine(me.bearer)).toEqual({ rows: [[groupId, taskId, 0]], total: 1 })
    expect(await changedEvents(taskId)).toEqual([])
  })

  it('groups|personal create: the first POST writes the default group at 0 and the new group at 1 at one instant; later groups append; 50 counting the default, then 422 LIMIT; no list events', async () => {
    const stamp = stampOf()
    const orgId = orgOf('pc', stamp)
    const me = await actor('pc', stamp, orgId)
    const before = await db().query(`SELECT count(*)::int AS n FROM task_list_events`)
    const first = await app().post('/api/task-groups').set(auth(me.bearer)).send({ name: ' 本周 ' })
    expect(first.status).toBe(200)
    expect(first.body).toEqual({ id: expect.stringMatching(/^tgrp_/), scope: 'user', name: '本周', position: 1, isDefault: false })
    const rows = await userGroupRows(orgId, me.userId)
    expect(rows.map((row) => [row.name, row.position, row.is_default])).toEqual([[TASK_DEFAULT_GROUP_NAME, 0, true], ['本周', 1, false]])
    const instant = await db().query(
      `SELECT count(DISTINCT created_at)::int AS n, bool_and(created_at = updated_at) AS same FROM task_groups WHERE org_id = $1 AND user_id = $2`,
      [orgId, me.userId],
    )
    expect(instant.rows).toEqual([{ n: 1, same: true }])
    const second = await app().post('/api/task-groups').set(auth(me.bearer)).send({ name: '下周' })
    expect(second.body.position).toBe(2)
    expect(await userGroupRows(orgId, me.userId)).toHaveLength(3)
    for (let position = 3; position < TASK_GROUPS_PER_SCOPE_SOFT_LIMIT; position += 1) {
      await seedUserGroup(orgId, me.userId, `G${position}`, position, false)
    }
    const state = await orgState(orgId)
    const refused = await app().post('/api/task-groups').set(auth(me.bearer)).send({ name: '多一个' })
    expect(refused.status).toBe(422)
    expect(refused.body).toEqual({ error: { code: 'LIMIT' } })
    for (const [body, code] of [
      [{}, 'INVALID_NAME'], [{ name: '' }, 'INVALID_NAME'], [{ name: '分\u0000组' }, 'INVALID_NAME'], [{ name: 'a'.repeat(101) }, 'NAME_TOO_LONG'],
    ] as const) {
      const bad = await app().post('/api/task-groups').set(auth(me.bearer)).send(body)
      expect(bad.status).toBe(422)
      expect(bad.body).toEqual({ error: { code } })
    }
    expect(await orgState(orgId)).toBe(state)
    expect((await db().query(`SELECT count(*)::int AS n FROM task_list_events`)).rows).toEqual(before.rows)
  })

  // The design's concurrent first write: both requests queue on the structure lock, then run one
  // after the other; the second finds the default row the first wrote.
  it('groups|personal concurrent first write: a POST and a PUT { groupId: null } queued together on the structure lock both answer 200; exactly one default row', async () => {
    const stamp = stampOf()
    const orgId = orgOf('cc', stamp)
    const me = await actor('cc', stamp, orgId)
    const taskId = await newTask(orgId, me.userId, [me.userId])
    const { result } = await whileStructureLockHeld(orgId, () => Promise.all([
      app().post('/api/task-groups').set(auth(me.bearer)).send({ name: '并发' }).then((res) => res),
      placeMine(taskId, me.bearer, { groupId: null, position: 0 }).then((res) => res),
    ]), undefined, 2)
    const [created, placed] = result
    expect(created.status).toBe(200)
    expect(placed.status).toBe(200)
    const rows = await userGroupRows(orgId, me.userId)
    expect(rows.filter((row) => row.is_default)).toEqual([{ id: placed.body.groupId, name: TASK_DEFAULT_GROUP_NAME, position: 0, is_default: true }])
    expect(created.body.position).toBe(1)
    expect(rows.map((row) => row.id)).toEqual([placed.body.groupId, created.body.id])
  }, 60000)

  it('groups|personal visible set: rows of tasks no longer assigned to the user are left out and follow the visible rows on the next write; reassigned, the task comes back last; another user\'s placements of the same task never show', async () => {
    const stamp = stampOf()
    const orgId = orgOf('pv', stamp)
    const creator = await actor('pvcr', stamp, orgId)
    const me = await actor('pv', stamp, orgId)
    const neighbour = await actor('pvnb', stamp, orgId)
    const t1 = await newTask(orgId, creator.userId, [me.userId, neighbour.userId], 'T1')
    const t2 = await newTask(orgId, creator.userId, [me.userId, creator.userId], 'T2')
    const t3 = await newTask(orgId, creator.userId, [me.userId], 'T3')
    const t4 = await newTask(orgId, creator.userId, [me.userId], 'T4')
    for (const [taskId, position] of [[t1, 0], [t2, 1], [t3, 2]] as const) {
      expect((await placeMine(taskId, me.bearer, { groupId: null, position })).status).toBe(200)
    }
    const mine = (await userGroupRows(orgId, me.userId))[0].id as string
    const theirs = (await app().post('/api/task-groups').set(auth(neighbour.bearer)).send({ name: '邻居的' })).body.id as string
    expect((await placeMine(t1, neighbour.bearer, { groupId: theirs, position: 0 })).status).toBe(200)
    expect(await readMine(me.bearer)).toEqual({ rows: [[mine, t1, 0], [mine, t2, 1], [mine, t3, 2]], total: 3 })

    expect((await app().delete(`/api/tasks/${t2}/assignees/${me.userId}`).set(auth(creator.bearer))).status).toBe(200)
    expect(await readMine(me.bearer)).toEqual({ rows: [[mine, t1, 0], [mine, t3, 1]], total: 2 })
    // The row stays (R11: no cascade); only reads and writes leave it out.
    expect(await stored(mine)).toEqual([[t1, 0], [t2, 1], [t3, 2]])
    expect((await placeMine(t4, me.bearer, { groupId: null, position: 2 })).body).toEqual({ taskId: t4, groupId: mine, position: 2 })
    expect(await readMine(me.bearer)).toEqual({ rows: [[mine, t1, 0], [mine, t3, 1], [mine, t4, 2]], total: 3 })
    expect(await stored(mine)).toEqual([[t1, 0], [t3, 1], [t4, 2], [t2, 3]])
    const notAssigned = await placeMine(t2, me.bearer, { groupId: null, position: 0 })
    expect(notAssigned.status).toBe(404)
    expect(notAssigned.text).toBe(NOT_FOUND_TEXT)

    expect((await app().post(`/api/tasks/${t2}/assignees`).set(auth(creator.bearer)).send({ userId: me.userId })).status).toBe(200)
    expect(await readMine(me.bearer)).toEqual({ rows: [[mine, t1, 0], [mine, t3, 1], [mine, t4, 2], [mine, t2, 3]], total: 4 })
    expect(await readMine(neighbour.bearer)).toEqual({ rows: [[theirs, t1, 0]], total: 1 })
    // Personal moves write no event.
    for (const taskId of [t1, t2, t3, t4]) expect(await changedEvents(taskId)).toEqual([])
  })

  it('groups|personal rename and delete: own groups only; the default renames once it has a row and is 422 IS_DEFAULT on delete; a delete sends its tasks back to the default group and renumbers the rest; another user\'s groups keep their positions; no events', async () => {
    const stamp = stampOf()
    const orgId = orgOf('prd', stamp)
    const me = await actor('prd', stamp, orgId)
    const neighbour = await actor('prdnb', stamp, orgId)
    const taskId = await newTask(orgId, me.userId, [me.userId])
    const a = (await app().post('/api/task-groups').set(auth(me.bearer)).send({ name: 'A' })).body
    const b = (await app().post('/api/task-groups').set(auth(me.bearer)).send({ name: 'B' })).body
    const defaultId = (await userGroupRows(orgId, me.userId))[0].id as string
    for (const name of ['X', 'Y']) expect((await app().post('/api/task-groups').set(auth(neighbour.bearer)).send({ name })).status).toBe(200)
    const neighbourBefore = await userGroupRows(orgId, neighbour.userId)
    expect((await placeMine(taskId, me.bearer, { groupId: a.id, position: 0 })).status).toBe(200)

    const renamed = await app().patch(`/api/task-groups/${defaultId}`).set(auth(me.bearer)).send({ name: '收件箱' })
    expect(renamed.status).toBe(200)
    expect(renamed.body).toEqual({ id: defaultId, scope: 'user', name: '收件箱', position: 0, isDefault: true })
    const renamedA = await app().patch(`/api/task-groups/${a.id}`).set(auth(me.bearer)).send({ name: '甲' })
    expect(renamedA.body).toEqual({ ...a, name: '甲' })
    const sameName = await app().patch(`/api/task-groups/${a.id}`).set(auth(me.bearer)).send({ name: '甲' })
    expect(sameName.body).toEqual({ ...a, name: '甲' })

    // Another user's group is the 404 of a missing group, before the name.
    const state = await orgState(orgId)
    const missing = await send('patch', `/api/task-groups/tgrp_missing${stamp}`, neighbour.bearer, { name: 'x' })
    expect(missing.text).toBe(NOT_FOUND_TEXT)
    for (const [method, body] of [['patch', { name: '抢' }], ['patch', { name: '' }], ['delete', undefined]] as const) {
      const response = await send(method, `/api/task-groups/${a.id}`, neighbour.bearer, body)
      expect(response.status).toBe(404)
      expect(response.text).toBe(missing.text)
    }
    for (const path of ['/api/task-groups/tgrp_%00', '/api/task-groups/.', '/api/task-groups/..', '/api/task-groups/null']) {
      const response = await send('patch', path, me.bearer, { name: 'x' })
      expect(response.status, path).toBe(404)
    }
    const badName = await app().patch(`/api/task-groups/${a.id}`).set(auth(me.bearer)).send({ name: ' ' })
    expect(badName.body).toEqual({ error: { code: 'INVALID_NAME' } })
    const isDefault = await app().delete(`/api/task-groups/${defaultId}`).set(auth(me.bearer))
    expect(isDefault.status).toBe(422)
    expect(isDefault.body).toEqual({ error: { code: 'IS_DEFAULT' } })
    expect(await orgState(orgId)).toBe(state)

    const deleted = await app().delete(`/api/task-groups/${a.id}`).set(auth(me.bearer))
    expect(deleted.status).toBe(200)
    expect(deleted.body).toEqual({ id: a.id, deleted: true, reassignedTo: defaultId })
    expect((await userGroupRows(orgId, me.userId)).map((row) => [row.id, row.position])).toEqual([[defaultId, 0], [b.id, 1]])
    expect(await readMine(me.bearer)).toEqual({ rows: [], total: 0 })
    expect(await userGroupRows(orgId, neighbour.userId)).toEqual(neighbourBefore)
    const gone = await app().delete(`/api/task-groups/${a.id}`).set(auth(me.bearer))
    expect(gone.status).toBe(404)
    expect(await changedEvents(taskId)).toEqual([])
  })

  it('groups|personal place: a task not on the caller\'s assigned arm (created only, followed, another user\'s, deleted, another org\'s, missing) is the same 404; a group of another user, of a list, or of the caller in another org is 422 INVALID_GROUP; nothing written', async () => {
    const stamp = stampOf()
    const orgId = orgOf('pp', stamp)
    const otherOrg = orgOf('ppB', stamp)
    const me = await actor('pp', stamp, orgId)
    const neighbour = await actor('ppnb', stamp, orgId)
    await db().query('INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)', [me.userId, otherOrg])
    const createdOnly = await newTask(orgId, me.userId, [neighbour.userId], '只是创建人')
    const followed = await newTask(orgId, neighbour.userId, [neighbour.userId], '关注')
    await db().query(`INSERT INTO task_followers (task_id, user_id) VALUES ($1, $2)`, [followed, me.userId])
    const theirs = await newTask(orgId, neighbour.userId, [neighbour.userId], '别人的')
    const deleted = await newTask(orgId, me.userId, [me.userId], '已删除')
    await db().query(`UPDATE tasks SET deleted_at = now() WHERE id = $1`, [deleted])
    const elsewhere = await newTask(otherOrg, me.userId, [me.userId], '他 org')
    const mine = await newTask(orgId, neighbour.userId, [me.userId], '我负责的')
    const neighbourGroup = await seedUserGroup(orgId, neighbour.userId, TASK_DEFAULT_GROUP_NAME, 0, true)
    const listId = await listVia(me)
    const listGroup = await defaultGroupOf(listId)
    const myOtherOrgGroup = await seedUserGroup(otherOrg, me.userId, TASK_DEFAULT_GROUP_NAME, 0, true)
    const before = await orgState(orgId)
    for (const taskId of [createdOnly, followed, theirs, deleted, elsewhere, `tsk_missing_${stamp}`, 'tsk%00x', '..']) {
      const response = await send('put', `/api/task-groups/items/${taskId}`, me.bearer, { groupId: null, position: 0 })
      expect(response.status, taskId).toBe(404)
      expect(response.text).toBe(NOT_FOUND_TEXT)
    }
    for (const groupId of [neighbourGroup, listGroup, myOtherOrgGroup, `tgrp_missing${stamp}`]) {
      const response = await placeMine(mine, me.bearer, { groupId, position: 0 })
      expect(response.status, groupId).toBe(422)
      expect(response.body).toEqual({ error: { code: 'INVALID_GROUP' } })
    }
    expect(await orgState(orgId)).toBe(before)
    expect((await placeMine(mine, me.bearer, { groupId: null, position: 0 })).status).toBe(200)
  })

  // §10.4 personal second tenant, and negative control 5 below.
  it('m4list|personal second tenant: with the org A token the user sees and writes only the org A groups and placements; the org B group is 404 on PATCH and DELETE and 422 as a target; the org B token sees org B', async () => {
    const stamp = stampOf()
    const orgA = orgOf('pstA', stamp)
    const orgB = orgOf('pstB', stamp)
    const me = await actor('pst', stamp, orgA)
    await db().query('INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)', [me.userId, orgB])
    const bearerB = signTaskToken(me.userId, me.roleId, orgB)
    const taskA = await newTask(orgA, me.userId, [me.userId], 'A')
    const taskB = await newTask(orgB, me.userId, [me.userId], 'B')
    const groupA = (await app().post('/api/task-groups').set(auth(me.bearer)).send({ name: '同名' })).body
    const groupB = (await app().post('/api/task-groups').set(auth(bearerB)).send({ name: '同名' })).body
    expect((await placeMine(taskA, me.bearer, { groupId: groupA.id, position: 0 })).status).toBe(200)
    expect((await placeMine(taskB, bearerB, { groupId: groupB.id, position: 0 })).status).toBe(200)
    const defaultA = (await userGroupRows(orgA, me.userId))[0].id
    const defaultB = (await userGroupRows(orgB, me.userId))[0].id

    const listA = await app().get('/api/task-groups').set(auth(me.bearer))
    expect(listA.body.items.map((group: { id: string }) => group.id)).toEqual([defaultA, groupA.id])
    expect(listA.body.total).toBe(2)
    expect(await readMine(me.bearer)).toEqual({ rows: [[groupA.id, taskA, 0]], total: 1 })
    const before = await orgState(orgB)
    const missing = await send('patch', `/api/task-groups/tgrp_missing${stamp}`, me.bearer, { name: '同名' })
    for (const [method, path, body] of [
      ['patch', `/api/task-groups/${groupB.id}`, { name: '同名' }],
      ['patch', `/api/task-groups/${groupB.id}`, { name: '改名' }],
      ['delete', `/api/task-groups/${groupB.id}`, undefined],
      ['delete', `/api/task-groups/${defaultB}`, undefined],
    ] as Array<[Method, string, unknown]>) {
      const response = await send(method, path, me.bearer, body)
      expect(response.status, `${method} ${path}`).toBe(404)
      expect(response.text).toBe(missing.text)
    }
    const target = await placeMine(taskA, me.bearer, { groupId: groupB.id, position: 0 })
    expect(target.status).toBe(422)
    expect(target.body).toEqual({ error: { code: 'INVALID_GROUP' } })
    expect(await orgState(orgB)).toBe(before)
    const listB = await app().get('/api/task-groups').set(auth(bearerB))
    expect(listB.body.items.map((group: { id: string }) => group.id)).toEqual([defaultB, groupB.id])
    expect(await readMine(bearerB)).toEqual({ rows: [[groupB.id, taskB, 0]], total: 1 })
  })

  it('negative control 5: an always-true group org clause lets the org A token list the org B personal group and find it by id', async () => {
    const stamp = stampOf()
    const orgA = orgOf('nc5A', stamp)
    const orgB = orgOf('nc5B', stamp)
    const me = await actor('nc5', stamp, orgA)
    await db().query('INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)', [me.userId, orgB])
    const groupB = (await app().post('/api/task-groups').set(auth(signTaskToken(me.userId, me.roleId, orgB))).send({ name: 'B组' })).body
    const listed = await app().get('/api/task-groups').set(auth(me.bearer))
    expect(listed.body).toEqual({ items: [{ id: null, scope: 'user', name: TASK_DEFAULT_GROUP_NAME, position: 0, isDefault: true }], total: 1 })
    expect((await app().patch(`/api/task-groups/${groupB.id}`).set(auth(me.bearer)).send({ name: 'B组' })).status).toBe(404)
    runSourceMutant(LIST_ACCESS_FILE, '(task_groups.org_id = ${ORG_PLACEHOLDER}) AND ', '(${ORG_PLACEHOLDER}::text IS NOT NULL) AND ', `
      process.env.TASKS_ENABLED = 'true'
      const express = (await import(${JSON.stringify(EXPRESS_PATH)})).default
      const request = (await import(${JSON.stringify(SUPERTEST_PATH)})).default
      const { tasksRouter } = await import(${JSON.stringify(ROUTES_FILE)})
      const server = express()
      server.use(express.json())
      server.use(tasksRouter())
      const bearer = 'Bearer ' + ${JSON.stringify(me.bearer)}
      const listed = await request(server).get('/api/task-groups').set('Authorization', bearer)
      const ids = (listed.body.items ?? []).map((group) => group.id)
      // The same name: found, a no-op, nothing written.
      const found = await request(server).patch('/api/task-groups/' + ${JSON.stringify(groupB.id)}).set('Authorization', bearer).send({ name: 'B组' })
      console.log(JSON.stringify({ nc5: 'red', ids, found: found.status }))
      process.exit(ids.includes(${JSON.stringify(groupB.id)}) && found.status === 200 ? 0 : 1)
    `, {}, { unique: true })
    expect((await userGroupRows(orgB, me.userId)).map((row) => row.name)).toEqual([TASK_DEFAULT_GROUP_NAME, 'B组'])
  }, 180000)
})

// ---------------------------------------------------------------------------------------------
// Permission codes and a missing org claim
// ---------------------------------------------------------------------------------------------

describe('permission codes and missing org', () => {
  interface Ctx {
    orgId: string
    listId: string
    group: string
    taskId: string
    mineGroup: Record<string, string>
  }
  type CodeRoute = {
    label: string
    code: 'read' | 'write'
    call: (ctx: Ctx, who: SeededTaskActor) => { method: Method; path: string; body?: Record<string, unknown> }
  }
  const CODE_ROUTES: CodeRoute[] = [
    { label: 'GET /api/task-lists/:id/groups', code: 'read', call: (ctx) => ({ method: 'get', path: `/api/task-lists/${ctx.listId}/groups` }) },
    { label: 'POST /api/task-lists/:id/groups', code: 'write', call: (ctx) => ({ method: 'post', path: `/api/task-lists/${ctx.listId}/groups`, body: { name: '新组' } }) },
    { label: 'PATCH /api/task-lists/:id/groups/:groupId', code: 'write', call: (ctx) => ({ method: 'patch', path: `/api/task-lists/${ctx.listId}/groups/${ctx.group}`, body: { name: '改名' } }) },
    { label: 'DELETE /api/task-lists/:id/groups/:groupId', code: 'write', call: (ctx) => ({ method: 'delete', path: `/api/task-lists/${ctx.listId}/groups/${ctx.group}` }) },
    { label: 'GET /api/task-lists/:id/group-items', code: 'read', call: (ctx) => ({ method: 'get', path: `/api/task-lists/${ctx.listId}/group-items` }) },
    { label: 'PUT /api/task-lists/:id/group-items/:taskId', code: 'write', call: (ctx) => ({ method: 'put', path: `/api/task-lists/${ctx.listId}/group-items/${ctx.taskId}`, body: { groupId: ctx.group, position: 0 } }) },
    { label: 'GET /api/task-groups', code: 'read', call: () => ({ method: 'get', path: '/api/task-groups' }) },
    { label: 'POST /api/task-groups', code: 'write', call: () => ({ method: 'post', path: '/api/task-groups', body: { name: '新组' } }) },
    { label: 'GET /api/task-groups/items', code: 'read', call: () => ({ method: 'get', path: '/api/task-groups/items' }) },
    { label: 'PUT /api/task-groups/items/:taskId', code: 'write', call: (ctx) => ({ method: 'put', path: `/api/task-groups/items/${ctx.taskId}`, body: { groupId: null, position: 0 } }) },
    { label: 'PATCH /api/task-groups/:groupId', code: 'write', call: (ctx, who) => ({ method: 'patch', path: `/api/task-groups/${ctx.mineGroup[who.userId]}`, body: { name: '改名' } }) },
    { label: 'DELETE /api/task-groups/:groupId', code: 'write', call: (ctx, who) => ({ method: 'delete', path: `/api/task-groups/${ctx.mineGroup[who.userId]}` }) },
  ]

  it.each(CODE_ROUTES)('groups|codes: $label needs tasks:$code; the other code alone is 403 and nothing is written', async (route) => {
    const stamp = stampOf()
    const orgId = orgOf('codes', stamp)
    const owner = await actor('codesowner', stamp, orgId)
    const wrong = await actor('codeswrong', stamp, orgId, [route.code === 'write' ? 'tasks:read' : 'tasks:write'])
    const right = await actor('codesright', stamp, orgId, [`tasks:${route.code}`])
    const listId = await listVia(owner, [[wrong.userId, 'edit'], [right.userId, 'edit']])
    const group = (await app().post(`/api/task-lists/${listId}/groups`).set(auth(owner.bearer)).send({ name: '组' })).body.id as string
    // Each caller is an assignee of the task, an item of the list.
    const taskId = await newTask(orgId, owner.userId, [owner.userId, wrong.userId, right.userId])
    await seedItem(listId, taskId, orgId)
    const mineGroup: Record<string, string> = {}
    for (const who of [wrong, right]) {
      await seedUserGroup(orgId, who.userId, TASK_DEFAULT_GROUP_NAME, 0, true)
      mineGroup[who.userId] = await seedUserGroup(orgId, who.userId, '我的', 1, false)
    }
    const ctx: Ctx = { orgId, listId, group, taskId, mineGroup }
    const before = await orgState(orgId)
    const denied = route.call(ctx, wrong)
    const refused = await send(denied.method, denied.path, wrong.bearer, denied.body)
    expect(refused.status).toBe(403)
    expect(JSON.parse(refused.text)).toEqual({ error: 'Insufficient permissions' })
    expect(await orgState(orgId)).toBe(before)
    const allowed = route.call(ctx, right)
    const response = await send(allowed.method, allowed.path, right.bearer, allowed.body)
    expect(response.status).toBe(200)
  })

  it('groups|no org: the eight writes are 422 ORG_MISSING, the two list-scope reads 404 and the two personal reads the degraded body without total; nothing written', async () => {
    const stamp = stampOf()
    const orgId = orgOf('noorg', stamp)
    const owner = await actor('noorg', stamp, orgId)
    const listId = await listVia(owner)
    const group = (await app().post(`/api/task-lists/${listId}/groups`).set(auth(owner.bearer)).send({ name: '组' })).body.id as string
    const taskId = await itemTask(orgId, owner, listId)
    const mine = (await app().post('/api/task-groups').set(auth(owner.bearer)).send({ name: '我的' })).body.id as string
    const bearer = tokenFor(owner, null)
    const before = await orgState(orgId)
    for (const [method, path, body] of [
      ['post', `/api/task-lists/${listId}/groups`, { name: '新组' }],
      ['post', `/api/task-lists/${listId}/groups`, {}],
      ['patch', `/api/task-lists/${listId}/groups/${group}`, { name: '改名' }],
      ['delete', `/api/task-lists/${listId}/groups/${group}`, undefined],
      ['put', `/api/task-lists/${listId}/group-items/${taskId}`, { groupId: null, position: 0 }],
      ['post', '/api/task-groups', { name: '新组' }],
      ['put', `/api/task-groups/items/${taskId}`, { groupId: 7 }],
      ['patch', `/api/task-groups/${mine}`, { name: '改名' }],
      ['delete', `/api/task-groups/${mine}`, undefined],
    ] as Array<[Method, string, unknown]>) {
      const response = await send(method, path, bearer, body)
      expect(response.status, `${method} ${path}`).toBe(422)
      expect(JSON.parse(response.text)).toEqual({ error: { code: 'ORG_MISSING' } })
    }
    for (const path of [`/api/task-lists/${listId}/groups`, `/api/task-lists/${listId}/group-items`]) {
      const response = await send('get', path, bearer)
      expect(response.status).toBe(404)
      expect(response.text).toBe(NOT_FOUND_TEXT)
    }
    for (const path of ['/api/task-groups', '/api/task-groups/items', '/api/task-groups?limit=0']) {
      const response = await send('get', path, bearer)
      expect(response.status).toBe(200)
      expect(JSON.parse(response.text)).toEqual(DEGRADED)
    }
    expect(await orgState(orgId)).toBe(before)
  })
})

// ---------------------------------------------------------------------------------------------
// Write instants (design §4.4, §4.5)
// ---------------------------------------------------------------------------------------------

describe('write instants', () => {
  it('groups|stamps: a list group create, rename, move and delete queued behind the structure lock are stamped after it; each row and its event share one reading', async () => {
    const stamp = stampOf()
    const orgId = orgOf('stmp', stamp)
    const me = await actor('stmp', stamp, orgId)
    const listId = await listVia(me)
    const taskId = await itemTask(orgId, me, listId)
    const created = await whileStructureLockHeld(orgId, () =>
      app().post(`/api/task-lists/${listId}/groups`).set(auth(me.bearer)).send({ name: '排队' }).then((res) => res))
    expect(created.result.status).toBe(200)
    const groupId = created.result.body.id as string
    expect(await groupStamps(groupId, 'group_created', created.holderAt)).toEqual({ later: true, event_same: true })

    const renamed = await whileStructureLockHeld(orgId, () =>
      app().patch(`/api/task-lists/${listId}/groups/${groupId}`).set(auth(me.bearer)).send({ name: '改名' }).then((res) => res))
    expect(renamed.result.status).toBe(200)
    expect(await groupStamps(groupId, 'group_renamed', renamed.holderAt)).toEqual({ later: true, event_same: true })

    const moved = await whileStructureLockHeld(orgId, () =>
      place(listId, taskId, me.bearer, { groupId, position: 0 }).then((res) => res))
    expect(moved.result.status).toBe(200)
    const move = await db().query(
      `SELECT gi.created_at > $3::timestamptz AS later,
              (SELECT occurred_at FROM task_events WHERE task_id = $1 AND event_type = 'group_changed') = gi.created_at AS event_same
         FROM task_group_items gi WHERE gi.group_id = $2 AND gi.task_id = $1`,
      [taskId, groupId, moved.holderAt],
    )
    expect(move.rows).toEqual([{ later: true, event_same: true }])

    const deleted = await whileStructureLockHeld(orgId, () =>
      app().delete(`/api/task-lists/${listId}/groups/${groupId}`).set(auth(me.bearer)).then((res) => res))
    expect(deleted.result.status).toBe(200)
    const gone = await db().query(
      `SELECT occurred_at > $2::timestamptz AS later FROM task_list_events WHERE list_id = $1 AND event_type = 'group_deleted'`,
      [listId, deleted.holderAt],
    )
    expect(gone.rows).toEqual([{ later: true }])
  }, 60000)
})
