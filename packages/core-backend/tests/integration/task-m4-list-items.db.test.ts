import '../helpers/assert-rbac-optional-off'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import jwt from 'jsonwebtoken'
import pg from 'pg'
import { poolManager } from '../../src/integration/db/connection-pool'
import { createTask } from '../../src/services/task-records'
import { newTaskListId } from '../../src/services/task-ids-runtime'
import { TASK_LISTS_PER_TASK_SOFT_LIMIT, type TaskListMemberRole } from '../../src/tasks/task-lists'
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
 * M4 PR-3a S7 (design task-m4-pr3a-backend-design-20260930.md §3.4, §4.3, §4.4, §5.5, §10.4 list
 * items). The items of a list: read, add a task, remove a task, and the `listIds` of a task detail.
 * RULED(2026-10-07): [R12] [own-25] (a1) adding a task takes the list's add_item and `edit` on the
 * task from a direct role (creator or assignee), never from list identity; (a2) the task's creator
 * may remove it from any list holding it without being a member, and the detail's `listIds` shows
 * the creator every list holding the task (anyone else: their own lists). ASSUMPTION(task-m4):
 * [own-09] every row-level failure is the 404 of a missing id. [own-43] the item read is 404 before
 * paging and without an org claim. [own-44] `taskId` is checked after the list's add_item. [own-45]
 * the removal's 404 is one answer for every failure. [own-46] `listIds` in byte order, same-org
 * lists only. [own-47] the per-task quota counts every list holding the task.
 * HTTP goes through `tasksRouter()` on one listener per file (tests/helpers/tasks-http-harness.ts;
 * setup.integration.ts, RBAC_TOKEN_TRUST='true'); paths whose bytes must reach the server exactly
 * as written go through `rawRequest`. What the routes cannot produce, or a cell does not exercise through them (lists
 * owned by a user without a token, items of another org, rows written past the foreign keys,
 * group items before S8), is seeded with SQL.
 */

if (process.env.EXPECT_DB !== '1') {
  throw new Error('task-m4-list-items.db.test.ts requires EXPECT_DB=1')
}

const ORG_PREFIX = 'org_tasks_m4litem_'
const seededUsers: string[] = []
const seededRoles: string[] = []

const req = createRequire(import.meta.url)
const EXPRESS_PATH = req.resolve('express')
const SUPERTEST_PATH = req.resolve('supertest')
const ROUTES_FILE = new URL('../../src/routes/tasks.ts', import.meta.url).pathname
const ACCESS_FILE = new URL('../../src/tasks/task-access.ts', import.meta.url).pathname

const NOT_FOUND_TEXT = JSON.stringify({ error: { code: 'NOT_FOUND' } })

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

/**
 * Paths whose bytes must reach the server exactly as written go through `rawRequest`; everything
 * else goes through the file's client.
 */
async function send(
  method: 'get' | 'post' | 'delete',
  path: string,
  bearer: string,
  body?: unknown,
): Promise<{ status: number; text: string; body: unknown }> {
  if (/\/\.\.?(\/|$)/.test(path)) return rawRequest(port(), method.toUpperCase(), path, bearer, body)
  const call = app()[method](path).set(auth(bearer))
  const response = body === undefined ? await call : await call.send(body as object)
  return { status: response.status, text: response.text, body: response.body }
}

async function seedList(
  orgId: string,
  createdBy: string,
  members: Array<[string, TaskListMemberRole]>,
  opts: { taskIds?: string[]; archived?: boolean; id?: string } = {},
): Promise<string> {
  const db = poolManager.get()
  const listId = opts.id ?? newTaskListId()
  await db.query(
    `INSERT INTO task_lists (id, org_id, name, created_by, archived_at)
     VALUES ($1, $2, '备料复核', $3, CASE WHEN $4::boolean THEN now() ELSE NULL END)`,
    [listId, orgId, createdBy, opts.archived === true],
  )
  for (const [userId, role] of members) {
    await db.query(`INSERT INTO task_list_members (list_id, user_id, role) VALUES ($1, $2, $3)`, [listId, userId, role])
  }
  for (const taskId of opts.taskIds ?? []) await seedItem(listId, taskId, orgId)
  return listId
}

async function seedItem(listId: string, taskId: string, orgId: string): Promise<void> {
  await poolManager.get().query(`INSERT INTO task_list_items (list_id, task_id, org_id) VALUES ($1, $2, $3)`, [listId, taskId, orgId])
}

async function addMember(listId: string, userId: string, role: TaskListMemberRole): Promise<void> {
  await poolManager.get().query(`INSERT INTO task_list_members (list_id, user_id, role) VALUES ($1, $2, $3)`, [listId, userId, role])
}

/** A list created through the route by `owner`, with the given members added by SQL. */
async function listVia(owner: SeededTaskActor, members: Array<[string, TaskListMemberRole]> = []): Promise<string> {
  const created = await app().post('/api/task-lists').set(auth(owner.bearer)).send({ name: '备料复核' })
  expect(created.status).toBe(200)
  for (const [userId, role] of members) await addMember(created.body.id, userId, role)
  return String(created.body.id)
}

async function newTask(orgId: string, creatorId: string, assignees: string[], title = '备料复核'): Promise<string> {
  return (await createTask({ orgId, creatorId, title, assignees, completionMode: 'all' })).id
}

async function itemRows(listId: string): Promise<string[]> {
  const result = await poolManager.get().query(`SELECT task_id FROM task_list_items WHERE list_id = $1 ORDER BY task_id COLLATE "C"`, [listId])
  return result.rows.map((row) => String(row.task_id))
}

/** Everything an item write can touch in one org, as one comparable string. */
async function orgState(orgId: string): Promise<string> {
  const db = poolManager.get()
  const items = await db.query(
    `SELECT list_id, task_id, org_id, created_at FROM task_list_items WHERE org_id = $1 ORDER BY list_id, task_id`,
    [orgId],
  )
  const lists = await db.query(`SELECT id, name, archived_at, updated_at FROM task_lists WHERE org_id = $1 ORDER BY id`, [orgId])
  const listEvents = await db.query(
    `SELECT e.id, e.list_id, e.actor_id, e.event_type, e.payload, e.occurred_at
       FROM task_list_events e JOIN task_lists l ON l.id = e.list_id WHERE l.org_id = $1 ORDER BY e.id`,
    [orgId],
  )
  const taskEvents = await db.query(
    `SELECT e.id, e.task_id, e.actor_id, e.event_type, e.payload, e.occurred_at
       FROM task_events e JOIN tasks t ON t.id = e.task_id WHERE t.org_id = $1 ORDER BY e.id`,
    [orgId],
  )
  const groupItems = await db.query(
    `SELECT group_id, task_id, position FROM task_group_items WHERE org_id = $1 ORDER BY group_id, task_id`,
    [orgId],
  )
  return JSON.stringify({ items: items.rows, lists: lists.rows, listEvents: listEvents.rows, taskEvents: taskEvents.rows, groupItems: groupItems.rows })
}

/** The item events of one (list, task) pair, both sides, oldest first. */
async function itemEvents(listId: string, taskId: string): Promise<{ list: unknown[]; task: unknown[] }> {
  const db = poolManager.get()
  const list = await db.query(
    `SELECT actor_id, event_type, payload FROM task_list_events
      WHERE list_id = $1 AND event_type IN ('item_added', 'item_removed') AND payload->>'taskId' = $2
      ORDER BY occurred_at, id`,
    [listId, taskId],
  )
  const task = await db.query(
    `SELECT actor_id, event_type, payload FROM task_events
      WHERE task_id = $1 AND event_type IN ('list_added', 'list_removed') AND payload->>'listId' = $2
      ORDER BY occurred_at, id`,
    [taskId, listId],
  )
  return {
    list: list.rows.map((row) => [row.actor_id, row.event_type, row.payload]),
    task: task.rows.map((row) => [row.actor_id, row.event_type, row.payload]),
  }
}

/** For the latest add of `taskId` to `listId`: whether the item row is later than `after`, and
 * whether both events carry the item row's `created_at`, compared in SQL. */
async function addStamps(listId: string, taskId: string, after = '-infinity'): Promise<Record<string, unknown>> {
  const result = await poolManager.get().query(
    `SELECT i.created_at > $3::timestamptz AS later,
            (SELECT le.occurred_at FROM task_list_events le
              WHERE le.list_id = $1 AND le.event_type = 'item_added' AND le.payload->>'taskId' = $2
              ORDER BY le.occurred_at DESC, le.id DESC LIMIT 1) = i.created_at AS list_event,
            (SELECT te.occurred_at FROM task_events te
              WHERE te.task_id = $2 AND te.event_type = 'list_added' AND te.payload->>'listId' = $1
              ORDER BY te.occurred_at DESC, te.id DESC LIMIT 1) = i.created_at AS task_event
       FROM task_list_items i WHERE i.list_id = $1 AND i.task_id = $2`,
    [listId, taskId, after],
  )
  return result.rows[0]
}

/** For the latest removal of `taskId` from `listId`: whether its list event is later than `after`,
 * and whether the task event carries the same instant, compared in SQL. */
async function removeStamps(listId: string, taskId: string, after = '-infinity'): Promise<Record<string, unknown>> {
  const result = await poolManager.get().query(
    `SELECT le.occurred_at > $3::timestamptz AS later,
            (SELECT te.occurred_at FROM task_events te
              WHERE te.task_id = $2 AND te.event_type = 'list_removed' AND te.payload->>'listId' = $1
              ORDER BY te.occurred_at DESC, te.id DESC LIMIT 1) = le.occurred_at AS task_event
       FROM task_list_events le
      WHERE le.list_id = $1 AND le.event_type = 'item_removed' AND le.payload->>'taskId' = $2
      ORDER BY le.occurred_at DESC, le.id DESC LIMIT 1`,
    [listId, taskId, after],
  )
  return result.rows[0]
}

// ---------------------------------------------------------------------------------------------
// POST /api/task-lists/:id/items
// ---------------------------------------------------------------------------------------------

describe('add', () => {
  it('items|add: the creator (an edit member) and an assignee (the owner) add tasks; the row carries the org; item_added and list_added by the caller share the row instant; an archived list takes items too', async () => {
    const stamp = stampOf()
    const orgId = orgOf('add', stamp)
    const owner = await actor('addowner', stamp, orgId)
    const editor = await actor('addedit', stamp, orgId)
    const listId = await listVia(owner, [[editor.userId, 'edit']])
    const other = await listVia(owner)
    const byCreator = await newTask(orgId, editor.userId, [editor.userId], '备料一')
    const toOwner = await newTask(orgId, `usrO_add_${stamp}`, [owner.userId], '备料二')
    await seedItem(other, byCreator, orgId)
    const before = (await poolManager.get().query(`SELECT updated_at FROM task_lists WHERE id = $1`, [listId])).rows[0]
    for (const [who, taskId] of [[editor, byCreator], [owner, toOwner]] as const) {
      const response = await app().post(`/api/task-lists/${listId}/items`).set(auth(who.bearer)).send({ taskId })
      expect(response.status).toBe(200)
      expect(response.body).toEqual({ listId, taskId })
      const row = await poolManager.get().query(`SELECT org_id FROM task_list_items WHERE list_id = $1 AND task_id = $2`, [listId, taskId])
      expect(row.rows).toEqual([{ org_id: orgId }])
      expect(await itemEvents(listId, taskId)).toEqual({
        list: [[who.userId, 'item_added', { taskId }]],
        task: [[who.userId, 'list_added', { listId }]],
      })
      expect(await addStamps(listId, taskId)).toEqual({ later: true, list_event: true, task_event: true })
    }
    expect(await itemRows(listId)).toEqual([byCreator, toOwner].sort())
    expect(await itemRows(other)).toEqual([byCreator])
    // Item writes do not touch the list row (design §4.4).
    const after = (await poolManager.get().query(`SELECT updated_at FROM task_lists WHERE id = $1`, [listId])).rows[0]
    expect(after).toEqual(before)
    const detail = await app().get(`/api/tasks/${byCreator}`).set(auth(editor.bearer))
    expect(detail.body.listIds).toEqual([listId, other].sort())

    // Archiving changes nothing here either.
    expect((await app().post(`/api/task-lists/${listId}/archive`).set(auth(owner.bearer))).status).toBe(200)
    const third = await newTask(orgId, owner.userId, [owner.userId], '备料三')
    const archivedAdd = await app().post(`/api/task-lists/${listId}/items`).set(auth(owner.bearer)).send({ taskId: third })
    expect(archivedAdd.status).toBe(200)
    expect(await itemRows(listId)).toContain(third)
  })

  it('m4list|add: an edit member with no role on the task gets the 404 of a missing task; nothing written', async () => {
    const stamp = stampOf()
    const orgId = orgOf('addnr', stamp)
    const owner = await actor('addnrowner', stamp, orgId)
    const editor = await actor('addnredit', stamp, orgId)
    const listId = await listVia(owner, [[editor.userId, 'edit']])
    const stranger = `usrO_addnr_${stamp}`
    const taskId = await newTask(orgId, stranger, [stranger])
    const before = await orgState(orgId)
    const hidden = await app().post(`/api/task-lists/${listId}/items`).set(auth(editor.bearer)).send({ taskId })
    const missing = await app().post(`/api/task-lists/${listId}/items`).set(auth(editor.bearer)).send({ taskId: `tsk_missing_${stamp}` })
    expect(hidden.status).toBe(404)
    expect(hidden.text).toBe(missing.text)
    expect(hidden.text).toBe(NOT_FOUND_TEXT)
    expect(await orgState(orgId)).toBe(before)
  })

  it('m4list|add: the task creator, and an assignee, holding only read on the list get the 404 of a missing list; nothing written', async () => {
    const stamp = stampOf()
    const orgId = orgOf('addro', stamp)
    const owner = await actor('addroowner', stamp, orgId)
    const creator = await actor('addrocr', stamp, orgId)
    const assignee = await actor('addroas', stamp, orgId)
    const listId = await listVia(owner, [[creator.userId, 'read'], [assignee.userId, 'read']])
    const taskId = await newTask(orgId, creator.userId, [assignee.userId])
    const before = await orgState(orgId)
    for (const who of [creator, assignee]) {
      const hidden = await app().post(`/api/task-lists/${listId}/items`).set(auth(who.bearer)).send({ taskId })
      const missing = await app().post(`/api/task-lists/tlst_missing${stamp}/items`).set(auth(who.bearer)).send({ taskId })
      expect(hidden.status).toBe(404)
      expect(hidden.text).toBe(missing.text)
      expect(hidden.text).toBe(NOT_FOUND_TEXT)
    }
    expect(await orgState(orgId)).toBe(before)
  })

  it('m4list|add: a follower who edits the list is 404; a list-only editor re-posting a task already in the list is 404, not the no-op', async () => {
    const stamp = stampOf()
    const orgId = orgOf('addfo', stamp)
    const owner = await actor('addfoowner', stamp, orgId)
    const editor = await actor('addfoedit', stamp, orgId)
    const stranger = `usrO_addfo_${stamp}`
    const listId = await listVia(owner, [[editor.userId, 'edit']])
    const followed = await newTask(orgId, stranger, [stranger])
    await poolManager.get().query(`INSERT INTO task_followers (task_id, user_id) VALUES ($1, $2)`, [followed, editor.userId])
    const listed = await newTask(orgId, stranger, [stranger])
    await seedItem(listId, listed, orgId)
    // The editor holds the listed task through the list (edit), and can see the followed one.
    expect((await app().get(`/api/tasks/${listed}`).set(auth(editor.bearer))).body.canEdit).toBe(true)
    expect((await app().get(`/api/tasks/${followed}`).set(auth(editor.bearer))).status).toBe(200)
    const before = await orgState(orgId)
    for (const taskId of [followed, listed]) {
      const response = await app().post(`/api/task-lists/${listId}/items`).set(auth(editor.bearer)).send({ taskId })
      expect(response.status).toBe(404)
      expect(response.text).toBe(NOT_FOUND_TEXT)
    }
    expect(await orgState(orgId)).toBe(before)
  })

  it('m4list|add: (a1) an edit member holding a task only through L1 cannot add it to a list of its own (L2); removed from L1, it loses the task', async () => {
    const stamp = stampOf()
    const orgId = orgOf('addcp', stamp)
    const owner = await actor('addcpowner', stamp, orgId)
    const editor = await actor('addcpedit', stamp, orgId)
    const stranger = `usrO_addcp_${stamp}`
    const first = await listVia(owner, [[editor.userId, 'edit']])
    const taskId = await newTask(orgId, stranger, [stranger])
    await seedItem(first, taskId, orgId)
    const own = await listVia(editor)
    const detail = await app().get(`/api/tasks/${taskId}`).set(auth(editor.bearer))
    expect(detail.status).toBe(200)
    expect(detail.body.canEdit).toBe(true)
    const before = await orgState(orgId)
    const copied = await app().post(`/api/task-lists/${own}/items`).set(auth(editor.bearer)).send({ taskId })
    const missing = await app().post(`/api/task-lists/${own}/items`).set(auth(editor.bearer)).send({ taskId: `tsk_missing_${stamp}` })
    expect(copied.status).toBe(404)
    expect(copied.text).toBe(missing.text)
    expect(await orgState(orgId)).toBe(before)
    expect(await itemRows(own)).toEqual([])
    const removed = await app().delete(`/api/task-lists/${first}/members/${editor.userId}`).set(auth(owner.bearer))
    expect(removed.status).toBe(200)
    const after = await app().get(`/api/tasks/${taskId}`).set(auth(editor.bearer))
    const absent = await app().get(`/api/tasks/tsk_missing_${stamp}`).set(auth(editor.bearer))
    expect(after.status).toBe(404)
    expect(after.text).toBe(absent.text)
  })

  it('items|add: a task already in the list is the no-op; the per-task quota is 422 LIMIT and counts archived lists; at the quota a re-add is still the no-op', async () => {
    const stamp = stampOf()
    const orgId = orgOf('addq', stamp)
    const me = await actor('addq', stamp, orgId)
    const taskId = await newTask(orgId, me.userId, [me.userId])
    const first = await listVia(me)
    const added = await app().post(`/api/task-lists/${first}/items`).set(auth(me.bearer)).send({ taskId })
    expect(added.status).toBe(200)
    const once = await orgState(orgId)
    const again = await app().post(`/api/task-lists/${first}/items`).set(auth(me.bearer)).send({ taskId })
    expect(again.status).toBe(200)
    expect(again.body).toEqual({ listId: first, taskId })
    expect(await orgState(orgId)).toBe(once)
    for (let i = 1; i < TASK_LISTS_PER_TASK_SOFT_LIMIT; i += 1) {
      await seedList(orgId, me.userId, [[me.userId, 'owner']], { taskIds: [taskId], archived: i === 1 })
    }
    const counted = await poolManager.get().query(`SELECT count(*)::int AS n FROM task_list_items WHERE task_id = $1`, [taskId])
    expect(counted.rows[0].n).toBe(TASK_LISTS_PER_TASK_SOFT_LIMIT)
    const extra = await listVia(me)
    const full = await orgState(orgId)
    const refused = await app().post(`/api/task-lists/${extra}/items`).set(auth(me.bearer)).send({ taskId })
    expect(refused.status).toBe(422)
    expect(refused.body).toEqual({ error: { code: 'LIMIT' } })
    expect(await orgState(orgId)).toBe(full)
    const reAdd = await app().post(`/api/task-lists/${first}/items`).set(auth(me.bearer)).send({ taskId })
    expect(reAdd.status).toBe(200)
    expect(await orgState(orgId)).toBe(full)
  })

  it('items|add: an invalid taskId is 422 INVALID_TASK from an edit member; a read member and a non-member get the 404 of a missing list for every body', async () => {
    const stamp = stampOf()
    const orgId = orgOf('addbad', stamp)
    const owner = await actor('addbadowner', stamp, orgId)
    const reader = await actor('addbadread', stamp, orgId)
    const outsider = await actor('addbadout', stamp, orgId)
    const listId = await listVia(owner, [[reader.userId, 'read']])
    const bodies: unknown[] = [
      {}, { taskId: '' }, { taskId: 7 }, { taskId: null }, { taskId: ['tsk_x'] }, { taskId: {} },
      { taskId: 'tsk\u0000x' }, { taskId: 'tsk x' }, { taskId: '任务' }, [{ taskId: 'tsk_x' }],
    ]
    const before = await orgState(orgId)
    for (const body of bodies) {
      const response = await app().post(`/api/task-lists/${listId}/items`).set(auth(owner.bearer)).send(body as object)
      expect(response.status, JSON.stringify(body)).toBe(422)
      expect(response.body).toEqual({ error: { code: 'INVALID_TASK' } })
      for (const who of [reader, outsider]) {
        const hidden = await app().post(`/api/task-lists/${listId}/items`).set(auth(who.bearer)).send(body as object)
        const missing = await app().post(`/api/task-lists/tlst_missing${stamp}/items`).set(auth(who.bearer)).send(body as object)
        expect(hidden.status).toBe(404)
        expect(hidden.text).toBe(missing.text)
      }
    }
    expect(await orgState(orgId)).toBe(before)
  })

  it('m4list|add: a missing task id, a deleted task and another org\'s task are each the 404 of a missing task; nothing written', async () => {
    const stamp = stampOf()
    const orgId = orgOf('addgone', stamp)
    const otherOrg = orgOf('addgoneB', stamp)
    const me = await actor('addgone', stamp, orgId)
    const listId = await listVia(me)
    const deleted = await newTask(orgId, me.userId, [me.userId])
    await poolManager.get().query(`UPDATE tasks SET deleted_at = now() WHERE id = $1`, [deleted])
    const elsewhere = await newTask(otherOrg, me.userId, [me.userId])
    const before = await orgState(orgId)
    const texts = new Set<string>()
    for (const taskId of [`tsk_missing_${stamp}`, deleted, elsewhere]) {
      const response = await app().post(`/api/task-lists/${listId}/items`).set(auth(me.bearer)).send({ taskId })
      expect(response.status).toBe(404)
      texts.add(response.text)
    }
    expect([...texts]).toEqual([NOT_FOUND_TEXT])
    expect(await orgState(orgId)).toBe(before)
  })

  // §10.4 cross-org add, and negative control 1 (task half for item writes): with the task org
  // predicate made always true the service reads the org B task, and the composite foreign key on
  // (task_id, org_id) refuses the item, so the add still writes nothing (design §4.3 layer ②).
  it('m4list|cross-org add: an edit member of an org A list who created a task in org B gets the 404 of a missing task; negative control 1 makes the add fail at the foreign key; zero rows either way', async () => {
    const stamp = stampOf()
    const orgA = orgOf('xaddA', stamp)
    const orgB = orgOf('xaddB', stamp)
    const me = await actor('xadd', stamp, orgA)
    const listId = await listVia(me)
    const foreign = await newTask(orgB, me.userId, [me.userId])
    const rows = async () => {
      const db = poolManager.get()
      const items = await db.query(`SELECT count(*)::int AS n FROM task_list_items WHERE task_id = $1 OR list_id = $2`, [foreign, listId])
      const listEvents = await db.query(`SELECT count(*)::int AS n FROM task_list_events WHERE list_id = $1 AND event_type <> 'created'`, [listId])
      const taskEvents = await db.query(`SELECT count(*)::int AS n FROM task_events WHERE task_id = $1 AND event_type <> 'created'`, [foreign])
      return [items.rows[0].n, listEvents.rows[0].n, taskEvents.rows[0].n]
    }
    const hidden = await app().post(`/api/task-lists/${listId}/items`).set(auth(me.bearer)).send({ taskId: foreign })
    const missing = await app().post(`/api/task-lists/${listId}/items`).set(auth(me.bearer)).send({ taskId: `tsk_missing_${stamp}` })
    expect(hidden.status).toBe(404)
    expect(hidden.text).toBe(missing.text)
    expect(await rows()).toEqual([0, 0, 0])

    runSourceMutant(ACCESS_FILE, '(tasks.org_id = ${ORG_PLACEHOLDER}) AND ', '(${ORG_PLACEHOLDER}::text IS NOT NULL) AND ', `
      process.env.TASKS_ENABLED = 'true'
      const express = (await import(${JSON.stringify(EXPRESS_PATH)})).default
      const request = (await import(${JSON.stringify(SUPERTEST_PATH)})).default
      const { tasksRouter } = await import(${JSON.stringify(ROUTES_FILE)})
      const server = express()
      server.use(express.json())
      server.use(tasksRouter())
      const detail = await request(server).get('/api/tasks/' + ${JSON.stringify(foreign)}).set('Authorization', 'Bearer ' + ${JSON.stringify(me.bearer)})
      const add = await request(server).post('/api/task-lists/' + ${JSON.stringify(listId)} + '/items').set('Authorization', 'Bearer ' + ${JSON.stringify(me.bearer)}).send({ taskId: ${JSON.stringify(foreign)} })
      console.log(JSON.stringify({ nc1items: 'red', detail: detail.status, add: add.status, body: add.body }))
      process.exit(detail.status === 200 && add.status === 500 && add.body?.error?.code === 'INTERNAL' ? 0 : 1)
    `, {}, { unique: true })
    expect(await rows()).toEqual([0, 0, 0])
  }, 180000)
})

// ---------------------------------------------------------------------------------------------
// DELETE /api/task-lists/:id/items/:taskId
// ---------------------------------------------------------------------------------------------

describe('remove', () => {
  it('items|remove: an edit member removes a task; the row and this list\'s group items go; item_removed and list_removed by the caller share one instant; a list-only reader loses the task', async () => {
    const stamp = stampOf()
    const orgId = orgOf('rm', stamp)
    const owner = await actor('rmowner', stamp, orgId)
    const editor = await actor('rmedit', stamp, orgId)
    const reader = await actor('rmread', stamp, orgId)
    const stranger = `usrO_rm_${stamp}`
    const listId = await listVia(owner, [[editor.userId, 'edit'], [reader.userId, 'read']])
    const other = await listVia(owner)
    const taskId = await newTask(orgId, stranger, [stranger])
    await seedItem(listId, taskId, orgId)
    await seedItem(other, taskId, orgId)
    const db = poolManager.get()
    const groupOf = async (id: string) => String((await db.query(`SELECT id FROM task_groups WHERE list_id = $1 AND is_default`, [id])).rows[0].id)
    const listGroup = await groupOf(listId)
    const otherGroup = await groupOf(other)
    const personal = `tgrp_p${stamp}`
    await db.query(
      `INSERT INTO task_groups (id, org_id, scope, user_id, name, position, is_default) VALUES ($1, $2, 'user', $3, '我的', 0, true)`,
      [personal, orgId, owner.userId],
    )
    for (const group of [listGroup, otherGroup, personal]) {
      await db.query(`INSERT INTO task_group_items (group_id, task_id, org_id, position) VALUES ($1, $2, $3, 0)`, [group, taskId, orgId])
    }
    // A second task in the same list and the same list group: the removal names one task only.
    const sibling = await newTask(orgId, stranger, [stranger], '备料二')
    await seedItem(listId, sibling, orgId)
    await db.query(`INSERT INTO task_group_items (group_id, task_id, org_id, position) VALUES ($1, $2, $3, 1)`, [listGroup, sibling, orgId])
    expect((await app().get(`/api/tasks/${taskId}`).set(auth(reader.bearer))).status).toBe(200)
    const response = await app().delete(`/api/task-lists/${listId}/items/${taskId}`).set(auth(editor.bearer))
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ listId, taskId })
    expect(await itemRows(listId)).toEqual([sibling])
    expect(await itemRows(other)).toEqual([taskId])
    const groups = await db.query(`SELECT group_id FROM task_group_items WHERE task_id = $1 ORDER BY group_id COLLATE "C"`, [taskId])
    expect(groups.rows.map((row) => row.group_id)).toEqual([otherGroup, personal].sort())
    const siblingGroups = await db.query(`SELECT group_id, position FROM task_group_items WHERE task_id = $1`, [sibling])
    expect(siblingGroups.rows).toEqual([{ group_id: listGroup, position: 1 }])
    expect((await app().get(`/api/tasks/${sibling}`).set(auth(reader.bearer))).status).toBe(200)
    expect(await itemEvents(listId, taskId)).toEqual({
      list: [[editor.userId, 'item_removed', { taskId }]],
      task: [[editor.userId, 'list_removed', { listId }]],
    })
    expect(await removeStamps(listId, taskId)).toEqual({ later: true, task_event: true })
    const after = await app().get(`/api/tasks/${taskId}`).set(auth(reader.bearer))
    const absent = await app().get(`/api/tasks/tsk_missing_${stamp}`).set(auth(reader.bearer))
    expect(after.status).toBe(404)
    expect(after.text).toBe(absent.text)
  })

  it('items|remove: a member who edits a task that is not in the list gets the no-op; one without a role on it gets the 404', async () => {
    const stamp = stampOf()
    const orgId = orgOf('rmnoop', stamp)
    const owner = await actor('rmnoopowner', stamp, orgId)
    const editor = await actor('rmnoopedit', stamp, orgId)
    const stranger = `usrO_rmnoop_${stamp}`
    const listId = await listVia(owner, [[editor.userId, 'edit']])
    const assigned = await newTask(orgId, stranger, [editor.userId])
    const unrelated = await newTask(orgId, stranger, [stranger])
    const before = await orgState(orgId)
    const noop = await app().delete(`/api/task-lists/${listId}/items/${assigned}`).set(auth(editor.bearer))
    expect(noop.status).toBe(200)
    expect(noop.body).toEqual({ listId, taskId: assigned })
    const hidden = await app().delete(`/api/task-lists/${listId}/items/${unrelated}`).set(auth(editor.bearer))
    const missing = await app().delete(`/api/task-lists/${listId}/items/tsk_missing_${stamp}`).set(auth(editor.bearer))
    expect(hidden.status).toBe(404)
    expect(hidden.text).toBe(missing.text)
    expect(await orgState(orgId)).toBe(before)
  })

  it('m4list|remove: a read member who did not create the task gets the 404 for a task in the list; nothing written', async () => {
    const stamp = stampOf()
    const orgId = orgOf('rmro', stamp)
    const owner = await actor('rmroowner', stamp, orgId)
    const reader = await actor('rmroread', stamp, orgId)
    const stranger = `usrO_rmro_${stamp}`
    const listId = await listVia(owner, [[reader.userId, 'read']])
    const taskId = await newTask(orgId, stranger, [reader.userId])
    await seedItem(listId, taskId, orgId)
    const before = await orgState(orgId)
    const hidden = await app().delete(`/api/task-lists/${listId}/items/${taskId}`).set(auth(reader.bearer))
    const missing = await app().delete(`/api/task-lists/tlst_missing${stamp}/items/${taskId}`).set(auth(reader.bearer))
    expect(hidden.status).toBe(404)
    expect(hidden.text).toBe(missing.text)
    expect(await orgState(orgId)).toBe(before)
  })

  it('m4list|remove: the creator sees in listIds a list it is not a member of that holds its task, and removes the task from it without being a member; the list\'s other item and placement stay; a former assignee who holds the task only through that list then gets the 404', async () => {
    const stamp = stampOf()
    const orgId = orgOf('rmcr', stamp)
    const creator = await actor('rmcrcr', stamp, orgId)
    const assignee = await actor('rmcras', stamp, orgId)
    const taskId = await newTask(orgId, creator.userId, [assignee.userId])
    const own = await listVia(assignee)
    const added = await app().post(`/api/task-lists/${own}/items`).set(auth(assignee.bearer)).send({ taskId })
    expect(added.status).toBe(200)
    // A second task in the same list and the same group: the creator's removal names one task only.
    const db = poolManager.get()
    const sibling = await newTask(orgId, assignee.userId, [assignee.userId], '备料二')
    await seedItem(own, sibling, orgId)
    const ownGroup = String((await db.query(`SELECT id FROM task_groups WHERE list_id = $1 AND is_default`, [own])).rows[0].id)
    for (const [task, position] of [[taskId, 0], [sibling, 1]] as const) {
      await db.query(`INSERT INTO task_group_items (group_id, task_id, org_id, position) VALUES ($1, $2, $3, $4)`, [ownGroup, task, orgId, position])
    }
    const unassigned = await app().delete(`/api/tasks/${taskId}/assignees/${assignee.userId}`).set(auth(creator.bearer))
    expect(unassigned.status).toBe(200)
    // A list holding the task still gives its members list identity (here, list-editor).
    const kept = await app().get(`/api/tasks/${taskId}`).set(auth(assignee.bearer))
    expect(kept.status).toBe(200)
    expect(kept.body.canEdit).toBe(true)
    const seen = await app().get(`/api/tasks/${taskId}`).set(auth(creator.bearer))
    expect(seen.body.listIds).toEqual([own])
    // Ids only: the list itself stays the 404 of a missing list to the creator.
    const list = await app().get(`/api/task-lists/${own}`).set(auth(creator.bearer))
    expect(list.status).toBe(404)
    expect(list.text).toBe(NOT_FOUND_TEXT)
    const removed = await app().delete(`/api/task-lists/${own}/items/${taskId}`).set(auth(creator.bearer))
    expect(removed.status).toBe(200)
    expect(removed.body).toEqual({ listId: own, taskId })
    expect(await itemEvents(own, taskId)).toEqual({
      list: [[assignee.userId, 'item_added', { taskId }], [creator.userId, 'item_removed', { taskId }]],
      task: [[assignee.userId, 'list_added', { listId: own }], [creator.userId, 'list_removed', { listId: own }]],
    })
    expect(await removeStamps(own, taskId)).toEqual({ later: true, task_event: true })
    expect(await itemRows(own)).toEqual([sibling])
    const placements = await db.query(`SELECT task_id, position FROM task_group_items WHERE group_id = $1`, [ownGroup])
    expect(placements.rows).toEqual([{ task_id: sibling, position: 1 }])
    const members = await db.query(`SELECT user_id, role FROM task_list_members WHERE list_id = $1`, [own])
    expect(members.rows).toEqual([{ user_id: assignee.userId, role: 'owner' }])
    expect((await app().get(`/api/tasks/${taskId}`).set(auth(creator.bearer))).body.listIds).toEqual([])
    const lost = await app().get(`/api/tasks/${taskId}`).set(auth(assignee.bearer))
    const absent = await app().get(`/api/tasks/tsk_missing_${stamp}`).set(auth(assignee.bearer))
    expect(lost.status).toBe(404)
    expect(lost.text).toBe(absent.text)
  })

  // RULED(2026-10-07): [own-25] (a1) (a2); RULED(2026-10-07): [own-53].
  it('m4list|remove: adding a task to a list and changing its assignees or followers both take a direct role, so a list-only editor gets the 404 on each; after the creator removes the task from the list that editor holds it through, the editor gets the 404 of a missing task', async () => {
    const stamp = stampOf()
    const orgId = orgOf('rmdir', stamp)
    const creator = await actor('rmdircr', stamp, orgId)
    const editor = await actor('rmdired', stamp, orgId)
    const holder = `usrO_rmdir_${stamp}`
    const taskId = await newTask(orgId, creator.userId, [creator.userId])
    const shared = await seedList(orgId, holder, [[holder, 'owner'], [editor.userId, 'edit']], { taskIds: [taskId] })
    const own = await listVia(editor)
    const db = poolManager.get()
    const members = async () => {
      const assignees = await db.query(`SELECT user_id FROM task_assignees WHERE task_id = $1 ORDER BY user_id`, [taskId])
      const followers = await db.query(`SELECT user_id FROM task_followers WHERE task_id = $1 ORDER BY user_id`, [taskId])
      return JSON.stringify({ assignees: assignees.rows, followers: followers.rows })
    }
    const detail = await app().get(`/api/tasks/${taskId}`).set(auth(editor.bearer))
    expect(detail.status).toBe(200)
    expect([detail.body.canEdit, detail.body.canManageMembers]).toEqual([true, false])
    const missing = `tsk_missing_${stamp}`
    const refused: Array<[string, (id: string) => Promise<{ status: number; text: string }>]> = [
      ['add to its own list', (id) => send('post', `/api/task-lists/${own}/items`, editor.bearer, { taskId: id })],
      ['add itself as an assignee', (id) => send('post', `/api/tasks/${id}/assignees`, editor.bearer, { userId: editor.userId })],
      ['add itself as a follower', (id) => send('post', `/api/tasks/${id}/followers`, editor.bearer, { userId: editor.userId })],
      ['remove the creator as an assignee', (id) => send('delete', `/api/tasks/${id}/assignees/${creator.userId}`, editor.bearer)],
    ]
    const beforeState = await orgState(orgId)
    const beforeMembers = await members()
    for (const [label, call] of refused) {
      const real = await call(taskId)
      const absent = await call(missing)
      expect(real.status, label).toBe(404)
      expect(real.text, label).toBe(absent.text)
    }
    expect(await orgState(orgId)).toBe(beforeState)
    expect(await members()).toBe(beforeMembers)
    expect(await itemRows(own)).toEqual([])

    // (a2): the creator, not a member of that list, removes the task from it.
    const removed = await app().delete(`/api/task-lists/${shared}/items/${taskId}`).set(auth(creator.bearer))
    expect(removed.status).toBe(200)
    expect(await itemRows(shared)).toEqual([])
    const gone = await app().get(`/api/tasks/${taskId}`).set(auth(editor.bearer))
    const absent = await app().get(`/api/tasks/${missing}`).set(auth(editor.bearer))
    expect(gone.status).toBe(404)
    expect(gone.text).toBe(absent.text)
    const afterRemoval = await orgState(orgId)
    for (const [label, call] of refused) {
      const real = await call(taskId)
      expect(real.status, label).toBe(404)
      expect(real.text, label).toBe(NOT_FOUND_TEXT)
    }
    expect(await orgState(orgId)).toBe(afterRemoval)
    expect(await members()).toBe(beforeMembers)
    expect((await app().get(`/api/tasks/${taskId}`).set(auth(creator.bearer))).body.listIds).toEqual([])
  })

  it('m4list|remove: the creator way has one 404 — a missing list, another org\'s list, a list without the task, a read-only list without the task, malformed path ids — and a non-creator non-member on a list holding the task gets the same bytes; nothing written', async () => {
    const stamp = stampOf()
    const orgId = orgOf('rmuni', stamp)
    const otherOrg = orgOf('rmuniB', stamp)
    const creator = await actor('rmunicr', stamp, orgId)
    const outsider = await actor('rmuniout', stamp, orgId)
    const holder = `usrO_rmuni_${stamp}`
    const taskId = await newTask(orgId, creator.userId, [creator.userId])
    const holding = await seedList(orgId, holder, [[holder, 'owner']], { taskIds: [taskId] })
    const without = await seedList(orgId, holder, [[holder, 'owner']])
    const readOnly = await seedList(orgId, holder, [[holder, 'owner'], [creator.userId, 'read']])
    const foreignTask = await newTask(otherOrg, holder, [holder])
    const foreign = await seedList(otherOrg, holder, [[holder, 'owner'], [creator.userId, 'edit']], { taskIds: [foreignTask] })
    const before = await orgState(orgId)
    const beforeOther = await orgState(otherOrg)
    const answers: Array<{ label: string; status: number; text: string }> = []
    const ask = async (label: string, who: SeededTaskActor, path: string) => {
      const response = await send('delete', path, who.bearer)
      answers.push({ label, status: response.status, text: response.text })
    }
    await ask('missing list', creator, `/api/task-lists/tlst_missing${stamp}/items/${taskId}`)
    await ask('another org', creator, `/api/task-lists/${foreign}/items/${taskId}`)
    await ask('another org, its own task', creator, `/api/task-lists/${foreign}/items/${foreignTask}`)
    await ask('list without the task', creator, `/api/task-lists/${without}/items/${taskId}`)
    await ask('read-only list without the task', creator, `/api/task-lists/${readOnly}/items/${taskId}`)
    await ask('U+0000 list id', creator, `/api/task-lists/tlst_%00/items/${taskId}`)
    await ask('U+0000 task id', creator, `/api/task-lists/${holding}/items/tsk%00x`)
    await ask('dot list id', creator, `/api/task-lists/./items/${taskId}`)
    await ask('dot-dot list id', creator, `/api/task-lists/../items/${taskId}`)
    await ask('dot-dot task id', creator, `/api/task-lists/${holding}/items/..`)
    await ask('missing task', creator, `/api/task-lists/${holding}/items/tsk_missing_${stamp}`)
    await ask('not the creator, not a member', outsider, `/api/task-lists/${holding}/items/${taskId}`)
    for (const answer of answers) {
      expect(answer.status, answer.label).toBe(404)
      expect(answer.text, answer.label).toBe(NOT_FOUND_TEXT)
    }
    expect(await orgState(orgId)).toBe(before)
    expect(await orgState(otherOrg)).toBe(beforeOther)
    // The way in does exist, for the list that holds the task.
    const removed = await app().delete(`/api/task-lists/${holding}/items/${taskId}`).set(auth(creator.bearer))
    expect(removed.status).toBe(200)
    expect(await itemEvents(holding, taskId)).toEqual({
      list: [[creator.userId, 'item_removed', { taskId }]],
      task: [[creator.userId, 'list_removed', { listId: holding }]],
    })
  })
})

// ---------------------------------------------------------------------------------------------
// GET /api/task-lists/:id/items
// ---------------------------------------------------------------------------------------------

describe('read', () => {
  it('items|list: members read the live tasks of the list with the GET /api/tasks columns, by updated_at DESC, id DESC; pages are disjoint; other lists\' items and deleted tasks are left out while their rows stay', async () => {
    const stamp = stampOf()
    const orgId = orgOf('ls', stamp)
    const owner = await actor('lsowner', stamp, orgId)
    const reader = await actor('lsread', stamp, orgId)
    const listId = await listVia(owner, [[reader.userId, 'read']])
    const other = await listVia(owner)
    const db = poolManager.get()
    const tasks: string[] = []
    for (let i = 0; i < 6; i += 1) tasks.push(await newTask(orgId, owner.userId, [owner.userId], `备料${i}`))
    // The four live listed tasks, taken in id order: their updated_at values run the other way (the
    // smallest id is the newest) with one tie in the middle, so neither key alone gives the order.
    const byId = tasks.slice(0, 4).sort()
    const stampsById = ['2021-01-05', '2021-01-03', '2021-01-03', '2021-01-01']
    for (let i = 0; i < byId.length; i += 1) {
      await db.query(`UPDATE tasks SET updated_at = $2::timestamptz WHERE id = $1`, [byId[i], `${stampsById[i]}T00:00:00Z`])
    }
    for (const taskId of tasks.slice(0, 5)) await seedItem(listId, taskId, orgId)
    await seedItem(other, tasks[5], orgId)
    await seedItem(other, tasks[0], orgId)
    await db.query(`UPDATE tasks SET deleted_at = now() WHERE id = $1`, [tasks[4]])
    const expected = (await db.query(
      `SELECT id FROM tasks WHERE id = ANY($1::text[]) ORDER BY updated_at DESC, id DESC`,
      [tasks.slice(0, 4)],
    )).rows.map((row) => String(row.id))
    expect(expected).toEqual([byId[0], byId[2], byId[1], byId[3]])
    const seen: string[] = []
    for (const offset of ['0', '2']) {
      const page = await app().get(`/api/task-lists/${listId}/items`).query({ limit: '2', offset }).set(auth(reader.bearer))
      expect(page.status).toBe(200)
      expect(Object.keys(page.body).sort()).toEqual(['items', 'total'])
      expect(page.body.total).toBe(4)
      seen.push(...page.body.items.map((item: { id: string }) => item.id))
    }
    expect(seen).toEqual(expected)
    const all = await app().get(`/api/task-lists/${listId}/items`).set(auth(reader.bearer))
    const first = all.body.items.find((item: { id: string }) => item.id === tasks[0])
    expect(first).toEqual({ id: tasks[0], title: '备料0', status: 'open', completion_mode: 'all', created_by: owner.userId, due_at: null })
    const past = await app().get(`/api/task-lists/${listId}/items`).query({ offset: '4' }).set(auth(reader.bearer))
    expect(past.body).toEqual({ items: [], total: 4 })
    const otherPage = await app().get(`/api/task-lists/${other}/items`).set(auth(owner.bearer))
    expect(otherPage.body.items.map((item: { id: string }) => item.id).sort()).toEqual([tasks[0], tasks[5]].sort())
    // The deleted task's item row stays (R13); the removal route cannot reach it.
    expect(await itemRows(listId)).toContain(tasks[4])
    const gone = await app().delete(`/api/task-lists/${listId}/items/${tasks[4]}`).set(auth(owner.bearer))
    expect(gone.status).toBe(404)
    expect(gone.text).toBe(NOT_FOUND_TEXT)
    expect(await itemRows(listId)).toContain(tasks[4])
  })

  it('m4list|list: a non-member gets the 404 of a missing list, also with an invalid page; a member with an invalid page gets 422; no org claim is 404', async () => {
    const stamp = stampOf()
    const orgId = orgOf('lsnm', stamp)
    const owner = await actor('lsnmowner', stamp, orgId)
    const outsider = await actor('lsnmout', stamp, orgId)
    const listId = await listVia(owner)
    await seedItem(listId, await newTask(orgId, owner.userId, [owner.userId]), orgId)
    for (const query of ['', '?limit=0', '?offset=-1']) {
      const hidden = await app().get(`/api/task-lists/${listId}/items${query}`).set(auth(outsider.bearer))
      const missing = await app().get(`/api/task-lists/tlst_missing${stamp}/items${query}`).set(auth(outsider.bearer))
      expect(hidden.status).toBe(404)
      expect(hidden.text).toBe(missing.text)
      expect(hidden.text).toBe(NOT_FOUND_TEXT)
    }
    const badLimit = await app().get(`/api/task-lists/${listId}/items?limit=101`).set(auth(owner.bearer))
    expect(badLimit.status).toBe(422)
    expect(badLimit.body).toEqual({ error: { code: 'INVALID_LIMIT' } })
    const badOffset = await app().get(`/api/task-lists/${listId}/items?offset=x`).set(auth(owner.bearer))
    expect(badOffset.body).toEqual({ error: { code: 'INVALID_OFFSET' } })
    const noOrg = await app().get(`/api/task-lists/${listId}/items`).set(auth(tokenFor(owner, null)))
    expect(noOrg.status).toBe(404)
    expect(noOrg.text).toBe(NOT_FOUND_TEXT)
  })

  it('m4list|second tenant: a member of an org B list holding an org A token gets the 404 of a missing list on the three item routes; the org B token reads the items', async () => {
    const stamp = stampOf()
    const orgA = orgOf('stA', stamp)
    const orgB = orgOf('stB', stamp)
    const me = await actor('st', stamp, orgA)
    const taskB = await newTask(orgB, me.userId, [me.userId])
    const listB = await seedList(orgB, me.userId, [[me.userId, 'edit']], { taskIds: [taskB] })
    const second = await newTask(orgB, me.userId, [me.userId])
    const before = await orgState(orgB)
    const missingList = `tlst_missing${stamp}`
    for (const [method, path, body] of [
      ['get', `/api/task-lists/${listB}/items`, undefined],
      ['post', `/api/task-lists/${listB}/items`, { taskId: second }],
      ['delete', `/api/task-lists/${listB}/items/${taskB}`, undefined],
    ] as const) {
      const hidden = await send(method, path, me.bearer, body)
      const missing = await send(method, path.replace(listB, missingList), me.bearer, body)
      expect(hidden.status).toBe(404)
      expect(hidden.text).toBe(missing.text)
    }
    expect(await orgState(orgB)).toBe(before)
    const asB = await app().get(`/api/task-lists/${listB}/items`).set(auth(signTaskToken(me.userId, me.roleId, orgB)))
    expect(asB.status).toBe(200)
    expect(asB.body.items.map((item: { id: string }) => item.id)).toEqual([taskB])
  })
})

// ---------------------------------------------------------------------------------------------
// listIds on GET /api/tasks/:id (design §5.5)
// ---------------------------------------------------------------------------------------------

describe('listIds', () => {
  it('items|listIds: the creator sees every list holding the task, archived included, in byte order; a reader of one list, an editor of one list and a follower who reads one list each see only that list; an assignee in none sees []; another task\'s lists never appear', async () => {
    const stamp = stampOf()
    const orgId = orgOf('lids', stamp)
    const creator = await actor('lidscr', stamp, orgId)
    const reader = await actor('lidsread', stamp, orgId)
    const editor = await actor('lidsedit', stamp, orgId)
    const follower = await actor('lidsfol', stamp, orgId)
    const assignee = await actor('lidsas', stamp, orgId)
    const holder = `usrO_lids_${stamp}`
    const taskId = await newTask(orgId, creator.userId, [assignee.userId])
    const otherTask = await newTask(orgId, creator.userId, [assignee.userId])
    await poolManager.get().query(`INSERT INTO task_followers (task_id, user_id) VALUES ($1, $2)`, [taskId, follower.userId])
    // Inserted c, B, a. Byte order is B < a < c; the database's default collation and a locale
    // compare give a < B < c; insertion order is c, B, a. Only a byte-order sort gives B, a, c.
    const lc = await seedList(orgId, holder, [[holder, 'owner'], [editor.userId, 'edit']], { id: `tlst_c${stamp}`, taskIds: [taskId] })
    const la = await seedList(orgId, holder, [[holder, 'owner'], [follower.userId, 'read']], { id: `tlst_B${stamp}`, taskIds: [taskId], archived: true })
    const lb = await seedList(orgId, holder, [[holder, 'owner'], [reader.userId, 'read']], { id: `tlst_a${stamp}`, taskIds: [taskId] })
    const ld = await seedList(orgId, holder, [[holder, 'owner'], [reader.userId, 'read']], { id: `tlst_d${stamp}`, taskIds: [otherTask] })
    const ids = async (who: SeededTaskActor, id: string) => {
      const response = await app().get(`/api/tasks/${id}`).set(auth(who.bearer))
      expect(response.status).toBe(200)
      return response.body.listIds
    }
    expect(await ids(creator, taskId)).toEqual([la, lb, lc])
    expect(await ids(reader, taskId)).toEqual([lb])
    // An edit member of one holding list, and a follower who reads another, see only their own list.
    expect(await ids(editor, taskId)).toEqual([lc])
    expect(await ids(follower, taskId)).toEqual([la])
    expect(await ids(assignee, taskId)).toEqual([])
    expect(await ids(creator, otherTask)).toEqual([ld])
    expect(await ids(reader, otherTask)).toEqual([ld])
  })

  // [own-37] [own-46]: an item row whose list is in another org is refused by the composite foreign
  // keys; this one is written past them (`session_replication_role = replica`, superuser), and the
  // creator's `listIds` still leaves it out.
  it('m4list|listIds: an item row written past the foreign keys, holding the task in another org\'s list, is not listed for the creator', async () => {
    const stamp = stampOf()
    const orgA = orgOf('lidxA', stamp)
    const orgB = orgOf('lidxB', stamp)
    const creator = await actor('lidx', stamp, orgA)
    const holder = `usrO_lidx_${stamp}`
    const taskId = await newTask(orgA, creator.userId, [creator.userId])
    const same = await seedList(orgA, holder, [[holder, 'owner']], { taskIds: [taskId] })
    const foreign = await seedList(orgB, holder, [[holder, 'owner'], [creator.userId, 'edit']])
    await expect(poolManager.get().query('INSERT INTO task_list_items (list_id, task_id, org_id) VALUES ($1, $2, $3)', [foreign, taskId, orgA]))
      .rejects.toMatchObject({ code: '23503', constraint: 'task_list_items_list_fk' })
    const seeder = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await seeder.connect()
    try {
      const su = await seeder.query(`SELECT current_setting('is_superuser') AS su`)
      if (su.rows[0].su !== 'on') throw new Error('the cross-org seed needs a superuser connection (session_replication_role)')
      await seeder.query('SET session_replication_role = replica')
      await seeder.query('INSERT INTO task_list_items (list_id, task_id, org_id) VALUES ($1, $2, $3)', [foreign, taskId, orgA])
      await seeder.query('RESET session_replication_role')
    } finally {
      await seeder.end()
    }
    try {
      expect(await itemRows(foreign)).toEqual([taskId])
      const detail = await app().get(`/api/tasks/${taskId}`).set(auth(creator.bearer))
      expect(detail.status).toBe(200)
      expect(detail.body.listIds).toEqual([same])
    } finally {
      await poolManager.get().query('DELETE FROM task_list_items WHERE list_id = $1 AND task_id = $2', [foreign, taskId])
    }
  })
})

// ---------------------------------------------------------------------------------------------
// Permission codes and a missing org claim
// ---------------------------------------------------------------------------------------------

describe('permission codes and missing org', () => {
  type CodeRoute = {
    label: string
    code: 'read' | 'write'
    call: (listId: string, taskId: string) => { method: 'get' | 'post' | 'delete'; path: string; body?: Record<string, unknown> }
  }
  const CODE_ROUTES: CodeRoute[] = [
    { label: 'GET /api/task-lists/:id/items', code: 'read', call: (listId) => ({ method: 'get', path: `/api/task-lists/${listId}/items` }) },
    { label: 'POST /api/task-lists/:id/items', code: 'write', call: (listId, taskId) => ({ method: 'post', path: `/api/task-lists/${listId}/items`, body: { taskId } }) },
    { label: 'DELETE /api/task-lists/:id/items/:taskId', code: 'write', call: (listId, taskId) => ({ method: 'delete', path: `/api/task-lists/${listId}/items/${taskId}` }) },
  ]

  it.each(CODE_ROUTES)('items|codes: $label needs tasks:$code; the other code alone is 403 and nothing is written', async (route) => {
    const stamp = stampOf()
    const orgId = orgOf('codes', stamp)
    const owner = await actor('codesowner', stamp, orgId)
    const wrong = await actor('codeswrong', stamp, orgId, [route.code === 'write' ? 'tasks:read' : 'tasks:write'])
    const right = await actor('codesright', stamp, orgId, [`tasks:${route.code}`])
    const listId = await listVia(owner, [[wrong.userId, 'edit'], [right.userId, 'edit']])
    // Each caller is the task's assignee, so the add is allowed; the removal finds it in the list.
    const taskId = await newTask(orgId, owner.userId, [wrong.userId, right.userId])
    if (route.code === 'write' && route.label.startsWith('DELETE')) await seedItem(listId, taskId, orgId)
    const { method, path, body } = route.call(listId, taskId)
    const before = await orgState(orgId)
    const denied = await send(method, path, wrong.bearer, body)
    expect(denied.status).toBe(403)
    expect(JSON.parse(denied.text)).toEqual({ error: 'Insufficient permissions' })
    expect(await orgState(orgId)).toBe(before)
    const allowed = await send(method, path, right.bearer, body)
    expect(allowed.status).toBe(200)
  })

  it('items|no org: the two writes are 422 ORG_MISSING and the read is 404; nothing written', async () => {
    const stamp = stampOf()
    const orgId = orgOf('noorg', stamp)
    const owner = await actor('noorg', stamp, orgId)
    const listId = await listVia(owner)
    const taskId = await newTask(orgId, owner.userId, [owner.userId])
    const inList = await newTask(orgId, owner.userId, [owner.userId])
    await seedItem(listId, inList, orgId)
    const bearer = tokenFor(owner, null)
    const before = await orgState(orgId)
    for (const [method, path, body] of [
      ['post', `/api/task-lists/${listId}/items`, { taskId }],
      ['post', `/api/task-lists/${listId}/items`, { taskId: 7 }],
      ['delete', `/api/task-lists/${listId}/items/${inList}`, undefined],
    ] as const) {
      const response = await send(method, path, bearer, body)
      expect(response.status).toBe(422)
      expect(JSON.parse(response.text)).toEqual({ error: { code: 'ORG_MISSING' } })
    }
    const read = await send('get', `/api/task-lists/${listId}/items`, bearer)
    expect(read.status).toBe(404)
    expect(read.text).toBe(NOT_FOUND_TEXT)
    expect(await orgState(orgId)).toBe(before)
  })
})

// ---------------------------------------------------------------------------------------------
// Write instants (design §4.4, §4.5)
// ---------------------------------------------------------------------------------------------

describe('write instants', () => {
  it('items|stamps: an add and a removal queued behind the structure lock are stamped after it; both events of each write share one reading', async () => {
    const stamp = stampOf()
    const orgId = orgOf('stmp', stamp)
    const me = await actor('stmp', stamp, orgId)
    const listId = await listVia(me)
    const taskId = await newTask(orgId, me.userId, [me.userId])
    const added = await whileStructureLockHeld(orgId, () =>
      app().post(`/api/task-lists/${listId}/items`).set(auth(me.bearer)).send({ taskId }).then((res) => res))
    expect(added.result.status).toBe(200)
    expect(await addStamps(listId, taskId, added.holderAt)).toEqual({ later: true, list_event: true, task_event: true })
    const removed = await whileStructureLockHeld(orgId, () =>
      app().delete(`/api/task-lists/${listId}/items/${taskId}`).set(auth(me.bearer)).then((res) => res))
    expect(removed.result.status).toBe(200)
    expect(await removeStamps(listId, taskId, removed.holderAt)).toEqual({ later: true, task_event: true })
  }, 60000)
})
