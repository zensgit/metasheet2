import '../helpers/assert-rbac-optional-off'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import express from 'express'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { poolManager } from '../../src/integration/db/connection-pool'
import { MetaSheetServer } from '../../src/index'
import { tasksRouter } from '../../src/routes/tasks'
import { countPending, createTask, listPending, listTasks } from '../../src/services/task-records'
import { newTaskListId } from '../../src/services/task-ids-runtime'
import { TASK_DEFAULT_GROUP_NAME } from '../../src/tasks/task-groups'
import type { TaskListMemberRole } from '../../src/tasks/task-lists'
import { dropTaskM4Fixtures, runSourceMutant, seedTaskActor, whileStructureLockHeld, type SeededTaskActor } from '../helpers/task-m4-fixtures'
import { startTasksListener, tasksClient, type TasksClient, type TasksListener } from '../helpers/tasks-http-harness'

/**
 * M4 PR-3a S5 (design task-m4-pr3a-backend-design-20260930.md §3.2, §4.2–§4.4, §10.4 list side,
 * §10.7 gate 13). List core routes: create, read, "my lists", rename, archive / unarchive, events.
 * ASSUMPTION(task-m4): [own-09] every row-level failure is one 404; list membership is decided
 * first. RULED(2026-10-07): [R13] no DELETE route. ASSUMPTION(task-m4): [own-15] [own-32]
 * `includeArchived`. [own-33] events: 404 before
 * paging, 404 with no org. [own-35] sort keys. [own-36] list event payloads.
 * HTTP goes through `tasksRouter()` on one express listener per file (tests/helpers/tasks-http-harness.ts;
 * setup.integration.ts, RBAC_TOKEN_TRUST='true');
 * the gate 13 cells use the real MetaSheetServer. Lists that the routes cannot produce in this
 * slice (members other than the creator, another org, a creator without a member row) are seeded
 * with SQL.
 */

if (process.env.EXPECT_DB !== '1') {
  throw new Error('task-m4-lists.db.test.ts requires EXPECT_DB=1')
}

const ORG_PREFIX = 'org_tasks_m4lcore_'
const seededUsers: string[] = []
const seededRoles: string[] = []

const req = createRequire(import.meta.url)
const EXPRESS_PATH = req.resolve('express')
const SUPERTEST_PATH = req.resolve('supertest')
const ROUTES_FILE = new URL('../../src/routes/tasks.ts', import.meta.url).pathname
const INDEX_FILE = new URL('../../src/index.ts', import.meta.url).pathname
const ACCESS_FILE = new URL('../../src/tasks/task-access.ts', import.meta.url).pathname
const LIST_ACCESS_FILE = new URL('../../src/tasks/task-list-access.ts', import.meta.url).pathname
const RECORDS_FILE = new URL('../../src/services/task-records.ts', import.meta.url).pathname
const LIST_RECORDS_FILE = new URL('../../src/services/task-list-records.ts', import.meta.url).pathname

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

/** The file's one listener (tests/helpers/tasks-http-harness.ts): `Connection: close`, no keep-alive. */
function app(): TasksClient {
  return tasksClient(listener?.baseUrl ?? '')
}

function auth(bearer: string): { Authorization: string } {
  return { Authorization: `Bearer ${bearer}` }
}

async function seedList(
  orgId: string,
  createdBy: string,
  members: Array<[string, TaskListMemberRole]>,
  opts: { taskIds?: string[]; archived?: boolean; name?: string; id?: string } = {},
): Promise<string> {
  const db = poolManager.get()
  const listId = opts.id ?? newTaskListId()
  await db.query(
    `INSERT INTO task_lists (id, org_id, name, created_by, archived_at)
     VALUES ($1, $2, $3, $4, CASE WHEN $5::boolean THEN now() ELSE NULL END)`,
    [listId, orgId, opts.name ?? '备料复核', createdBy, opts.archived === true],
  )
  for (const [userId, role] of members) {
    await db.query(`INSERT INTO task_list_members (list_id, user_id, role) VALUES ($1, $2, $3)`, [listId, userId, role])
  }
  for (const taskId of opts.taskIds ?? []) {
    await db.query(`INSERT INTO task_list_items (list_id, task_id, org_id) VALUES ($1, $2, $3)`, [listId, taskId, orgId])
  }
  return listId
}

async function addMember(listId: string, userId: string, role: TaskListMemberRole): Promise<void> {
  await poolManager.get().query(`INSERT INTO task_list_members (list_id, user_id, role) VALUES ($1, $2, $3)`, [listId, userId, role])
}

/** Everything a list write can touch, as one comparable string. */
async function listState(listId: string): Promise<string> {
  const db = poolManager.get()
  const list = await db.query(
    `SELECT id, org_id, name, created_by, archived_at, created_at, updated_at FROM task_lists WHERE id = $1`,
    [listId],
  )
  const members = await db.query(`SELECT user_id, role FROM task_list_members WHERE list_id = $1 ORDER BY user_id`, [listId])
  const events = await db.query(
    `SELECT id, actor_id, event_type, payload, occurred_at FROM task_list_events WHERE list_id = $1 ORDER BY id`,
    [listId],
  )
  const groups = await db.query(`SELECT id, name, position, is_default FROM task_groups WHERE list_id = $1 ORDER BY id`, [listId])
  return JSON.stringify({ list: list.rows, members: members.rows, events: events.rows, groups: groups.rows })
}

async function orgState(orgId: string): Promise<string> {
  const db = poolManager.get()
  const lists = await db.query(`SELECT id FROM task_lists WHERE org_id = $1 ORDER BY id`, [orgId])
  const states: string[] = []
  for (const row of lists.rows) states.push(await listState(String(row.id)))
  const taskEvents = await db.query(
    `SELECT count(*)::int AS n FROM task_events te JOIN tasks t ON t.id = te.task_id WHERE t.org_id = $1`,
    [orgId],
  )
  const groups = await db.query(`SELECT count(*)::int AS n FROM task_groups WHERE org_id = $1`, [orgId])
  return JSON.stringify({ states, taskEvents: taskEvents.rows[0].n, groups: groups.rows[0].n })
}

async function listEvents(listId: string): Promise<Array<Record<string, unknown>>> {
  const result = await poolManager.get().query(
    `SELECT actor_id, event_type, payload, occurred_at FROM task_list_events WHERE list_id = $1 ORDER BY occurred_at, id`,
    [listId],
  )
  return result.rows
}

async function listRow(listId: string): Promise<Record<string, unknown>> {
  const result = await poolManager.get().query(`SELECT * FROM task_lists WHERE id = $1`, [listId])
  return result.rows[0]
}

/** Whether the list row, its owner row, its default group and its `created` event share the list's
 * `created_at`, compared in SQL. */
async function createStamps(listId: string): Promise<Record<string, unknown>> {
  const result = await poolManager.get().query(
    `SELECT l.created_at = l.updated_at AS list,
            (SELECT bool_and(m.created_at = l.created_at) FROM task_list_members m WHERE m.list_id = l.id) AS owner,
            (SELECT bool_and(g.created_at = l.created_at AND g.updated_at = l.created_at) FROM task_groups g WHERE g.list_id = l.id) AS default_group,
            (SELECT bool_and(e.occurred_at = l.created_at) FROM task_list_events e WHERE e.list_id = l.id) AS event
       FROM task_lists l WHERE l.id = $1`,
    [listId],
  )
  return result.rows[0]
}

/** Whether the list's latest event of `type` carries the list row's `updated_at`, and (for an
 * archive) whether `archived_at` equals it, compared in SQL. */
async function writeStamps(listId: string, type: string): Promise<Record<string, unknown>> {
  const result = await poolManager.get().query(
    `SELECT (SELECT e.occurred_at FROM task_list_events e WHERE e.list_id = l.id AND e.event_type = $2
              ORDER BY e.occurred_at DESC, e.id DESC LIMIT 1) = l.updated_at AS event,
            l.archived_at IS NULL OR l.archived_at = l.updated_at AS archived
       FROM task_lists l WHERE l.id = $1`,
    [listId, type],
  )
  return result.rows[0]
}

afterAll(async () => {
  await dropTaskM4Fixtures({ orgPrefix: ORG_PREFIX, userIds: seededUsers, roleIds: seededRoles })
  await listener?.close()
})

// ---------------------------------------------------------------------------------------------
// POST /api/task-lists
// ---------------------------------------------------------------------------------------------

describe('create', () => {
  it('lists|create: 200 List with the caller as owner; owner row, default group and created event in one write', async () => {
    const stamp = stampOf()
    const orgId = orgOf('crt', stamp)
    const me = await actor('crt', stamp, orgId)
    const response = await app().post('/api/task-lists').set(auth(me.bearer)).send({ name: '  备料复核  ' })
    expect(response.status).toBe(200)
    const body = response.body
    expect(body).toEqual({
      id: expect.stringMatching(/^tlst_[A-Za-z0-9]+$/),
      name: '备料复核',
      createdBy: me.userId,
      ownerId: me.userId,
      archivedAt: null,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      myRole: 'owner',
    })
    const row = await listRow(body.id)
    expect(row.org_id).toBe(orgId)
    expect(row.name).toBe('备料复核')
    expect(row.icon).toBeNull()
    expect(new Date(String(body.createdAt)).getTime()).toBe((row.created_at as Date).getTime())
    expect(new Date(String(body.updatedAt)).getTime()).toBe((row.updated_at as Date).getTime())
    const db = poolManager.get()
    const members = await db.query(`SELECT user_id, role FROM task_list_members WHERE list_id = $1`, [body.id])
    expect(members.rows).toEqual([{ user_id: me.userId, role: 'owner' }])
    const groups = await db.query(
      `SELECT org_id, scope, list_id, user_id, name, position, is_default FROM task_groups WHERE list_id = $1`,
      [body.id],
    )
    expect(groups.rows).toEqual([{
      org_id: orgId, scope: 'list', list_id: body.id, user_id: null, name: TASK_DEFAULT_GROUP_NAME, position: 0, is_default: true,
    }])
    const events = await listEvents(body.id)
    expect(events.map((e) => [e.actor_id, e.event_type, e.payload])).toEqual([[me.userId, 'created', {}]])
    // One instant for the whole write, compared in SQL (microseconds kept).
    expect(await createStamps(body.id)).toEqual({ list: true, owner: true, default_group: true, event: true })
  })

  it('lists|create: a name of exactly 100 code points is accepted and NFC-normalized', async () => {
    const stamp = stampOf()
    const orgId = orgOf('crt100', stamp)
    const me = await actor('crt100', stamp, orgId)
    const name = '\u{1F600}'.repeat(100)
    const ok = await app().post('/api/task-lists').set(auth(me.bearer)).send({ name })
    expect(ok.status).toBe(200)
    expect(ok.body.name).toBe(name)
    const nfc = await app().post('/api/task-lists').set(auth(me.bearer)).send({ name: 'Café' })
    expect(nfc.status).toBe(200)
    expect(nfc.body.name).toBe('Café')
  })

  const INVALID_CREATE: Array<{ label: string; body: unknown; code: string }> = [
    { label: 'no name key', body: {}, code: 'INVALID_NAME' },
    { label: 'empty name', body: { name: '' }, code: 'INVALID_NAME' },
    { label: 'blank name', body: { name: ' \t ' }, code: 'INVALID_NAME' },
    { label: 'number name', body: { name: 7 }, code: 'INVALID_NAME' },
    { label: 'null name', body: { name: null }, code: 'INVALID_NAME' },
    { label: 'array name', body: { name: ['备料'] }, code: 'INVALID_NAME' },
    { label: 'array body', body: [{ name: '备料' }], code: 'INVALID_NAME' },
    { label: 'U+0000 in the name', body: { name: '备\u0000料' }, code: 'INVALID_NAME' },
    { label: 'lone surrogate in the name', body: { name: '备料\uD800' }, code: 'INVALID_NAME' },
    { label: '101 code points', body: { name: '\u{1F600}'.repeat(101) }, code: 'NAME_TOO_LONG' },
  ]

  it.each(INVALID_CREATE)('lists|create: $label is 422 $code and writes nothing', async ({ body, code }) => {
    const stamp = stampOf()
    const orgId = orgOf('crtbad', stamp)
    const me = await actor('crtbad', stamp, orgId)
    const before = await orgState(orgId)
    const response = await app().post('/api/task-lists').set(auth(me.bearer)).send(body as object)
    expect(response.status).toBe(422)
    expect(response.body).toEqual({ error: { code } })
    expect(await orgState(orgId)).toBe(before)
  })

  it('lists|create: no org claim is 422 ORG_MISSING before the body is read, nothing written', async () => {
    const stamp = stampOf()
    const orgId = orgOf('crtnoorg', stamp)
    const me = await actor('crtnoorg', stamp, orgId)
    const db = poolManager.get()
    const count = async () => Number((await db.query(`SELECT count(*)::int AS n FROM task_lists WHERE created_by = $1`, [me.userId])).rows[0].n)
    for (const body of [{ name: '备料' }, { name: '' }]) {
      const response = await app().post('/api/task-lists').set(auth(tokenFor(me, null))).send(body)
      expect(response.status).toBe(422)
      expect(response.body).toEqual({ error: { code: 'ORG_MISSING' } })
    }
    expect(await count()).toBe(0)
  })
})

// ---------------------------------------------------------------------------------------------
// GET /api/task-lists/:id
// ---------------------------------------------------------------------------------------------

describe('read', () => {
  it('lists|read: each member role reads the list with its own myRole and the owner id', async () => {
    const stamp = stampOf()
    const orgId = orgOf('rd', stamp)
    const owner = await actor('rdowner', stamp, orgId)
    const editor = await actor('rdedit', stamp, orgId)
    const reader = await actor('rdread', stamp, orgId)
    const created = await app().post('/api/task-lists').set(auth(owner.bearer)).send({ name: '备料' })
    const listId = created.body.id
    await addMember(listId, editor.userId, 'edit')
    await addMember(listId, reader.userId, 'read')
    for (const [who, role] of [[owner, 'owner'], [editor, 'edit'], [reader, 'read']] as const) {
      const response = await app().get(`/api/task-lists/${listId}`).set(auth(who.bearer))
      expect(response.status).toBe(200)
      expect(response.body).toEqual({ ...created.body, myRole: role })
    }
  })

  it('m4list|read: a same-org non-member gets the byte-identical 404 of a missing id', async () => {
    const stamp = stampOf()
    const orgId = orgOf('rdnm', stamp)
    const owner = await actor('rdnmowner', stamp, orgId)
    const outsider = await actor('rdnmout', stamp, orgId)
    const created = await app().post('/api/task-lists').set(auth(owner.bearer)).send({ name: '备料' })
    const hidden = await app().get(`/api/task-lists/${created.body.id}`).set(auth(outsider.bearer))
    const missing = await app().get(`/api/task-lists/tlst_missing${stamp}`).set(auth(outsider.bearer))
    expect(hidden.status).toBe(404)
    expect(missing.status).toBe(404)
    expect(hidden.text).toBe(missing.text)
    expect(hidden.text).toBe(NOT_FOUND_TEXT)
  })

  it('lists|read: path ids that cannot be stored and a missing org claim are the same 404', async () => {
    const stamp = stampOf()
    const orgId = orgOf('rdbad', stamp)
    const owner = await actor('rdbad', stamp, orgId)
    const created = await app().post('/api/task-lists').set(auth(owner.bearer)).send({ name: '备料' })
    for (const path of ['tlst_%00', `${created.body.id}%00`, 'tlst%20x', encodeURIComponent('清单')]) {
      const response = await app().get(`/api/task-lists/${path}`).set(auth(owner.bearer))
      expect(response.status).toBe(404)
      expect(response.text).toBe(NOT_FOUND_TEXT)
    }
    const noOrg = await app().get(`/api/task-lists/${created.body.id}`).set(auth(tokenFor(owner, null)))
    expect(noOrg.status).toBe(404)
    expect(noOrg.text).toBe(NOT_FOUND_TEXT)
  })

  it('m4list|read: a creator without a member row gets the 404 (membership is decided first)', async () => {
    const stamp = stampOf()
    const orgId = orgOf('rdcr', stamp)
    const creator = await actor('rdcr', stamp, orgId)
    const other = `usrO_rdcr_${stamp}`
    const listId = await seedList(orgId, creator.userId, [[other, 'owner']])
    const response = await app().get(`/api/task-lists/${listId}`).set(auth(creator.bearer))
    expect(response.status).toBe(404)
    expect(response.text).toBe(NOT_FOUND_TEXT)
  })
})

// ---------------------------------------------------------------------------------------------
// GET /api/task-lists
// ---------------------------------------------------------------------------------------------

describe('my lists', () => {
  it('lists|mine: only lists of the caller org where the caller is a member; archived only with includeArchived=true', async () => {
    const stamp = stampOf()
    const orgId = orgOf('mine', stamp)
    const otherOrg = orgOf('mineB', stamp)
    const me = await actor('mine', stamp, orgId)
    const someone = `usrO_mine_${stamp}`
    const asOwner = await seedList(orgId, me.userId, [[me.userId, 'owner']], { name: 'A' })
    const asReader = await seedList(orgId, someone, [[someone, 'owner'], [me.userId, 'read']], { name: 'B' })
    const archived = await seedList(orgId, me.userId, [[me.userId, 'owner']], { archived: true, name: 'C' })
    await seedList(orgId, someone, [[someone, 'owner']], { name: 'not mine' })
    await seedList(otherOrg, me.userId, [[me.userId, 'owner']], { name: 'other org' })
    const ids = (body: { items: Array<{ id: string }> }) => body.items.map((item) => item.id).sort()
    for (const query of [{}, { includeArchived: 'false' }]) {
      const response = await app().get('/api/task-lists').query(query).set(auth(me.bearer))
      expect(response.status).toBe(200)
      expect(Object.keys(response.body).sort()).toEqual(['items', 'total'])
      expect(ids(response.body)).toEqual([asOwner, asReader].sort())
      expect(response.body.total).toBe(2)
    }
    const all = await app().get('/api/task-lists').query({ includeArchived: 'true' }).set(auth(me.bearer))
    expect(all.status).toBe(200)
    expect(ids(all.body)).toEqual([asOwner, asReader, archived].sort())
    expect(all.body.total).toBe(3)
    const reader = all.body.items.find((item: { id: string }) => item.id === asReader)
    expect(reader).toEqual({
      id: asReader,
      name: 'B',
      createdBy: someone,
      ownerId: someone,
      archivedAt: null,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      myRole: 'read',
    })
    const archivedItem = all.body.items.find((item: { id: string }) => item.id === archived)
    expect(typeof archivedItem.archivedAt).toBe('string')
  })

  it('lists|mine: pages are disjoint and ordered by updated_at DESC, id DESC, ties included; a rename moves a list to the head', async () => {
    const stamp = stampOf()
    const orgId = orgOf('minepg', stamp)
    const me = await actor('minepg', stamp, orgId)
    const listIds: string[] = []
    // Ids ascend with i. The updated_at values disagree with that order, and L2, L3, L4 share one
    // (inserted in ascending id order), so both keys of updated_at DESC, id DESC decide something.
    // All are in the past, so a rename now makes its list the most recently updated.
    const updatedAt = ['2021-01-05', '2021-01-01', '2021-01-03', '2021-01-03', '2021-01-03', '2021-01-02']
    const db = poolManager.get()
    for (let i = 0; i < updatedAt.length; i += 1) {
      listIds.push(await seedList(orgId, me.userId, [[me.userId, 'owner']], { name: `L${i}`, id: `tlst_tie${i}${stamp}` }))
      await db.query(`UPDATE task_lists SET updated_at = $2::timestamptz WHERE id = $1`, [listIds[i], `${updatedAt[i]}T00:00:00Z`])
    }
    const expected = (await db.query(
      `SELECT id FROM task_lists WHERE id = ANY($1::text[]) ORDER BY updated_at DESC, id DESC`,
      [listIds],
    )).rows.map((row) => String(row.id))
    expect(expected).toEqual([0, 4, 3, 2, 5, 1].map((i) => listIds[i]))
    const page = async (offset: string) => {
      const response = await app().get('/api/task-lists').query({ limit: '2', offset }).set(auth(me.bearer))
      expect(response.status).toBe(200)
      expect(response.body.total).toBe(6)
      return response.body.items.map((item: { id: string }) => item.id) as string[]
    }
    const seen: string[] = []
    for (const offset of ['0', '2', '4']) seen.push(...await page(offset))
    expect(seen).toEqual(expected)
    const past = await app().get('/api/task-lists').query({ offset: '6' }).set(auth(me.bearer))
    expect(past.body).toEqual({ items: [], total: 6 })
    // The oldest list, renamed, is the most recently updated one.
    const renamed = await app().patch(`/api/task-lists/${listIds[1]}`).set(auth(me.bearer)).send({ name: '改名' })
    expect(renamed.status).toBe(200)
    expect(await page('0')).toEqual([listIds[1], listIds[0]])
  })

  const INVALID_MINE: Array<[string, string]> = [
    ['limit=0', 'INVALID_LIMIT'],
    ['limit=101', 'INVALID_LIMIT'],
    ['limit=01', 'INVALID_LIMIT'],
    ['offset=-1', 'INVALID_OFFSET'],
    ['offset=x', 'INVALID_OFFSET'],
    ['includeArchived=', 'INVALID_FILTER'],
    ['includeArchived=TRUE', 'INVALID_FILTER'],
    ['includeArchived=1', 'INVALID_FILTER'],
    ['includeArchived=yes', 'INVALID_FILTER'],
    ['includeArchived=true&includeArchived=true', 'INVALID_FILTER'],
    ['includeArchived[a]=true', 'INVALID_FILTER'],
    ['limit=0&includeArchived=x', 'INVALID_LIMIT'],
  ]

  it.each(INVALID_MINE)('lists|mine: ?%s is 422 %s', async (query, code) => {
    const stamp = stampOf()
    const orgId = orgOf('minebad', stamp)
    const me = await actor('minebad', stamp, orgId)
    const response = await app().get(`/api/task-lists?${query}`).set(auth(me.bearer))
    expect(response.status).toBe(422)
    expect(response.body).toEqual({ error: { code } })
  })

  it('lists|mine: no org claim is the degraded body without total, even with an invalid page', async () => {
    const stamp = stampOf()
    const orgId = orgOf('minenoorg', stamp)
    const me = await actor('minenoorg', stamp, orgId)
    await seedList(orgId, me.userId, [[me.userId, 'owner']])
    for (const query of ['', '?limit=0', '?includeArchived=x']) {
      const response = await app().get(`/api/task-lists${query}`).set(auth(tokenFor(me, null)))
      expect(response.status).toBe(200)
      expect(response.text).toBe(JSON.stringify({ items: [], degraded: true, reason: 'org_missing' }))
    }
  })
})

// ---------------------------------------------------------------------------------------------
// PATCH /api/task-lists/:id
// ---------------------------------------------------------------------------------------------

describe('rename', () => {
  it('lists|rename: edit and owner rename; one renamed event each; updated_at moves', async () => {
    const stamp = stampOf()
    const orgId = orgOf('ren', stamp)
    const owner = await actor('renowner', stamp, orgId)
    const editor = await actor('renedit', stamp, orgId)
    const created = await app().post('/api/task-lists').set(auth(owner.bearer)).send({ name: '备料' })
    const listId = created.body.id
    await addMember(listId, editor.userId, 'edit')
    const before = await listRow(listId)
    const byEditor = await app().patch(`/api/task-lists/${listId}`).set(auth(editor.bearer)).send({ name: '  复核  ' })
    expect(byEditor.status).toBe(200)
    expect(byEditor.body).toEqual({ ...created.body, name: '复核', updatedAt: expect.any(String), myRole: 'edit' })
    const after = await listRow(listId)
    expect(after.name).toBe('复核')
    expect((after.updated_at as Date).getTime()).toBeGreaterThan((before.updated_at as Date).getTime())
    expect(new Date(byEditor.body.updatedAt).getTime()).toBe((after.updated_at as Date).getTime())
    expect(await writeStamps(listId, 'renamed')).toEqual({ event: true, archived: true })
    const byOwner = await app().patch(`/api/task-lists/${listId}`).set(auth(owner.bearer)).send({ name: '备料复核' })
    expect(byOwner.status).toBe(200)
    expect(byOwner.body.name).toBe('备料复核')
    expect(await writeStamps(listId, 'renamed')).toEqual({ event: true, archived: true })
    const events = await listEvents(listId)
    expect(events.map((e) => [e.actor_id, e.event_type, e.payload])).toEqual([
      [owner.userId, 'created', {}],
      [editor.userId, 'renamed', {}],
      [owner.userId, 'renamed', {}],
    ])
  })

  it('lists|rename: the same name (after trimming and NFC) is a no-op: 200, no event, updated_at unchanged', async () => {
    const stamp = stampOf()
    const orgId = orgOf('rennoop', stamp)
    const owner = await actor('rennoop', stamp, orgId)
    const created = await app().post('/api/task-lists').set(auth(owner.bearer)).send({ name: 'Café' })
    const listId = created.body.id
    const before = await listState(listId)
    for (const name of ['Café', '  Café ']) {
      const response = await app().patch(`/api/task-lists/${listId}`).set(auth(owner.bearer)).send({ name })
      expect(response.status).toBe(200)
      expect(response.body).toEqual(created.body)
    }
    expect(await listState(listId)).toBe(before)
  })

  it.each(INVALID_CREATE_BODIES())('lists|rename: the owner sending $label gets 422 $code, list unchanged', async ({ body, code }) => {
    const stamp = stampOf()
    const orgId = orgOf('renbad', stamp)
    const owner = await actor('renbad', stamp, orgId)
    const created = await app().post('/api/task-lists').set(auth(owner.bearer)).send({ name: '备料' })
    const before = await listState(created.body.id)
    const response = await app().patch(`/api/task-lists/${created.body.id}`).set(auth(owner.bearer)).send(body as object)
    expect(response.status).toBe(422)
    expect(response.body).toEqual({ error: { code } })
    expect(await listState(created.body.id)).toBe(before)
  })

  it('m4list|rename: a read member and a non-member get the 404 of a missing id for valid and invalid bodies; nothing written', async () => {
    const stamp = stampOf()
    const orgId = orgOf('renro', stamp)
    const owner = await actor('renroowner', stamp, orgId)
    const reader = await actor('renroread', stamp, orgId)
    const outsider = await actor('renroout', stamp, orgId)
    const created = await app().post('/api/task-lists').set(auth(owner.bearer)).send({ name: '备料' })
    const listId = created.body.id
    await addMember(listId, reader.userId, 'read')
    const before = await orgState(orgId)
    for (const who of [reader, outsider]) {
      for (const body of [{ name: '复核' }, { name: '' }, { name: '\u{1F600}'.repeat(101) }, {}]) {
        const hidden = await app().patch(`/api/task-lists/${listId}`).set(auth(who.bearer)).send(body)
        const missing = await app().patch(`/api/task-lists/tlst_missing${stamp}`).set(auth(who.bearer)).send(body)
        expect(hidden.status).toBe(404)
        expect(hidden.text).toBe(missing.text)
        expect(hidden.text).toBe(NOT_FOUND_TEXT)
      }
    }
    expect(await orgState(orgId)).toBe(before)
  })

  it('lists|rename: no org claim is 422 ORG_MISSING, nothing written', async () => {
    const stamp = stampOf()
    const orgId = orgOf('rennoorg', stamp)
    const owner = await actor('rennoorg', stamp, orgId)
    const created = await app().post('/api/task-lists').set(auth(owner.bearer)).send({ name: '备料' })
    const before = await listState(created.body.id)
    const response = await app().patch(`/api/task-lists/${created.body.id}`).set(auth(tokenFor(owner, null))).send({ name: '复核' })
    expect(response.status).toBe(422)
    expect(response.body).toEqual({ error: { code: 'ORG_MISSING' } })
    expect(await listState(created.body.id)).toBe(before)
  })
})

function INVALID_CREATE_BODIES(): Array<{ label: string; body: unknown; code: string }> {
  return [
    { label: 'no name key', body: {}, code: 'INVALID_NAME' },
    { label: 'blank name', body: { name: '   ' }, code: 'INVALID_NAME' },
    { label: 'null name', body: { name: null }, code: 'INVALID_NAME' },
    { label: 'U+0000 in the name', body: { name: '备\u0000料' }, code: 'INVALID_NAME' },
    { label: 'lone surrogate in the name', body: { name: '\uDC00备料' }, code: 'INVALID_NAME' },
    { label: '101 code points', body: { name: '\u{1F600}'.repeat(101) }, code: 'NAME_TOO_LONG' },
  ]
}

// ---------------------------------------------------------------------------------------------
// POST /api/task-lists/:id/archive, /unarchive
// ---------------------------------------------------------------------------------------------

describe('archive', () => {
  it('lists|archive: an editor archives and unarchives; repeats are no-ops; one instant per write', async () => {
    const stamp = stampOf()
    const orgId = orgOf('arc', stamp)
    const owner = await actor('arcowner', stamp, orgId)
    const editor = await actor('arcedit', stamp, orgId)
    const created = await app().post('/api/task-lists').set(auth(owner.bearer)).send({ name: '备料' })
    const listId = created.body.id
    await addMember(listId, editor.userId, 'edit')
    const archived = await app().post(`/api/task-lists/${listId}/archive`).set(auth(editor.bearer))
    expect(archived.status).toBe(200)
    expect(archived.body).toEqual({ ...created.body, archivedAt: expect.any(String), updatedAt: expect.any(String), myRole: 'edit' })
    const row = await listRow(listId)
    expect(row.archived_at).not.toBeNull()
    expect(new Date(archived.body.archivedAt).getTime()).toBe((row.archived_at as Date).getTime())
    let events = await listEvents(listId)
    expect(events.map((e) => [e.actor_id, e.event_type, e.payload])).toEqual([[owner.userId, 'created', {}], [editor.userId, 'archived', {}]])
    // archived_at = updated_at = the event's occurred_at, compared in SQL (microseconds kept).
    expect(await writeStamps(listId, 'archived')).toEqual({ event: true, archived: true })

    const stateArchived = await listState(listId)
    const again = await app().post(`/api/task-lists/${listId}/archive`).set(auth(editor.bearer))
    expect(again.status).toBe(200)
    expect(again.body).toEqual(archived.body)
    expect(await listState(listId)).toBe(stateArchived)

    const restored = await app().post(`/api/task-lists/${listId}/unarchive`).set(auth(editor.bearer))
    expect(restored.status).toBe(200)
    expect(restored.body.archivedAt).toBeNull()
    const restoredRow = await listRow(listId)
    expect(restoredRow.archived_at).toBeNull()
    expect((restoredRow.updated_at as Date).getTime()).toBeGreaterThan((row.updated_at as Date).getTime())
    expect(await writeStamps(listId, 'unarchived')).toEqual({ event: true, archived: true })
    const stateRestored = await listState(listId)
    const again2 = await app().post(`/api/task-lists/${listId}/unarchive`).set(auth(editor.bearer))
    expect(again2.status).toBe(200)
    expect(again2.body).toEqual(restored.body)
    expect(await listState(listId)).toBe(stateRestored)
    events = await listEvents(listId)
    expect(events.map((e) => e.event_type)).toEqual(['created', 'archived', 'unarchived'])
  })

  it('m4list|archive: a read member and a non-member get the 404 of a missing id on both routes; nothing written', async () => {
    const stamp = stampOf()
    const orgId = orgOf('arcro', stamp)
    const owner = await actor('arcroowner', stamp, orgId)
    const reader = await actor('arcroread', stamp, orgId)
    const outsider = await actor('arcroout', stamp, orgId)
    const open = (await app().post('/api/task-lists').set(auth(owner.bearer)).send({ name: '开' })).body.id
    const closed = (await app().post('/api/task-lists').set(auth(owner.bearer)).send({ name: '关' })).body.id
    await app().post(`/api/task-lists/${closed}/archive`).set(auth(owner.bearer))
    await addMember(open, reader.userId, 'read')
    await addMember(closed, reader.userId, 'read')
    const before = await orgState(orgId)
    for (const who of [reader, outsider]) {
      for (const [listId, action] of [[open, 'archive'], [closed, 'unarchive'], [open, 'unarchive'], [closed, 'archive']] as const) {
        const hidden = await app().post(`/api/task-lists/${listId}/${action}`).set(auth(who.bearer))
        const missing = await app().post(`/api/task-lists/tlst_missing${stamp}/${action}`).set(auth(who.bearer))
        expect(hidden.status).toBe(404)
        expect(hidden.text).toBe(missing.text)
        expect(hidden.text).toBe(NOT_FOUND_TEXT)
      }
    }
    expect(await orgState(orgId)).toBe(before)
  })

  it('m4list|archive: the list creator archives and unarchives at read role', async () => {
    const stamp = stampOf()
    const orgId = orgOf('arccr', stamp)
    const creator = await actor('arccr', stamp, orgId)
    const other = `usrO_arccr_${stamp}`
    const listId = await seedList(orgId, creator.userId, [[other, 'owner'], [creator.userId, 'read']])
    const archived = await app().post(`/api/task-lists/${listId}/archive`).set(auth(creator.bearer))
    expect(archived.status).toBe(200)
    expect(typeof archived.body.archivedAt).toBe('string')
    expect(archived.body.myRole).toBe('read')
    // The creator is not the owner here, so createdBy and ownerId are told apart.
    expect(archived.body.createdBy).toBe(creator.userId)
    expect(archived.body.ownerId).toBe(other)
    const restored = await app().post(`/api/task-lists/${listId}/unarchive`).set(auth(creator.bearer))
    expect(restored.status).toBe(200)
    expect(restored.body.archivedAt).toBeNull()
    expect([restored.body.createdBy, restored.body.ownerId]).toEqual([creator.userId, other])
    expect((await listEvents(listId)).map((e) => [e.actor_id, e.event_type])).toEqual([
      [creator.userId, 'archived'],
      [creator.userId, 'unarchived'],
    ])
    const renamed = await app().patch(`/api/task-lists/${listId}`).set(auth(creator.bearer)).send({ name: '复核' })
    expect(renamed.status).toBe(404)
  })

  it('m4list|archive: the list creator without a member row gets the 404 (membership is decided first)', async () => {
    const stamp = stampOf()
    const orgId = orgOf('arcnr', stamp)
    const creator = await actor('arcnr', stamp, orgId)
    const other = `usrO_arcnr_${stamp}`
    const listId = await seedList(orgId, creator.userId, [[other, 'owner']])
    const archivedId = await seedList(orgId, creator.userId, [[other, 'owner']], { archived: true })
    const before = await orgState(orgId)
    for (const [id, action] of [[listId, 'archive'], [archivedId, 'unarchive']] as const) {
      const response = await app().post(`/api/task-lists/${id}/${action}`).set(auth(creator.bearer))
      expect(response.status).toBe(404)
      expect(response.text).toBe(NOT_FOUND_TEXT)
    }
    expect(await orgState(orgId)).toBe(before)
  })

  it('lists|archive: no org claim is 422 ORG_MISSING on both routes, nothing written', async () => {
    const stamp = stampOf()
    const orgId = orgOf('arcnoorg', stamp)
    const owner = await actor('arcnoorg', stamp, orgId)
    const listId = (await app().post('/api/task-lists').set(auth(owner.bearer)).send({ name: '备料' })).body.id
    const before = await listState(listId)
    for (const action of ['archive', 'unarchive']) {
      const response = await app().post(`/api/task-lists/${listId}/${action}`).set(auth(tokenFor(owner, null)))
      expect(response.status).toBe(422)
      expect(response.body).toEqual({ error: { code: 'ORG_MISSING' } })
    }
    expect(await listState(listId)).toBe(before)
  })

  it('m4list|archived list: members still read it; the assignee pending list, badge and assigned view are unchanged', async () => {
    const stamp = stampOf()
    const orgId = orgOf('arcpend', stamp)
    const me = await actor('arcpend', stamp, orgId)
    const yesterday = await poolManager.get().query(`SELECT ((now() AT TIME ZONE 'UTC')::date - 1)::text AS d`)
    const task = await createTask({
      orgId, creatorId: me.userId, title: '逾期备料', assignees: [me.userId], completionMode: 'all',
      dueDate: String(yesterday.rows[0].d), timeZone: 'UTC',
    })
    const listId = (await app().post('/api/task-lists').set(auth(me.bearer)).send({ name: '备料' })).body.id
    await poolManager.get().query(`INSERT INTO task_list_items (list_id, task_id, org_id) VALUES ($1, $2, $3)`, [listId, task.id, orgId])
    const observe = async () => {
      const server = app()
      const pending = await server.get('/api/tasks/pending').set(auth(me.bearer)).set('x-viewer-time-zone', 'UTC')
      const badge = await server.get('/api/tasks/pending-count').set(auth(me.bearer)).set('x-viewer-time-zone', 'UTC')
      const assigned = await server.get('/api/tasks').query({ view: 'assigned' }).set(auth(me.bearer))
      const detail = await server.get(`/api/tasks/${task.id}`).set(auth(me.bearer))
      return { pending: pending.body, badge: badge.body, assigned: assigned.body, detail: detail.status }
    }
    const before = await observe()
    expect(before.badge).toEqual({ count: 1 })
    expect(before.pending.total).toBe(1)
    expect(before.assigned.items.map((row: { id: string }) => row.id)).toEqual([task.id])
    const archived = await app().post(`/api/task-lists/${listId}/archive`).set(auth(me.bearer))
    expect(archived.status).toBe(200)
    expect(await observe()).toEqual(before)
    const read = await app().get(`/api/task-lists/${listId}`).set(auth(me.bearer))
    expect(read.status).toBe(200)
    expect(read.body.archivedAt).toBe(archived.body.archivedAt)
  })

  // Archiving changes no task's visibility or editability (design §3.2): role resolution never reads
  // `archived_at`. The two members below hold list identity only (the task's creator and assignee is
  // someone else), so the list is the only thing that lets them read, comment or edit.
  it('m4list|archived list: a list-only reader still reads the task and comments; a list-only editor still PATCHes and comments', async () => {
    const stamp = stampOf()
    const orgId = orgOf('arcvis', stamp)
    const owner = await actor('arcvisowner', stamp, orgId)
    const reader = await actor('arcvisread', stamp, orgId)
    const editor = await actor('arcvisedit', stamp, orgId)
    const other = `usrO_arcvis_${stamp}`
    const task = await createTask({ orgId, creatorId: other, title: '备料复核', assignees: [other], completionMode: 'all' })
    const listId = (await app().post('/api/task-lists').set(auth(owner.bearer)).send({ name: '备料' })).body.id
    await addMember(listId, reader.userId, 'read')
    await addMember(listId, editor.userId, 'edit')
    await poolManager.get().query(`INSERT INTO task_list_items (list_id, task_id, org_id) VALUES ($1, $2, $3)`, [listId, task.id, orgId])
    const server = app()
    const detail = (who: SeededTaskActor) => server.get(`/api/tasks/${task.id}`).set(auth(who.bearer))
    const comment = (who: SeededTaskActor, body: string) => server.post(`/api/tasks/${task.id}/comments`).set(auth(who.bearer)).send({ body })
    const patch = (expectedVersion: number, title: string) =>
      server.patch(`/api/tasks/${task.id}`).set(auth(editor.bearer)).send({ expectedVersion, title })

    const first = await patch(1, '备料复核一')
    expect(first.status).toBe(200)
    expect(first.body).toEqual({ id: task.id, version: 2 })
    expect((await comment(editor, 'editor before')).status).toBe(200)
    expect((await comment(reader, 'reader before')).status).toBe(200)
    const readerBefore = await detail(reader)
    const editorBefore = await detail(editor)
    expect(readerBefore.status).toBe(200)
    expect([readerBefore.body.canEdit, readerBefore.body.canComment]).toEqual([false, true])
    expect(editorBefore.status).toBe(200)
    expect([editorBefore.body.canEdit, editorBefore.body.canComment]).toEqual([true, true])

    const archived = await server.post(`/api/task-lists/${listId}/archive`).set(auth(owner.bearer))
    expect(archived.status).toBe(200)
    expect(typeof archived.body.archivedAt).toBe('string')

    const readerAfter = await detail(reader)
    const editorAfter = await detail(editor)
    expect(readerAfter.status).toBe(200)
    expect(readerAfter.body).toEqual(readerBefore.body)
    expect(editorAfter.status).toBe(200)
    expect(editorAfter.body).toEqual(editorBefore.body)
    const second = await patch(2, '备料复核二')
    expect(second.status).toBe(200)
    expect(second.body).toEqual({ id: task.id, version: 3 })
    expect((await comment(editor, 'editor after')).status).toBe(200)
    expect((await comment(reader, 'reader after')).status).toBe(200)
    const comments = await server.get(`/api/tasks/${task.id}/comments`).set(auth(reader.bearer))
    expect(comments.status).toBe(200)
    expect(comments.body.items.map((item: { body: string; authorId: string }) => [item.authorId, item.body])).toEqual([
      [editor.userId, 'editor before'],
      [reader.userId, 'reader before'],
      [editor.userId, 'editor after'],
      [reader.userId, 'reader after'],
    ])
  })

  it('negative control 3: a pending condition that drops tasks of archived lists removes the pending row', async () => {
    const stamp = stampOf()
    const orgId = orgOf('nc3', stamp)
    const me = await actor('nc3', stamp, orgId)
    const yesterday = await poolManager.get().query(`SELECT ((now() AT TIME ZONE 'UTC')::date - 1)::text AS d`)
    const task = await createTask({
      orgId, creatorId: me.userId, title: '逾期备料', assignees: [me.userId], completionMode: 'all',
      dueDate: String(yesterday.rows[0].d), timeZone: 'UTC',
    })
    await seedList(orgId, me.userId, [[me.userId, 'owner']], { taskIds: [task.id], archived: true })
    const rows = await listPending({ orgId, actorId: me.userId, viewerTz: 'UTC' })
    expect(rows.map((row) => row.id)).toEqual([task.id])
    expect(await countPending({ orgId, actorId: me.userId, viewerTz: 'UTC' })).toBe(1)
    expect((await listTasks({ orgId, actorId: me.userId, view: 'assigned' })).map((row) => row.id)).toEqual([task.id])
    const archivedFilter =
      "tasks.status = 'open' AND NOT EXISTS (SELECT 1 FROM task_list_items nc3_tli JOIN task_lists nc3_tl " +
      'ON nc3_tl.id = nc3_tli.list_id WHERE nc3_tli.task_id = tasks.id AND nc3_tl.archived_at IS NOT NULL)'
    runSourceMutant(ACCESS_FILE, "tasks.status = 'open'", archivedFilter, `
      const { listPending, countPending } = await import(${JSON.stringify(RECORDS_FILE)})
      const rows = await listPending({ orgId: ${JSON.stringify(orgId)}, actorId: ${JSON.stringify(me.userId)}, viewerTz: 'UTC' })
      const count = await countPending({ orgId: ${JSON.stringify(orgId)}, actorId: ${JSON.stringify(me.userId)}, viewerTz: 'UTC' })
      console.log(JSON.stringify({ nc3: 'red', rows: rows.length, count }))
      process.exit(rows.length === 0 && count === 0 ? 0 : 1)
    `, {}, { unique: true })
  }, 180000)
})

// ---------------------------------------------------------------------------------------------
// Write instants (design §4.4): a list write takes its instant after the structure lock is held.
// ---------------------------------------------------------------------------------------------

describe('write instants', () => {
  it('lists|stamps: create, rename, archive and unarchive queued behind the structure lock are stamped after it; each row and its event share one reading; the feed is in commit order', async () => {
    const stamp = stampOf()
    const orgId = orgOf('stmp', stamp)
    const owner = await actor('stmp', stamp, orgId)
    const db = poolManager.get()
    const laterThan = async (column: string, listId: string, holderAt: string) =>
      (await db.query(`SELECT ${column} > $2::timestamptz AS later FROM task_lists WHERE id = $1`, [listId, holderAt])).rows[0].later

    const created = await whileStructureLockHeld(orgId, () =>
      app().post('/api/task-lists').set(auth(owner.bearer)).send({ name: '备料' }).then((res) => res))
    expect(created.result.status).toBe(200)
    const listId = String(created.result.body.id)
    expect(await laterThan('created_at', listId, created.holderAt)).toBe(true)
    expect(await createStamps(listId)).toEqual({ list: true, owner: true, default_group: true, event: true })

    // While each request waits, the holder writes an event of its own, which commits first: the
    // request's event must be the newer of the two.
    const steps = [
      { type: 'renamed', send: () => app().patch(`/api/task-lists/${listId}`).set(auth(owner.bearer)).send({ name: '复核' }) },
      { type: 'archived', send: () => app().post(`/api/task-lists/${listId}/archive`).set(auth(owner.bearer)) },
      { type: 'unarchived', send: () => app().post(`/api/task-lists/${listId}/unarchive`).set(auth(owner.bearer)) },
    ]
    const labels = new Map<string, string>()
    for (const [index, step] of steps.entries()) {
      const holderEvent = `tlev_hold${index}${stamp}`
      labels.set(holderEvent, `holder${index}`)
      const queued = await whileStructureLockHeld(orgId, () => step.send().then((res) => res), async (holder) => {
        await holder.query(
          `INSERT INTO task_list_events (id, list_id, actor_id, event_type, occurred_at)
           VALUES ($1, $2, $3, 'renamed', clock_timestamp())`,
          [holderEvent, listId, owner.userId],
        )
      })
      expect(queued.result.status).toBe(200)
      expect(await laterThan('updated_at', listId, queued.holderAt)).toBe(true)
      expect(await writeStamps(listId, step.type)).toEqual({ event: true, archived: true })
    }
    const feed = await app().get(`/api/task-lists/${listId}/events`).set(auth(owner.bearer))
    expect(feed.status).toBe(200)
    expect(feed.body.items.map((item: { id: string; eventType: string }) => labels.get(item.id) ?? item.eventType)).toEqual([
      'unarchived', 'holder2', 'archived', 'holder1', 'renamed', 'holder0', 'created',
    ])
  }, 120000)
})

// ---------------------------------------------------------------------------------------------
// GET /api/task-lists/:id/events
// ---------------------------------------------------------------------------------------------

describe('events', () => {
  it('lists|events: members read the list events newest first; other lists are not included', async () => {
    const stamp = stampOf()
    const orgId = orgOf('ev', stamp)
    const owner = await actor('evowner', stamp, orgId)
    const reader = await actor('evread', stamp, orgId)
    const listId = (await app().post('/api/task-lists').set(auth(owner.bearer)).send({ name: '备料' })).body.id
    await app().post('/api/task-lists').set(auth(owner.bearer)).send({ name: '另一张' })
    await app().patch(`/api/task-lists/${listId}`).set(auth(owner.bearer)).send({ name: '复核' })
    await app().post(`/api/task-lists/${listId}/archive`).set(auth(owner.bearer))
    await app().post(`/api/task-lists/${listId}/unarchive`).set(auth(owner.bearer))
    await addMember(listId, reader.userId, 'read')
    const response = await app().get(`/api/task-lists/${listId}/events`).set(auth(reader.bearer))
    expect(response.status).toBe(200)
    expect(Object.keys(response.body).sort()).toEqual(['items', 'total'])
    expect(response.body.total).toBe(4)
    expect(response.body.items.map((item: { eventType: string }) => item.eventType)).toEqual(['unarchived', 'archived', 'renamed', 'created'])
    const stored = await poolManager.get().query(
      `SELECT id, occurred_at FROM task_list_events WHERE list_id = $1 AND event_type = 'created'`,
      [listId],
    )
    expect(response.body.items[3]).toEqual({
      id: stored.rows[0].id,
      listId,
      actorId: owner.userId,
      eventType: 'created',
      payload: {},
      occurredAt: (stored.rows[0].occurred_at as Date).toISOString(),
    })
  })

  it('lists|events: pages are disjoint and ordered by occurred_at DESC, id DESC, ties included', async () => {
    const stamp = stampOf()
    const orgId = orgOf('evpg', stamp)
    const owner = await actor('evpg', stamp, orgId)
    const listId = (await app().post('/api/task-lists').set(auth(owner.bearer)).send({ name: '备料' })).body.id
    const db = poolManager.get()
    for (let i = 0; i < 4; i += 1) {
      await db.query(
        `INSERT INTO task_list_events (id, list_id, actor_id, event_type, occurred_at)
         VALUES ($1, $2, $3, 'renamed', '2031-01-01T00:00:00Z')`,
        [`tlev_tie${i}${stamp}`, listId, owner.userId],
      )
    }
    const expected = (await db.query(
      `SELECT id FROM task_list_events WHERE list_id = $1 ORDER BY occurred_at DESC, id DESC`,
      [listId],
    )).rows.map((row) => String(row.id))
    expect(expected).toHaveLength(5)
    const seen: string[] = []
    for (const offset of ['0', '2', '4']) {
      const page = await app().get(`/api/task-lists/${listId}/events`).query({ limit: '2', offset }).set(auth(owner.bearer))
      expect(page.status).toBe(200)
      expect(page.body.total).toBe(5)
      seen.push(...page.body.items.map((item: { id: string }) => item.id))
    }
    expect(seen).toEqual(expected)
  })

  it('m4list|events: a non-member gets the 404 of a missing id, also with an invalid page; a member with an invalid page gets 422', async () => {
    const stamp = stampOf()
    const orgId = orgOf('evnm', stamp)
    const owner = await actor('evnmowner', stamp, orgId)
    const outsider = await actor('evnmout', stamp, orgId)
    const listId = (await app().post('/api/task-lists').set(auth(owner.bearer)).send({ name: '备料' })).body.id
    for (const query of ['', '?limit=0', '?offset=-1']) {
      const hidden = await app().get(`/api/task-lists/${listId}/events${query}`).set(auth(outsider.bearer))
      const missing = await app().get(`/api/task-lists/tlst_missing${stamp}/events${query}`).set(auth(outsider.bearer))
      expect(hidden.status).toBe(404)
      expect(hidden.text).toBe(missing.text)
      expect(hidden.text).toBe(NOT_FOUND_TEXT)
    }
    const badLimit = await app().get(`/api/task-lists/${listId}/events?limit=0`).set(auth(owner.bearer))
    expect(badLimit.status).toBe(422)
    expect(badLimit.body).toEqual({ error: { code: 'INVALID_LIMIT' } })
    const badOffset = await app().get(`/api/task-lists/${listId}/events?offset=-1`).set(auth(owner.bearer))
    expect(badOffset.body).toEqual({ error: { code: 'INVALID_OFFSET' } })
    const noOrg = await app().get(`/api/task-lists/${listId}/events`).set(auth(tokenFor(owner, null)))
    expect(noOrg.status).toBe(404)
    expect(noOrg.text).toBe(NOT_FOUND_TEXT)
  })
})

// ---------------------------------------------------------------------------------------------
// Permission code per route (rbacGuard) and R13 (no list DELETE).
// ---------------------------------------------------------------------------------------------

describe('permission codes and R13', () => {
  type CodeRoute = {
    label: string
    code: 'read' | 'write'
    method: 'get' | 'post' | 'patch'
    path: (listId: string) => string
    body?: Record<string, unknown>
  }
  const CODE_ROUTES: CodeRoute[] = [
    { label: 'POST /api/task-lists', code: 'write', method: 'post', path: () => '/api/task-lists', body: { name: '备料' } },
    { label: 'PATCH /api/task-lists/:id', code: 'write', method: 'patch', path: (id) => `/api/task-lists/${id}`, body: { name: '复核' } },
    { label: 'POST /api/task-lists/:id/archive', code: 'write', method: 'post', path: (id) => `/api/task-lists/${id}/archive` },
    { label: 'POST /api/task-lists/:id/unarchive', code: 'write', method: 'post', path: (id) => `/api/task-lists/${id}/unarchive` },
    { label: 'GET /api/task-lists', code: 'read', method: 'get', path: () => '/api/task-lists' },
    { label: 'GET /api/task-lists/:id', code: 'read', method: 'get', path: (id) => `/api/task-lists/${id}` },
    { label: 'GET /api/task-lists/:id/events', code: 'read', method: 'get', path: (id) => `/api/task-lists/${id}/events` },
  ]

  it.each(CODE_ROUTES)('lists|codes: $label needs tasks:$code; the other code alone is 403 and nothing is written', async (route) => {
    const stamp = stampOf()
    const orgId = orgOf('codes', stamp)
    const owner = await actor('codesowner', stamp, orgId)
    const wrong = await actor('codeswrong', stamp, orgId, [route.code === 'write' ? 'tasks:read' : 'tasks:write'])
    const right = await actor('codesright', stamp, orgId, [`tasks:${route.code}`])
    const listId = (await app().post('/api/task-lists').set(auth(owner.bearer)).send({ name: '备料' })).body.id
    await addMember(listId, wrong.userId, 'edit')
    await addMember(listId, right.userId, 'edit')
    const send = (who: SeededTaskActor) => {
      const call = app()[route.method](route.path(listId)).set(auth(who.bearer))
      return route.body === undefined ? call : call.send(route.body)
    }
    const before = await orgState(orgId)
    const denied = await send(wrong)
    expect(denied.status).toBe(403)
    expect(denied.body).toEqual({ error: 'Insufficient permissions' })
    expect(await orgState(orgId)).toBe(before)
    const allowed = await send(right)
    expect(allowed.status).toBe(200)
  })

  it('lists|R13: there is no DELETE for a list; the request is 404 and the list and its rows stay', async () => {
    const stamp = stampOf()
    const orgId = orgOf('r13', stamp)
    const owner = await actor('r13', stamp, orgId)
    const listId = (await app().post('/api/task-lists').set(auth(owner.bearer)).send({ name: '备料' })).body.id
    const before = await listState(listId)
    const response = await app().delete(`/api/task-lists/${listId}`).set(auth(owner.bearer))
    expect(response.status).toBe(404)
    expect(await listState(listId)).toBe(before)
    const router = tasksRouter()
    if (!router) throw new Error('tasks router not mounted')
    const deletes = (router.stack as unknown as Array<{ route?: { path: string; methods: Record<string, boolean> } }>)
      .filter((layer) => layer.route && ['/api/task-lists', '/api/task-lists/:id'].includes(layer.route.path) && layer.route.methods.delete)
    expect(deletes).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------
// §10.4 second tenant (list) and negative control 2.
// ---------------------------------------------------------------------------------------------

describe('second tenant', () => {
  it('m4list|second tenant: a member of a list in org B holding an org A token cannot see or write it', async () => {
    const stamp = stampOf()
    const orgA = orgOf('stA', stamp)
    const orgB = orgOf('stB', stamp)
    const me = await actor('st', stamp, orgA)
    const listA = await seedList(orgA, me.userId, [[me.userId, 'edit']], { name: '同形' })
    const listB = await seedList(orgB, me.userId, [[me.userId, 'edit']], { name: '同形' })
    const server = app()
    const mine = await server.get('/api/task-lists').set(auth(me.bearer))
    expect(mine.status).toBe(200)
    expect(mine.body.items.map((item: { id: string }) => item.id)).toEqual([listA])
    expect((await server.get(`/api/task-lists/${listA}`).set(auth(me.bearer))).status).toBe(200)
    const missingRead = await server.get(`/api/task-lists/tlst_missing${stamp}`).set(auth(me.bearer))
    const before = await orgState(orgB)
    for (const [method, path, body] of [
      ['get', `/api/task-lists/${listB}`, undefined],
      ['get', `/api/task-lists/${listB}/events`, undefined],
      ['patch', `/api/task-lists/${listB}`, { name: '复核' }],
      ['post', `/api/task-lists/${listB}/archive`, undefined],
      ['post', `/api/task-lists/${listB}/unarchive`, undefined],
    ] as const) {
      const call = server[method](path).set(auth(me.bearer))
      const response = body === undefined ? await call : await call.send(body)
      expect(response.status).toBe(404)
      expect(response.text).toBe(missingRead.text)
    }
    expect(await orgState(orgB)).toBe(before)
    const asB = await server.get(`/api/task-lists/${listB}`).set(auth(tokenFor(me, orgB)))
    expect(asB.status).toBe(200)
    expect(asB.body.id).toBe(listB)
  })

  it('negative control 2: an always-true list org clause lets the org A token read the org B list', async () => {
    const stamp = stampOf()
    const orgA = orgOf('nc2A', stamp)
    const orgB = orgOf('nc2B', stamp)
    const me = await actor('nc2', stamp, orgA)
    const listB = await seedList(orgB, me.userId, [[me.userId, 'edit']])
    expect((await app().get(`/api/task-lists/${listB}`).set(auth(me.bearer))).status).toBe(404)
    runSourceMutant(LIST_ACCESS_FILE, '(task_lists.org_id = ${ORG_PLACEHOLDER}) AND ', '(${ORG_PLACEHOLDER}::text IS NOT NULL) AND ', `
      process.env.TASKS_ENABLED = 'true'
      const express = (await import(${JSON.stringify(EXPRESS_PATH)})).default
      const request = (await import(${JSON.stringify(SUPERTEST_PATH)})).default
      const { tasksRouter } = await import(${JSON.stringify(ROUTES_FILE)})
      const { listTaskLists } = await import(${JSON.stringify(LIST_RECORDS_FILE)})
      const server = express()
      server.use(express.json())
      server.use(tasksRouter())
      const detail = await request(server).get('/api/task-lists/' + ${JSON.stringify(listB)}).set('Authorization', 'Bearer ' + ${JSON.stringify(me.bearer)})
      const mine = await listTaskLists({ orgId: ${JSON.stringify(orgA)}, actorId: ${JSON.stringify(me.userId)}, query: {} })
      const listed = mine.items.map((item) => item.id).includes(${JSON.stringify(listB)})
      console.log(JSON.stringify({ nc2: 'red', status: detail.status, listed }))
      process.exit(detail.status === 200 && detail.body.id === ${JSON.stringify(listB)} && listed ? 0 : 1)
    `, {}, { unique: true })
  }, 180000)
})

// ---------------------------------------------------------------------------------------------
// §10.7 gate 13 for the list routes: real MetaSheetServer, then the registration line commented out.
// ---------------------------------------------------------------------------------------------

describe('gate 13 (lists)', () => {
  const REGISTRATION = '  registerTaskListRoutes(router)\n'

  function server(): express.Express {
    const instance = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [], manageProcessSignals: false })
    return (instance as unknown as { app: express.Express }).app
  }

  it('gate13|MetaSheetServer serves GET /api/task-lists to a non-admin; an unregistered sibling path is 404', async () => {
    const stamp = stampOf()
    const orgId = orgOf('g13p', stamp)
    const me = await actor('g13p', stamp, orgId, ['tasks:read'])
    const listId = await seedList(orgId, me.userId, [[me.userId, 'owner']])
    const mounted = server()
    const lists = await request(mounted).get('/api/task-lists').set(auth(me.bearer))
    expect(lists.status).toBe(200)
    expect(lists.body.total).toBe(1)
    expect(lists.body.items.map((item: { id: string }) => item.id)).toEqual([listId])
    const sibling = await request(mounted).get('/api/task-lists-not-a-route').set(auth(me.bearer))
    expect(sibling.status).toBe(404)
    // The registered route's own 404 (a list id that does not exist) is not the framework's: the
    // negative control below can tell the two apart.
    const missingPath = `/api/task-lists/tlst_missing${stamp}`
    const missing = await request(mounted).get(missingPath).set(auth(me.bearer))
    expect(missing.status).toBe(404)
    const shape = (res: { text: string }, path: string) => res.text.split(path).join('<path>')
    expect(shape(missing, missingPath)).not.toBe(shape(sibling, '/api/task-lists-not-a-route'))
  })

  it('gate13|negative: with the registration line commented out the list route is 404 and the router still mounts', async () => {
    const stamp = stampOf()
    const orgId = orgOf('g13n', stamp)
    const me = await actor('g13n', stamp, orgId, ['tasks:read'])
    runSourceMutant(ROUTES_FILE, REGISTRATION, `  // ${REGISTRATION.trimStart()}`, `
      const supertestMod = await import(${JSON.stringify(SUPERTEST_PATH)})
      const request = supertestMod.default ?? supertestMod
      const { MetaSheetServer } = await import(${JSON.stringify(INDEX_FILE)})
      const instance = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [], manageProcessSignals: false })
      const bearer = 'Bearer ' + process.env.G13_BEARER
      const lists = await request(instance.app).get('/api/task-lists').set('Authorization', bearer)
      const sibling = await request(instance.app).get('/api/task-lists-not-a-route').set('Authorization', bearer)
      const context = await request(instance.app).get('/api/tasks/context').set('Authorization', bearer)
      // The framework's 404 body names the path; with the path taken out it is the same for every
      // unregistered path, and differs from the route's own JSON 404.
      const shape = (res, path) => res.text.split(path).join('<path>')
      const unregistered = lists.status === 404 && shape(lists, '/api/task-lists') === shape(sibling, '/api/task-lists-not-a-route')
      const orgResolved = context.status === 200 && context.body.orgId === process.env.G13_ORG
      console.log(JSON.stringify({ gate13lists: 'red', lists: lists.status, unregistered, context: context.status, orgResolved }))
      process.exit(unregistered && orgResolved ? 0 : 1)
    `, { G13_BEARER: me.bearer, G13_ORG: orgId }, { unique: true, timeoutMs: 240000 })
  }, 300000)
})
