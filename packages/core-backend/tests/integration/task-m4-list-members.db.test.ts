import '../helpers/assert-rbac-optional-off'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import jwt from 'jsonwebtoken'
import { poolManager } from '../../src/integration/db/connection-pool'
import { createTask } from '../../src/services/task-records'
import { newTaskListId } from '../../src/services/task-ids-runtime'
import { TASK_LIST_MEMBER_SOFT_LIMIT, type TaskListMemberRole } from '../../src/tasks/task-lists'
import { dropTaskM4Fixtures, seedOrgMembers, seedTaskActor, whileStructureLockHeld, type SeededTaskActor } from '../helpers/task-m4-fixtures'
import { rawRequest, startTasksListener, tasksClient, type TasksClient, type TasksListener } from '../helpers/tasks-http-harness'

/**
 * M4 PR-3a S6 (design task-m4-pr3a-backend-design-20260930.md §3.3, §4.3, §4.6, §10.4 list side).
 * List members and ownership: the roster, add a member, change a role, remove a member (a manager,
 * or a member leaving), transfer ownership.
 * ASSUMPTION(task-m4): [own-09] every row-level failure is the 404 of a missing list, and membership
 * is decided first; [own-14] a member leaves through the same DELETE; [own-27] the target of a
 * transfer must be active in the org, as RULED(2026-10-07): [R17] requires of a user written into
 * a list; ASSUMPTION(task-m4): [own-40] the roster is in byte order; [own-41] the member id is
 * checked before the role; [own-42] the roster read is 404 before paging and without an org claim.
 * HTTP goes through `tasksRouter()` on one listener per file (tests/helpers/tasks-http-harness.ts;
 * setup.integration.ts, RBAC_TOKEN_TRUST='true'). What the routes cannot produce, or a cell does not
 * exercise through them (a list whose creator is not its owner, a member id without an org
 * membership, a full roster), is seeded with SQL.
 */

if (process.env.EXPECT_DB !== '1') {
  throw new Error('task-m4-list-members.db.test.ts requires EXPECT_DB=1')
}

const ORG_PREFIX = 'org_tasks_m4lmem_'
const seededUsers: string[] = []
const seededRoles: string[] = []

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

/** A user who can be written into a list: `users` + `user_orgs` (active unless said otherwise). */
async function orgUser(label: string, stamp: string, orgId: string, opts: { active?: boolean } = {}): Promise<string> {
  const userId = `usr_${label}_${stamp}`
  await seedOrgMembers(orgId, [userId], opts)
  seededUsers.push(userId)
  return userId
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

function port(): number {
  if (!listener) throw new Error('tasks listener not started')
  return listener.port
}

function auth(bearer: string): { Authorization: string } {
  return { Authorization: `Bearer ${bearer}` }
}

async function seedList(
  orgId: string,
  createdBy: string,
  members: Array<[string, TaskListMemberRole]>,
  opts: { taskIds?: string[]; name?: string } = {},
): Promise<string> {
  const db = poolManager.get()
  const listId = newTaskListId()
  await db.query(
    `INSERT INTO task_lists (id, org_id, name, created_by) VALUES ($1, $2, $3, $4)`,
    [listId, orgId, opts.name ?? '备料复核', createdBy],
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

/** A list created through the route by `owner`, with the given members added by SQL. */
async function listVia(owner: SeededTaskActor, members: Array<[string, TaskListMemberRole]> = []): Promise<string> {
  const created = await app().post('/api/task-lists').set(auth(owner.bearer)).send({ name: '备料复核' })
  expect(created.status).toBe(200)
  for (const [userId, role] of members) await addMember(created.body.id, userId, role)
  return created.body.id
}

async function memberRows(listId: string): Promise<Array<{ user_id: string; role: string; created_at: Date }>> {
  const result = await poolManager.get().query(
    `SELECT user_id, role, created_at FROM task_list_members WHERE list_id = $1 ORDER BY user_id COLLATE "C"`,
    [listId],
  )
  return result.rows as Array<{ user_id: string; role: string; created_at: Date }>
}

/** The write body every member route answers, read back from the database. */
async function roster(listId: string): Promise<{ id: string; members: Array<{ userId: string; role: string }> }> {
  return { id: listId, members: (await memberRows(listId)).map((row) => ({ userId: row.user_id, role: row.role })) }
}

/** Everything a member write can touch, as one comparable string. */
async function listState(listId: string): Promise<string> {
  const db = poolManager.get()
  const list = await db.query(
    `SELECT id, org_id, name, created_by, archived_at, created_at, updated_at FROM task_lists WHERE id = $1`,
    [listId],
  )
  const members = await db.query(`SELECT user_id, role, created_at FROM task_list_members WHERE list_id = $1 ORDER BY user_id`, [listId])
  const events = await db.query(
    `SELECT id, actor_id, event_type, payload, occurred_at FROM task_list_events WHERE list_id = $1 ORDER BY id`,
    [listId],
  )
  return JSON.stringify({ list: list.rows, members: members.rows, events: events.rows })
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
  return JSON.stringify({ states, taskEvents: taskEvents.rows[0].n })
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

function eventsOf(rows: Array<Record<string, unknown>>): unknown[] {
  return rows.map((e) => [e.actor_id, e.event_type, e.payload])
}

/**
 * Paths whose bytes must reach the server exactly as written go through `rawRequest`; everything
 * else goes through the file's client.
 */
async function send(
  method: 'get' | 'post' | 'patch' | 'delete',
  path: string,
  bearer: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; text: string }> {
  if (/\/\.\.?(\/|$)/.test(path)) {
    const response = await rawRequest(port(), method.toUpperCase(), path, bearer, body)
    return { status: response.status, text: response.text }
  }
  const call = app()[method](path).set(auth(bearer))
  const response = body === undefined ? await call : await call.send(body)
  return { status: response.status, text: response.text }
}

afterAll(async () => {
  await dropTaskM4Fixtures({ orgPrefix: ORG_PREFIX, userIds: seededUsers, roleIds: seededRoles })
  await listener?.close()
})

// ---------------------------------------------------------------------------------------------
// GET /api/task-lists/:id/members
// ---------------------------------------------------------------------------------------------

describe('roster', () => {
  it('members|roster: members read the roster in byte order with createdAt and total; pages are disjoint and ordered', async () => {
    const stamp = stampOf()
    const orgId = orgOf('ros', stamp)
    const owner = await actor('rosowner', stamp, orgId)
    const reader = await actor('rosread', stamp, orgId)
    // Mixed case, so byte order and a locale collation disagree ('Z' < 'a' < 'u' in bytes).
    const ids = [`Zeta_ros_${stamp}`, `alpha_ros_${stamp}`, `Beta_ros_${stamp}`, `usrO_ros_${stamp}`]
    const listId = await listVia(owner, ids.map((id, i) => [id, i % 2 === 0 ? 'read' : 'edit'] as [string, TaskListMemberRole]))
    await addMember(listId, reader.userId, 'read')
    // A second list with members in the same org: the roster and its total cover one list only.
    await seedList(orgId, owner.userId, [[owner.userId, 'owner'], [`Mid_ros_${stamp}`, 'edit'], [`aaa_ros_${stamp}`, 'read']])
    // JS string order is UTF-16 code unit order: byte order for these printable ASCII ids.
    const expected = [...ids, owner.userId, reader.userId].sort()
    const response = await app().get(`/api/task-lists/${listId}/members`).set(auth(reader.bearer))
    expect(response.status).toBe(200)
    expect(Object.keys(response.body).sort()).toEqual(['items', 'total'])
    expect(response.body.total).toBe(expected.length)
    expect(response.body.items.map((item: { userId: string }) => item.userId)).toEqual(expected)
    const rows = await memberRows(listId)
    expect(response.body.items).toEqual(rows.map((row) => ({ userId: row.user_id, role: row.role, createdAt: row.created_at.toISOString() })))
    const seen: string[] = []
    for (const offset of ['0', '2', '4']) {
      const page = await app().get(`/api/task-lists/${listId}/members`).query({ limit: '2', offset }).set(auth(owner.bearer))
      expect(page.status).toBe(200)
      expect(page.body.total).toBe(6)
      seen.push(...page.body.items.map((item: { userId: string }) => item.userId))
    }
    expect(seen).toEqual(expected)
    const past = await app().get(`/api/task-lists/${listId}/members`).query({ offset: '6' }).set(auth(owner.bearer))
    expect(past.body).toEqual({ items: [], total: 6 })
  })

  it('m4list|roster: a non-member gets the 404 of a missing id, also with an invalid page; a member with an invalid page gets 422; no org claim is 404', async () => {
    const stamp = stampOf()
    const orgId = orgOf('rosnm', stamp)
    const owner = await actor('rosnmowner', stamp, orgId)
    const outsider = await actor('rosnmout', stamp, orgId)
    const listId = await listVia(owner)
    for (const query of ['', '?limit=0', '?offset=-1']) {
      const hidden = await app().get(`/api/task-lists/${listId}/members${query}`).set(auth(outsider.bearer))
      const missing = await app().get(`/api/task-lists/tlst_missing${stamp}/members${query}`).set(auth(outsider.bearer))
      expect(hidden.status).toBe(404)
      expect(hidden.text).toBe(missing.text)
      expect(hidden.text).toBe(NOT_FOUND_TEXT)
      expect(hidden.text).not.toContain(owner.userId)
    }
    const badLimit = await app().get(`/api/task-lists/${listId}/members?limit=101`).set(auth(owner.bearer))
    expect(badLimit.status).toBe(422)
    expect(badLimit.body).toEqual({ error: { code: 'INVALID_LIMIT' } })
    const badOffset = await app().get(`/api/task-lists/${listId}/members?offset=x`).set(auth(owner.bearer))
    expect(badOffset.body).toEqual({ error: { code: 'INVALID_OFFSET' } })
    const noOrg = await app().get(`/api/task-lists/${listId}/members`).set(auth(tokenFor(owner, null)))
    expect(noOrg.status).toBe(404)
    expect(noOrg.text).toBe(NOT_FOUND_TEXT)
  })
})

// ---------------------------------------------------------------------------------------------
// POST /api/task-lists/:id/members
// ---------------------------------------------------------------------------------------------

describe('add', () => {
  it('members|add: an editor and the owner add a read and an edit member; roster, rows, member_added events naming the target; the list row is untouched', async () => {
    const stamp = stampOf()
    const orgId = orgOf('add', stamp)
    const owner = await actor('addowner', stamp, orgId)
    const editor = await actor('addedit', stamp, orgId)
    const listId = await listVia(owner, [[editor.userId, 'edit']])
    const a = await orgUser('addA', stamp, orgId)
    const b = await orgUser('addB', stamp, orgId)
    const before = await listRow(listId)
    const first = await app().post(`/api/task-lists/${listId}/members`).set(auth(editor.bearer)).send({ userId: a, role: 'read' })
    expect(first.status).toBe(200)
    expect(first.body).toEqual(await roster(listId))
    expect(first.body.members).toContainEqual({ userId: a, role: 'read' })
    const second = await app().post(`/api/task-lists/${listId}/members`).set(auth(owner.bearer)).send({ userId: b, role: 'edit' })
    expect(second.status).toBe(200)
    expect(second.body).toEqual(await roster(listId))
    expect(second.body.members).toEqual(
      [[owner.userId, 'owner'], [editor.userId, 'edit'], [a, 'read'], [b, 'edit']]
        .sort(([x], [y]) => (x < y ? -1 : 1))
        .map(([userId, role]) => ({ userId, role })),
    )
    expect(eventsOf(await listEvents(listId))).toEqual([
      [owner.userId, 'created', {}],
      [editor.userId, 'member_added', { targetUserId: a }],
      [owner.userId, 'member_added', { targetUserId: b }],
    ])
    const after = await listRow(listId)
    expect((after.updated_at as Date).getTime()).toBe((before.updated_at as Date).getTime())
    const read = await app().get(`/api/task-lists/${listId}`).set(auth(owner.bearer))
    expect(read.body.updatedAt).toBe((before.updated_at as Date).toISOString())
  })

  it('members|add: re-adding an existing member, with another role or being the caller, is a no-op: 200, same roster, nothing written', async () => {
    const stamp = stampOf()
    const orgId = orgOf('addnoop', stamp)
    const owner = await actor('addnoop', stamp, orgId)
    const reader = await orgUser('addnoopR', stamp, orgId)
    const listId = await listVia(owner, [[reader, 'read']])
    const before = await listState(listId)
    for (const body of [{ userId: reader, role: 'edit' }, { userId: reader, role: 'read' }, { userId: owner.userId, role: 'read' }]) {
      const response = await app().post(`/api/task-lists/${listId}/members`).set(auth(owner.bearer)).send(body)
      expect(response.status).toBe(200)
      expect(response.body).toEqual(await roster(listId))
    }
    expect(await listState(listId)).toBe(before)
  })

  it('m4list|add: a read member and a non-member get the 404 of a missing id for any body; nothing written', async () => {
    const stamp = stampOf()
    const orgId = orgOf('addro', stamp)
    const owner = await actor('addroowner', stamp, orgId)
    const reader = await actor('addroread', stamp, orgId)
    const outsider = await actor('addroout', stamp, orgId)
    const target = await orgUser('addroT', stamp, orgId)
    const listId = await listVia(owner, [[reader.userId, 'read']])
    const before = await orgState(orgId)
    for (const who of [reader, outsider]) {
      for (const body of [{ userId: target, role: 'read' }, { userId: target, role: 'owner' }, { userId: '..', role: 'read' }, {}]) {
        const hidden = await app().post(`/api/task-lists/${listId}/members`).set(auth(who.bearer)).send(body)
        const missing = await app().post(`/api/task-lists/tlst_missing${stamp}/members`).set(auth(who.bearer)).send(body)
        expect(hidden.status).toBe(404)
        expect(hidden.text).toBe(missing.text)
        expect(hidden.text).toBe(NOT_FOUND_TEXT)
      }
    }
    expect(await orgState(orgId)).toBe(before)
  })

  it('m4list|add: role owner, or anything outside read/edit, is 422 INVALID_ROLE from an edit member; the list keeps exactly one owner row', async () => {
    const stamp = stampOf()
    const orgId = orgOf('addown', stamp)
    const owner = await actor('addownowner', stamp, orgId)
    const editor = await actor('addownedit', stamp, orgId)
    const target = await orgUser('addownT', stamp, orgId)
    const listId = await listVia(owner, [[editor.userId, 'edit']])
    const before = await listState(listId)
    for (const role of ['owner', 'admin', 'Read', '', 7, null, undefined, ['read']]) {
      const response = await app().post(`/api/task-lists/${listId}/members`).set(auth(editor.bearer)).send({ userId: target, role })
      expect(response.status).toBe(422)
      expect(response.body).toEqual({ error: { code: 'INVALID_ROLE' } })
    }
    expect(await listState(listId)).toBe(before)
    const owners = await poolManager.get().query(`SELECT user_id FROM task_list_members WHERE list_id = $1 AND role = 'owner'`, [listId])
    expect(owners.rows).toEqual([{ user_id: owner.userId }])
  })

  it('members|add: an invalid userId is 422 INVALID_MEMBER, before the role is read', async () => {
    const stamp = stampOf()
    const orgId = orgOf('addbad', stamp)
    const owner = await actor('addbad', stamp, orgId)
    const listId = await listVia(owner)
    const before = await listState(listId)
    const bodies: unknown[] = [
      {},
      { userId: '', role: 'read' },
      { userId: '.', role: 'read' },
      { userId: '..', role: 'read' },
      { userId: 'usr\u0000x', role: 'read' },
      { userId: 'usr x', role: 'read' },
      { userId: 'x'.repeat(256), role: 'read' },
      { userId: 7, role: 'read' },
      { userId: ['usr'], role: 'read' },
      // [own-41]: the member id is checked first, so this is INVALID_MEMBER, not INVALID_ROLE.
      { userId: '..', role: 'owner' },
      [{ userId: 'usr', role: 'read' }],
    ]
    for (const body of bodies) {
      const response = await app().post(`/api/task-lists/${listId}/members`).set(auth(owner.bearer)).send(body as object)
      expect(response.status).toBe(422)
      expect(response.body).toEqual({ error: { code: 'INVALID_MEMBER' } })
    }
    expect(await listState(listId)).toBe(before)
  })

  type Inactive = { label: string; seed: (stamp: string, orgId: string) => Promise<string> }
  const INACTIVE: Inactive[] = [
    { label: 'a user of another org', seed: (stamp, orgId) => orgUser('r17other', stamp, orgOf('r17B', stamp.slice(0, 6)) + orgId.slice(-6)) },
    { label: 'a user with users.is_active = false', seed: async (stamp, orgId) => {
      const userId = await orgUser('r17user', stamp, orgId)
      await poolManager.get().query(`UPDATE users SET is_active = false WHERE id = $1`, [userId])
      return userId
    } },
    { label: 'a user with user_orgs.is_active = false', seed: (stamp, orgId) => orgUser('r17org', stamp, orgId, { active: false }) },
    { label: 'an unknown user id', seed: async (stamp) => `usr_r17none_${stamp}` },
    // The account half of the login test: both is_active columns true, the account refused.
    { label: "a user whose role is 'disabled'", seed: async (stamp, orgId) => {
      const userId = await orgUser('r17dis', stamp, orgId)
      await poolManager.get().query(`UPDATE users SET role = 'disabled' WHERE id = $1`, [userId])
      return userId
    } },
    { label: 'a user pending activation', seed: async (stamp, orgId) => {
      const userId = await orgUser('r17pend', stamp, orgId)
      await poolManager.get().query(`UPDATE users SET activation_status = 'pending_activation' WHERE id = $1`, [userId])
      return userId
    } },
  ]

  it.each(INACTIVE)('m4list|add: $label is 422 INACTIVE_ORG_MEMBER; nothing written', async ({ seed }) => {
    const stamp = stampOf()
    const orgId = orgOf('r17', stamp)
    const owner = await actor('r17owner', stamp, orgId)
    const listId = await listVia(owner)
    const target = await seed(stamp, orgId)
    const before = await listState(listId)
    const response = await app().post(`/api/task-lists/${listId}/members`).set(auth(owner.bearer)).send({ userId: target, role: 'read' })
    expect(response.status).toBe(422)
    expect(response.body).toEqual({ error: { code: 'INACTIVE_ORG_MEMBER' } })
    expect(await listState(listId)).toBe(before)
  })

  it('members|add: the member soft limit is 422 LIMIT; an existing member at the limit is still a no-op', async () => {
    const stamp = stampOf()
    const orgId = orgOf('addlim', stamp)
    const owner = await actor('addlim', stamp, orgId)
    const extra = await orgUser('addlimX', stamp, orgId)
    const listId = await listVia(owner)
    for (let i = 1; i < TASK_LIST_MEMBER_SOFT_LIMIT; i += 1) await addMember(listId, `usrL${i}_addlim_${stamp}`, 'read')
    expect((await memberRows(listId)).length).toBe(TASK_LIST_MEMBER_SOFT_LIMIT)
    const before = await listState(listId)
    const over = await app().post(`/api/task-lists/${listId}/members`).set(auth(owner.bearer)).send({ userId: extra, role: 'read' })
    expect(over.status).toBe(422)
    expect(over.body).toEqual({ error: { code: 'LIMIT' } })
    const existing = await app().post(`/api/task-lists/${listId}/members`).set(auth(owner.bearer)).send({ userId: `usrL1_addlim_${stamp}`, role: 'edit' })
    expect(existing.status).toBe(200)
    expect(existing.body.members).toHaveLength(TASK_LIST_MEMBER_SOFT_LIMIT)
    expect(await listState(listId)).toBe(before)
  })
})

// ---------------------------------------------------------------------------------------------
// PATCH /api/task-lists/:id/members/:userId
// ---------------------------------------------------------------------------------------------

describe('change role', () => {
  it('members|role: a manager demotes edit to read and promotes read to edit; member_role_changed events; the same role is a no-op', async () => {
    const stamp = stampOf()
    const orgId = orgOf('role', stamp)
    const owner = await actor('roleowner', stamp, orgId)
    const editor = await actor('roleedit', stamp, orgId)
    const a = `usrA_role_${stamp}`
    const b = `usrB_role_${stamp}`
    const listId = await listVia(owner, [[editor.userId, 'edit'], [a, 'edit'], [b, 'read']])
    // Both targets belong to a second list too (a owns and created it, b reads it): a role change
    // names one list's row only.
    const otherList = await seedList(orgId, a, [[a, 'owner'], [b, 'read']])
    const otherBefore = await listState(otherList)
    const before = await listRow(listId)
    const demote = await app().patch(`/api/task-lists/${listId}/members/${a}`).set(auth(editor.bearer)).send({ role: 'read' })
    expect(demote.status).toBe(200)
    expect(demote.body).toEqual(await roster(listId))
    expect(demote.body.members).toContainEqual({ userId: a, role: 'read' })
    const promote = await app().patch(`/api/task-lists/${listId}/members/${b}`).set(auth(owner.bearer)).send({ role: 'edit' })
    expect(promote.status).toBe(200)
    expect(promote.body.members).toContainEqual({ userId: b, role: 'edit' })
    const state = await listState(listId)
    const same = await app().patch(`/api/task-lists/${listId}/members/${b}`).set(auth(owner.bearer)).send({ role: 'edit' })
    expect(same.status).toBe(200)
    expect(same.body).toEqual(promote.body)
    expect(await listState(listId)).toBe(state)
    expect(eventsOf(await listEvents(listId))).toEqual([
      [owner.userId, 'created', {}],
      [editor.userId, 'member_role_changed', { targetUserId: a }],
      [owner.userId, 'member_role_changed', { targetUserId: b }],
    ])
    expect(((await listRow(listId)).updated_at as Date).getTime()).toBe((before.updated_at as Date).getTime())
    expect(await listState(otherList)).toBe(otherBefore)
    expect((await memberRows(otherList)).map((row) => [row.user_id, row.role])).toEqual([[a, 'owner'], [b, 'read']].sort(([x], [y]) => (x < y ? -1 : 1)))
  })

  it('m4list|role: the owner cannot be re-roled: 422 OWNER_MUST_TRANSFER, the row unchanged', async () => {
    const stamp = stampOf()
    const orgId = orgOf('roleown', stamp)
    const owner = await actor('roleownowner', stamp, orgId)
    const editor = await actor('roleownedit', stamp, orgId)
    const listId = await listVia(owner, [[editor.userId, 'edit']])
    const before = await listState(listId)
    for (const who of [editor, owner]) {
      for (const role of ['read', 'edit']) {
        const response = await app().patch(`/api/task-lists/${listId}/members/${owner.userId}`).set(auth(who.bearer)).send({ role })
        expect(response.status).toBe(422)
        expect(response.body).toEqual({ error: { code: 'OWNER_MUST_TRANSFER' } })
      }
    }
    expect(await listState(listId)).toBe(before)
  })

  it('m4list|role: a target that is not a member is the 404 of a missing list; an invalid role, owner included, is 422 INVALID_ROLE from either manager for any target; the list keeps exactly one owner row', async () => {
    const stamp = stampOf()
    const orgId = orgOf('rolenm', stamp)
    const owner = await actor('rolenm', stamp, orgId)
    const editor = await actor('rolenmedit', stamp, orgId)
    const stranger = await orgUser('rolenmS', stamp, orgId)
    const reader = `usrR_rolenm_${stamp}`
    const listId = await listVia(owner, [[editor.userId, 'edit'], [reader, 'read']])
    const before = await listState(listId)
    const hidden = await app().patch(`/api/task-lists/${listId}/members/${stranger}`).set(auth(owner.bearer)).send({ role: 'read' })
    const missing = await app().patch(`/api/task-lists/tlst_missing${stamp}/members/${stranger}`).set(auth(owner.bearer)).send({ role: 'read' })
    expect(hidden.status).toBe(404)
    expect(hidden.text).toBe(missing.text)
    expect(hidden.text).toBe(NOT_FOUND_TEXT)
    // §10.4: an edit member naming `owner` for a read or an edit member is INVALID_ROLE, never a
    // second owner row (and never the unique index's violation answered as a 500).
    for (const who of [owner, editor]) {
      for (const target of [stranger, owner.userId, reader, editor.userId]) {
        for (const role of ['owner', 'admin', undefined]) {
          const response = await app().patch(`/api/task-lists/${listId}/members/${target}`).set(auth(who.bearer)).send({ role })
          expect(response.status).toBe(422)
          expect(response.body).toEqual({ error: { code: 'INVALID_ROLE' } })
        }
      }
    }
    expect(await listState(listId)).toBe(before)
    const owners = await poolManager.get().query(`SELECT user_id FROM task_list_members WHERE list_id = $1 AND role = 'owner'`, [listId])
    expect(owners.rows).toEqual([{ user_id: owner.userId }])
  })

  it('m4list|role: a read member and a non-member get the 404 of a missing id for any body and any target; nothing written', async () => {
    const stamp = stampOf()
    const orgId = orgOf('rolero', stamp)
    const owner = await actor('roleroowner', stamp, orgId)
    const reader = await actor('roleroread', stamp, orgId)
    const outsider = await actor('roleroout', stamp, orgId)
    const other = `usrO_rolero_${stamp}`
    const listId = await listVia(owner, [[reader.userId, 'read'], [other, 'edit']])
    const before = await orgState(orgId)
    for (const who of [reader, outsider]) {
      for (const target of [other, who.userId, '..', 'usr%00x']) {
        for (const body of [{ role: 'read' }, { role: 'owner' }, {}]) {
          const hidden = await send('patch', `/api/task-lists/${listId}/members/${target}`, who.bearer, body)
          const missing = await send('patch', `/api/task-lists/tlst_missing${stamp}/members/${target}`, who.bearer, body)
          expect(hidden.status).toBe(404)
          expect(hidden.text).toBe(missing.text)
          expect(hidden.text).toBe(NOT_FOUND_TEXT)
        }
      }
    }
    expect(await orgState(orgId)).toBe(before)
  })

  it('members|role: an invalid path id is 422 INVALID_MEMBER for a manager, before the body', async () => {
    const stamp = stampOf()
    const orgId = orgOf('rolebad', stamp)
    const owner = await actor('rolebad', stamp, orgId)
    const listId = await listVia(owner)
    const before = await listState(listId)
    for (const segment of ['.', '..', 'usr%00x', 'usr%20x', 'x'.repeat(256)]) {
      for (const body of [{ role: 'read' }, { role: 'owner' }]) {
        const response = await rawRequest(port(), 'PATCH', `/api/task-lists/${listId}/members/${segment}`, owner.bearer, body)
        expect(response.status).toBe(422)
        expect(response.body).toEqual({ error: { code: 'INVALID_MEMBER' } })
      }
    }
    expect(await listState(listId)).toBe(before)
  })

  it('m4list|role: an edit member demotes the creator to read; the creator still archives and unarchives, and cannot rename', async () => {
    const stamp = stampOf()
    const orgId = orgOf('rolecr', stamp)
    const creator = await actor('rolecr', stamp, orgId)
    const editor = await actor('rolecredit', stamp, orgId)
    const other = `usrO_rolecr_${stamp}`
    // The creator holds `edit`; `other` owns the list (seeded, since a route-created list makes its creator the owner).
    const listId = await seedList(orgId, creator.userId, [[other, 'owner'], [creator.userId, 'edit'], [editor.userId, 'edit']])
    const demote = await app().patch(`/api/task-lists/${listId}/members/${creator.userId}`).set(auth(editor.bearer)).send({ role: 'read' })
    expect(demote.status).toBe(200)
    expect(demote.body.members).toContainEqual({ userId: creator.userId, role: 'read' })
    const archived = await app().post(`/api/task-lists/${listId}/archive`).set(auth(creator.bearer))
    expect(archived.status).toBe(200)
    expect(archived.body.myRole).toBe('read')
    expect(typeof archived.body.archivedAt).toBe('string')
    const restored = await app().post(`/api/task-lists/${listId}/unarchive`).set(auth(creator.bearer))
    expect(restored.status).toBe(200)
    expect(restored.body.archivedAt).toBeNull()
    const renamed = await app().patch(`/api/task-lists/${listId}`).set(auth(creator.bearer)).send({ name: '复核' })
    expect(renamed.status).toBe(404)
    expect(renamed.text).toBe(NOT_FOUND_TEXT)
  })
})

// ---------------------------------------------------------------------------------------------
// DELETE /api/task-lists/:id/members/:userId
// ---------------------------------------------------------------------------------------------

describe('remove', () => {
  it('m4list|remove: a same-org non-member deleting themselves gets the 404 of a missing list: same bytes, no event, no member id in the body', async () => {
    const stamp = stampOf()
    const orgId = orgOf('rmnm', stamp)
    const owner = await actor('rmnmowner', stamp, orgId)
    const outsider = await actor('rmnmout', stamp, orgId)
    const other = `usrO_rmnm_${stamp}`
    const listId = await listVia(owner, [[other, 'edit']])
    const before = await orgState(orgId)
    for (const target of [outsider.userId, other, owner.userId, '..', '.', 'usr%00x']) {
      const hidden = await send('delete', `/api/task-lists/${listId}/members/${target}`, outsider.bearer)
      const missing = await send('delete', `/api/task-lists/tlst_missing${stamp}/members/${target}`, outsider.bearer)
      expect(hidden.status).toBe(404)
      expect(hidden.text).toBe(missing.text)
      expect(hidden.text).toBe(NOT_FOUND_TEXT)
      for (const id of [owner.userId, other, outsider.userId]) expect(hidden.text).not.toContain(id)
    }
    expect(await orgState(orgId)).toBe(before)
  })

  it('m4list|remove: a member removed through the route who deletes themselves again gets the same 404, and the roster read is 404 too', async () => {
    const stamp = stampOf()
    const orgId = orgOf('rmfmr', stamp)
    const owner = await actor('rmfmrowner', stamp, orgId)
    const former = await actor('rmfmrformer', stamp, orgId)
    const listId = await listVia(owner, [[former.userId, 'edit']])
    const removed = await app().delete(`/api/task-lists/${listId}/members/${former.userId}`).set(auth(owner.bearer))
    expect(removed.status).toBe(200)
    expect(removed.body).toEqual({ id: listId, members: [{ userId: owner.userId, role: 'owner' }] })
    const before = await orgState(orgId)
    const again = await app().delete(`/api/task-lists/${listId}/members/${former.userId}`).set(auth(former.bearer))
    const missing = await app().delete(`/api/task-lists/tlst_missing${stamp}/members/${former.userId}`).set(auth(former.bearer))
    expect(again.status).toBe(404)
    expect(again.text).toBe(missing.text)
    expect(again.text).toBe(NOT_FOUND_TEXT)
    const rosterRead = await app().get(`/api/task-lists/${listId}/members`).set(auth(former.bearer))
    expect(rosterRead.status).toBe(404)
    expect(rosterRead.text).toBe(NOT_FOUND_TEXT)
    expect(await orgState(orgId)).toBe(before)
    expect(eventsOf(await listEvents(listId))).toEqual([
      [owner.userId, 'created', {}],
      [owner.userId, 'member_removed', { targetUserId: former.userId }],
    ])
  })

  it('m4list|remove: a read member removing another member, or naming a malformed id, is 404; the target row stays', async () => {
    const stamp = stampOf()
    const orgId = orgOf('rmro', stamp)
    const owner = await actor('rmroowner', stamp, orgId)
    const reader = await actor('rmroread', stamp, orgId)
    const other = `usrO_rmro_${stamp}`
    const listId = await listVia(owner, [[reader.userId, 'read'], [other, 'read']])
    const before = await orgState(orgId)
    // `..` and `usr%00x` are malformed ids: for a read member the ability answer (404) comes
    // before the id check (422), design §3.3 order ③ then ④.
    for (const target of [other, owner.userId, '..', 'usr%00x', `${reader.userId}x`]) {
      const hidden = await send('delete', `/api/task-lists/${listId}/members/${target}`, reader.bearer)
      const missing = await send('delete', `/api/task-lists/tlst_missing${stamp}/members/${target}`, reader.bearer)
      expect(hidden.status).toBe(404)
      expect(hidden.text).toBe(missing.text)
      expect(hidden.text).toBe(NOT_FOUND_TEXT)
    }
    expect(await orgState(orgId)).toBe(before)
    expect((await memberRows(listId)).map((row) => row.user_id)).toContain(other)
  })

  it('m4list|remove: a read member leaves: 200, the row is gone, one member_removed naming them, the roster without them', async () => {
    const stamp = stampOf()
    const orgId = orgOf('rmself', stamp)
    const owner = await actor('rmselfowner', stamp, orgId)
    const reader = await actor('rmselfread', stamp, orgId)
    const listId = await listVia(owner, [[reader.userId, 'read']])
    const before = await listRow(listId)
    const response = await app().delete(`/api/task-lists/${listId}/members/${reader.userId}`).set(auth(reader.bearer))
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ id: listId, members: [{ userId: owner.userId, role: 'owner' }] })
    expect((await memberRows(listId)).map((row) => row.user_id)).toEqual([owner.userId])
    expect(eventsOf(await listEvents(listId))).toEqual([
      [owner.userId, 'created', {}],
      [reader.userId, 'member_removed', { targetUserId: reader.userId }],
    ])
    expect(((await listRow(listId)).updated_at as Date).getTime()).toBe((before.updated_at as Date).getTime())
    const gone = await app().get(`/api/task-lists/${listId}`).set(auth(reader.bearer))
    expect(gone.status).toBe(404)
  })

  it('members|remove: a manager removes a read and an edit member; a target that is not a member is a no-op', async () => {
    const stamp = stampOf()
    const orgId = orgOf('rm', stamp)
    const owner = await actor('rmowner', stamp, orgId)
    const editor = await actor('rmedit', stamp, orgId)
    const a = `usrA_rm_${stamp}`
    const b = `usrB_rm_${stamp}`
    const listId = await listVia(owner, [[editor.userId, 'edit'], [a, 'read'], [b, 'edit']])
    // Both targets belong to a second list too (a owns and created it, b reads it): a removal names
    // one list's row only.
    const otherList = await seedList(orgId, a, [[a, 'owner'], [b, 'read']])
    const otherBefore = await listState(otherList)
    const first = await app().delete(`/api/task-lists/${listId}/members/${a}`).set(auth(editor.bearer))
    expect(first.status).toBe(200)
    expect(first.body).toEqual(await roster(listId))
    expect(first.body.members.map((m: { userId: string }) => m.userId)).not.toContain(a)
    const second = await app().delete(`/api/task-lists/${listId}/members/${b}`).set(auth(owner.bearer))
    expect(second.status).toBe(200)
    expect(second.body).toEqual({ id: listId, members: [{ userId: editor.userId, role: 'edit' }, { userId: owner.userId, role: 'owner' }].sort((x, y) => (x.userId < y.userId ? -1 : 1)) })
    const state = await listState(listId)
    for (const target of [a, `usr_never_${stamp}`]) {
      const noop = await app().delete(`/api/task-lists/${listId}/members/${target}`).set(auth(owner.bearer))
      expect(noop.status).toBe(200)
      expect(noop.body).toEqual(second.body)
    }
    expect(await listState(listId)).toBe(state)
    expect(eventsOf(await listEvents(listId))).toEqual([
      [owner.userId, 'created', {}],
      [editor.userId, 'member_removed', { targetUserId: a }],
      [owner.userId, 'member_removed', { targetUserId: b }],
    ])
    expect(await listState(otherList)).toBe(otherBefore)
    expect((await memberRows(otherList)).map((row) => [row.user_id, row.role])).toEqual([[a, 'owner'], [b, 'read']].sort(([x], [y]) => (x < y ? -1 : 1)))
  })

  it('m4list|remove: the creator cannot be removed or leave (422 CREATED_BY_IMMUTABLE); the owner cannot be removed or leave (422 OWNER_MUST_TRANSFER)', async () => {
    const stamp = stampOf()
    const orgId = orgOf('rmfix', stamp)
    const creator = await actor('rmfixcr', stamp, orgId)
    const owner = await actor('rmfixowner', stamp, orgId)
    const editor = await actor('rmfixedit', stamp, orgId)
    const listId = await seedList(orgId, creator.userId, [[owner.userId, 'owner'], [creator.userId, 'read'], [editor.userId, 'edit']])
    const before = await listState(listId)
    for (const who of [editor, owner, creator]) {
      const response = await app().delete(`/api/task-lists/${listId}/members/${creator.userId}`).set(auth(who.bearer))
      expect(response.status).toBe(422)
      expect(response.body).toEqual({ error: { code: 'CREATED_BY_IMMUTABLE' } })
    }
    for (const who of [editor, owner]) {
      const response = await app().delete(`/api/task-lists/${listId}/members/${owner.userId}`).set(auth(who.bearer))
      expect(response.status).toBe(422)
      expect(response.body).toEqual({ error: { code: 'OWNER_MUST_TRANSFER' } })
    }
    expect(await listState(listId)).toBe(before)
  })

  it('members|remove: an invalid path id is 422 INVALID_MEMBER for a manager', async () => {
    const stamp = stampOf()
    const orgId = orgOf('rmbad', stamp)
    const owner = await actor('rmbad', stamp, orgId)
    const listId = await listVia(owner)
    const before = await listState(listId)
    for (const segment of ['.', '..', 'usr%00x', 'usr%20x', 'x'.repeat(256)]) {
      const response = await rawRequest(port(), 'DELETE', `/api/task-lists/${listId}/members/${segment}`, owner.bearer)
      expect(response.status).toBe(422)
      expect(response.body).toEqual({ error: { code: 'INVALID_MEMBER' } })
    }
    expect(await listState(listId)).toBe(before)
  })

  it('m4list|remove: a list-only member removed through the route gets the task detail 404 on the next request', async () => {
    const stamp = stampOf()
    const orgId = orgOf('rmdet', stamp)
    const owner = await actor('rmdetowner', stamp, orgId)
    const reader = await actor('rmdetread', stamp, orgId)
    const task = await createTask({ orgId, creatorId: owner.userId, title: '备料复核', assignees: [owner.userId], completionMode: 'all' })
    const listId = await listVia(owner, [[reader.userId, 'read']])
    await poolManager.get().query(`INSERT INTO task_list_items (list_id, task_id, org_id) VALUES ($1, $2, $3)`, [listId, task.id, orgId])
    const visible = await app().get(`/api/tasks/${task.id}`).set(auth(reader.bearer))
    expect(visible.status).toBe(200)
    const removed = await app().delete(`/api/task-lists/${listId}/members/${reader.userId}`).set(auth(owner.bearer))
    expect(removed.status).toBe(200)
    const after = await app().get(`/api/tasks/${task.id}`).set(auth(reader.bearer))
    const absent = await app().get(`/api/tasks/tsk_missing_${stamp}`).set(auth(reader.bearer))
    expect(after.status).toBe(404)
    expect(after.text).toBe(absent.text)
  })
})

// ---------------------------------------------------------------------------------------------
// Archived lists (design §3.2): archiving changes only the default filter of GET /api/task-lists,
// so the member routes answer an archived list as they answer a live one.
// ---------------------------------------------------------------------------------------------

describe('archived list', () => {
  it('members|archived: on an archived list the roster, add, change role, leave and transfer answer exactly as on a live list — statuses, bodies, member rows, events — and the list stays archived', async () => {
    const stamp = stampOf()
    const orgId = orgOf('arch', stamp)
    const owner = await actor('archowner', stamp, orgId)
    const editor = await actor('archedit', stamp, orgId)
    const reader = await actor('archread', stamp, orgId)
    const target = await orgUser('archT', stamp, orgId)
    const live = await listVia(owner, [[editor.userId, 'edit'], [reader.userId, 'read']])
    const archived = await listVia(owner, [[editor.userId, 'edit'], [reader.userId, 'read']])
    const archiving = await app().post(`/api/task-lists/${archived}/archive`).set(auth(owner.bearer))
    expect(archiving.status).toBe(200)
    expect(typeof archiving.body.archivedAt).toBe('string')
    const archivedRow = await listRow(archived)

    /** One pass over the member routes. The list id and the roster's per-list `createdAt` are
     * taken out of each answer so the two lists compare. */
    const pass = async (listId: string): Promise<Array<{ step: string; status: number; body: unknown }>> => {
      const steps: Array<[string, SeededTaskActor, 'get' | 'post' | 'patch' | 'delete', string, Record<string, unknown> | undefined]> = [
        ['read member reads the roster', reader, 'get', `/api/task-lists/${listId}/members`, undefined],
        ['edit member adds a member', editor, 'post', `/api/task-lists/${listId}/members`, { userId: target, role: 'read' }],
        ['read member adds a member', reader, 'post', `/api/task-lists/${listId}/members`, { userId: target, role: 'edit' }],
        ['owner changes a role', owner, 'patch', `/api/task-lists/${listId}/members/${target}`, { role: 'edit' }],
        ['read member leaves', reader, 'delete', `/api/task-lists/${listId}/members/${reader.userId}`, undefined],
        ['former member reads the roster', reader, 'get', `/api/task-lists/${listId}/members`, undefined],
        ['owner transfers', owner, 'post', `/api/task-lists/${listId}/transfer-owner`, { userId: editor.userId }],
        ['former owner transfers', owner, 'post', `/api/task-lists/${listId}/transfer-owner`, { userId: target }],
        ['new owner removes a member', editor, 'delete', `/api/task-lists/${listId}/members/${target}`, undefined],
        ['new owner reads the roster', editor, 'get', `/api/task-lists/${listId}/members`, undefined],
      ]
      const answers: Array<{ step: string; status: number; body: unknown }> = []
      for (const [step, who, method, path, body] of steps) {
        const response = await send(method, path, who.bearer, body)
        const parsed = JSON.parse(response.text) as Record<string, unknown>
        if (parsed.id === listId) parsed.id = '<list>'
        if (Array.isArray(parsed.items)) {
          parsed.items = (parsed.items as Array<Record<string, unknown>>).map(({ userId, role }) => ({ userId, role }))
        }
        answers.push({ step, status: response.status, body: parsed })
      }
      return answers
    }
    const livePass = await pass(live)
    const archivedPass = await pass(archived)
    expect(livePass.map((answer) => answer.status)).toEqual([200, 200, 404, 200, 200, 404, 200, 404, 200, 200])
    expect(archivedPass).toEqual(livePass)
    const rowsOf = async (listId: string) => (await memberRows(listId)).map((row) => [row.user_id, row.role])
    expect(await rowsOf(archived)).toEqual(await rowsOf(live))
    const memberEventsOf = async (listId: string) => eventsOf((await listEvents(listId)).filter((event) => event.event_type !== 'archived'))
    expect(await memberEventsOf(archived)).toEqual(await memberEventsOf(live))
    expect((await memberEventsOf(live)).length).toBe(6)
    // Member writes leave the list row alone: still archived, same instants.
    const after = await listRow(archived)
    expect([after.archived_at, after.updated_at]).toEqual([archivedRow.archived_at, archivedRow.updated_at])
  })
})

// ---------------------------------------------------------------------------------------------
// Write instants (design §4.4): a member write stamps no list row; its event takes one
// clock_timestamp() reading after the structure lock is held.
// ---------------------------------------------------------------------------------------------

describe('write instants', () => {
  it('members|stamps: member writes queued behind the structure lock stamp their events after it', async () => {
    const stamp = stampOf()
    const orgId = orgOf('stmp', stamp)
    const owner = await actor('stmpowner', stamp, orgId)
    const target = await orgUser('stmptarget', stamp, orgId)
    const listId = await listVia(owner)
    const steps = [
      { type: 'member_added', send: () => app().post(`/api/task-lists/${listId}/members`).set(auth(owner.bearer)).send({ userId: target, role: 'read' }) },
      { type: 'member_role_changed', send: () => app().patch(`/api/task-lists/${listId}/members/${target}`).set(auth(owner.bearer)).send({ role: 'edit' }) },
      { type: 'member_removed', send: () => app().delete(`/api/task-lists/${listId}/members/${target}`).set(auth(owner.bearer)) },
      { type: 'member_added', send: () => app().post(`/api/task-lists/${listId}/members`).set(auth(owner.bearer)).send({ userId: target, role: 'edit' }) },
      { type: 'owner_transferred', send: () => app().post(`/api/task-lists/${listId}/transfer-owner`).set(auth(owner.bearer)).send({ userId: target }) },
    ]
    for (const step of steps) {
      const queued = await whileStructureLockHeld(orgId, () => step.send().then((res) => res))
      expect(queued.result.status).toBe(200)
      const latest = await poolManager.get().query(
        `SELECT event_type, occurred_at > $2::timestamptz AS later FROM task_list_events
          WHERE list_id = $1 ORDER BY occurred_at DESC, id DESC LIMIT 1`,
        [listId, queued.holderAt],
      )
      expect(latest.rows).toEqual([{ event_type: step.type, later: true }])
    }
  }, 120000)
})

// ---------------------------------------------------------------------------------------------
// POST /api/task-lists/:id/transfer-owner
// ---------------------------------------------------------------------------------------------

describe('transfer', () => {
  it('members|transfer: the owner hands the list to an edit member and the new owner to a read member; demote then promote; owner_transferred events; ownerId follows; the list row is untouched', async () => {
    const stamp = stampOf()
    const orgId = orgOf('tr', stamp)
    const owner = await actor('trowner', stamp, orgId)
    const editor = await actor('tredit', stamp, orgId)
    const reader = await actor('trread', stamp, orgId)
    const listId = await listVia(owner, [[editor.userId, 'edit'], [reader.userId, 'read']])
    // The owner owns a second list and reads a third; both targets read those lists too. A transfer
    // changes this list's two rows only.
    const thirdOwner = `usrO_tr_${stamp}`
    const others = [
      await seedList(orgId, owner.userId, [[owner.userId, 'owner'], [editor.userId, 'read'], [reader.userId, 'read']]),
      await seedList(orgId, thirdOwner, [[thirdOwner, 'owner'], [owner.userId, 'read'], [editor.userId, 'read'], [reader.userId, 'read']]),
    ]
    const othersBefore = await Promise.all(others.map((id) => listState(id)))
    const before = await listRow(listId)
    const first = await app().post(`/api/task-lists/${listId}/transfer-owner`).set(auth(owner.bearer)).send({ userId: editor.userId })
    expect(first.status).toBe(200)
    expect(first.body).toEqual(await roster(listId))
    expect(first.body.members).toContainEqual({ userId: owner.userId, role: 'edit' })
    expect(first.body.members).toContainEqual({ userId: editor.userId, role: 'owner' })
    const read = await app().get(`/api/task-lists/${listId}`).set(auth(owner.bearer))
    expect(read.body.ownerId).toBe(editor.userId)
    expect(read.body.myRole).toBe('edit')
    expect(read.body.createdBy).toBe(owner.userId)
    // The former owner cannot transfer again; the new owner can, even to a read member.
    const refused = await app().post(`/api/task-lists/${listId}/transfer-owner`).set(auth(owner.bearer)).send({ userId: reader.userId })
    expect(refused.status).toBe(404)
    expect(refused.text).toBe(NOT_FOUND_TEXT)
    const second = await app().post(`/api/task-lists/${listId}/transfer-owner`).set(auth(editor.bearer)).send({ userId: reader.userId })
    expect(second.status).toBe(200)
    expect(second.body.members).toContainEqual({ userId: editor.userId, role: 'edit' })
    expect(second.body.members).toContainEqual({ userId: reader.userId, role: 'owner' })
    const owners = await poolManager.get().query(`SELECT user_id FROM task_list_members WHERE list_id = $1 AND role = 'owner'`, [listId])
    expect(owners.rows).toEqual([{ user_id: reader.userId }])
    // After the second transfer the creator is still the first owner, the owner the reader.
    const reread = await app().get(`/api/task-lists/${listId}`).set(auth(reader.bearer))
    expect([reread.body.createdBy, reread.body.ownerId, reread.body.myRole]).toEqual([owner.userId, reader.userId, 'owner'])
    expect(eventsOf(await listEvents(listId))).toEqual([
      [owner.userId, 'created', {}],
      [owner.userId, 'owner_transferred', { targetUserId: editor.userId }],
      [editor.userId, 'owner_transferred', { targetUserId: reader.userId }],
    ])
    expect(((await listRow(listId)).updated_at as Date).getTime()).toBe((before.updated_at as Date).getTime())
    expect(await Promise.all(others.map((id) => listState(id)))).toEqual(othersBefore)
    for (const [id, holder] of [[others[0], owner.userId], [others[1], thirdOwner]] as const) {
      const rows = await poolManager.get().query(`SELECT user_id FROM task_list_members WHERE list_id = $1 AND role = 'owner'`, [id])
      expect(rows.rows).toEqual([{ user_id: holder }])
    }
  })

  it('members|transfer: the current owner as target is a no-op', async () => {
    const stamp = stampOf()
    const orgId = orgOf('trself', stamp)
    const owner = await actor('trself', stamp, orgId)
    const listId = await listVia(owner, [[`usrO_trself_${stamp}`, 'edit']])
    const before = await listState(listId)
    const response = await app().post(`/api/task-lists/${listId}/transfer-owner`).set(auth(owner.bearer)).send({ userId: owner.userId })
    expect(response.status).toBe(200)
    expect(response.body).toEqual(await roster(listId))
    expect(await listState(listId)).toBe(before)
  })

  it('m4list|transfer: an edit member, a read member and a non-member get the 404 of a missing list for any body; nothing changes', async () => {
    const stamp = stampOf()
    const orgId = orgOf('trro', stamp)
    const owner = await actor('trroowner', stamp, orgId)
    const editor = await actor('trroedit', stamp, orgId)
    const reader = await actor('trroread', stamp, orgId)
    const outsider = await actor('trroout', stamp, orgId)
    const listId = await listVia(owner, [[editor.userId, 'edit'], [reader.userId, 'read']])
    const before = await orgState(orgId)
    for (const who of [editor, reader, outsider]) {
      for (const body of [{ userId: who.userId }, { userId: editor.userId }, { userId: '..' }, {}]) {
        const hidden = await app().post(`/api/task-lists/${listId}/transfer-owner`).set(auth(who.bearer)).send(body)
        const missing = await app().post(`/api/task-lists/tlst_missing${stamp}/transfer-owner`).set(auth(who.bearer)).send(body)
        expect(hidden.status).toBe(404)
        expect(hidden.text).toBe(missing.text)
        expect(hidden.text).toBe(NOT_FOUND_TEXT)
      }
    }
    expect(await orgState(orgId)).toBe(before)
  })

  it('members|transfer: a target that is not a member is 422 TARGET_NOT_MEMBER; an invalid userId is 422 INVALID_MEMBER; nothing written', async () => {
    const stamp = stampOf()
    const orgId = orgOf('trnm', stamp)
    const owner = await actor('trnm', stamp, orgId)
    const stranger = await orgUser('trnmS', stamp, orgId)
    const listId = await listVia(owner)
    const before = await listState(listId)
    const notMember = await app().post(`/api/task-lists/${listId}/transfer-owner`).set(auth(owner.bearer)).send({ userId: stranger })
    expect(notMember.status).toBe(422)
    expect(notMember.body).toEqual({ error: { code: 'TARGET_NOT_MEMBER' } })
    // [own-27] the org lookup runs only for a transfer that changes something: a non-member with no
    // org membership at all is still TARGET_NOT_MEMBER.
    const unknown = await app().post(`/api/task-lists/${listId}/transfer-owner`).set(auth(owner.bearer)).send({ userId: `usr_trnmU_${stamp}` })
    expect(unknown.status).toBe(422)
    expect(unknown.body).toEqual({ error: { code: 'TARGET_NOT_MEMBER' } })
    for (const body of [{}, { userId: '' }, { userId: '..' }, { userId: 'usr\u0000' }, { userId: 7 }, [{ userId: stranger }]]) {
      const response = await app().post(`/api/task-lists/${listId}/transfer-owner`).set(auth(owner.bearer)).send(body as object)
      expect(response.status).toBe(422)
      expect(response.body).toEqual({ error: { code: 'INVALID_MEMBER' } })
    }
    expect(await listState(listId)).toBe(before)
  })

  it.each([
    { label: 'user_orgs.is_active = false', deactivate: (userId: string) => poolManager.get().query(`UPDATE user_orgs SET is_active = false WHERE user_id = $1`, [userId]) },
    { label: 'users.is_active = false', deactivate: (userId: string) => poolManager.get().query(`UPDATE users SET is_active = false WHERE id = $1`, [userId]) },
    { label: "users.role = 'disabled'", deactivate: (userId: string) => poolManager.get().query(`UPDATE users SET role = 'disabled' WHERE id = $1`, [userId]) },
    { label: "activation_status = 'pending_activation'", deactivate: (userId: string) => poolManager.get().query(`UPDATE users SET activation_status = 'pending_activation' WHERE id = $1`, [userId]) },
  ])('m4list|transfer: a member target with $label is 422 INACTIVE_ORG_MEMBER; both roles unchanged; no event', async ({ deactivate }) => {
    const stamp = stampOf()
    const orgId = orgOf('trina', stamp)
    const owner = await actor('trinaowner', stamp, orgId)
    const target = await actor('trinatarget', stamp, orgId)
    const listId = await listVia(owner, [[target.userId, 'edit']])
    await deactivate(target.userId)
    const before = await listState(listId)
    const response = await app().post(`/api/task-lists/${listId}/transfer-owner`).set(auth(owner.bearer)).send({ userId: target.userId })
    expect(response.status).toBe(422)
    expect(response.body).toEqual({ error: { code: 'INACTIVE_ORG_MEMBER' } })
    expect(await listState(listId)).toBe(before)
    expect((await memberRows(listId)).map((row) => [row.user_id, row.role])).toEqual(
      [[owner.userId, 'owner'], [target.userId, 'edit']].sort(([x], [y]) => (x < y ? -1 : 1)),
    )
  })
})

// ---------------------------------------------------------------------------------------------
// Permission code per route (rbacGuard) and the missing org claim.
// ---------------------------------------------------------------------------------------------

describe('permission codes and missing org', () => {
  type CodeRoute = {
    label: string
    code: 'read' | 'write'
    method: 'get' | 'post' | 'patch' | 'delete'
    path: (listId: string, victim: string) => string
    body?: (victim: string) => Record<string, unknown>
    /** The caller who must succeed owns the list (transfer); otherwise both callers are `edit`. */
    rightOwns?: boolean
  }
  const CODE_ROUTES: CodeRoute[] = [
    { label: 'GET /api/task-lists/:id/members', code: 'read', method: 'get', path: (id) => `/api/task-lists/${id}/members` },
    { label: 'POST /api/task-lists/:id/members', code: 'write', method: 'post', path: (id) => `/api/task-lists/${id}/members`, body: (victim) => ({ userId: `${victim}n`, role: 'read' }) },
    { label: 'PATCH /api/task-lists/:id/members/:userId', code: 'write', method: 'patch', path: (id, victim) => `/api/task-lists/${id}/members/${victim}`, body: () => ({ role: 'edit' }) },
    { label: 'DELETE /api/task-lists/:id/members/:userId', code: 'write', method: 'delete', path: (id, victim) => `/api/task-lists/${id}/members/${victim}` },
    { label: 'POST /api/task-lists/:id/transfer-owner', code: 'write', method: 'post', path: (id) => `/api/task-lists/${id}/transfer-owner`, body: (victim) => ({ userId: victim }), rightOwns: true },
  ]

  it.each(CODE_ROUTES)('members|codes: $label needs tasks:$code; the other code alone is 403 and nothing is written', async (route) => {
    const stamp = stampOf()
    const orgId = orgOf('codes', stamp)
    const wrong = await actor('codeswrong', stamp, orgId, [route.code === 'write' ? 'tasks:read' : 'tasks:write'])
    const right = await actor('codesright', stamp, orgId, [`tasks:${route.code}`])
    const victim = await orgUser('codesV', stamp, orgId)
    await seedOrgMembers(orgId, [`${victim}n`])
    seededUsers.push(`${victim}n`)
    const members: Array<[string, TaskListMemberRole]> = route.rightOwns
      ? [[right.userId, 'owner'], [wrong.userId, 'edit'], [victim, 'read']]
      : [[`usrO_codes_${stamp}`, 'owner'], [wrong.userId, 'edit'], [right.userId, 'edit'], [victim, 'read']]
    const listId = await seedList(orgId, route.rightOwns ? right.userId : `usrO_codes_${stamp}`, members)
    const send = (who: SeededTaskActor) => {
      const call = app()[route.method](route.path(listId, victim)).set(auth(who.bearer))
      return route.body === undefined ? call : call.send(route.body(victim))
    }
    const before = await orgState(orgId)
    const denied = await send(wrong)
    expect(denied.status).toBe(403)
    expect(denied.body).toEqual({ error: 'Insufficient permissions' })
    expect(await orgState(orgId)).toBe(before)
    const allowed = await send(right)
    expect(allowed.status).toBe(200)
  })

  it('members|no org: the four writes are 422 ORG_MISSING and the roster read is 404; nothing written', async () => {
    const stamp = stampOf()
    const orgId = orgOf('noorg', stamp)
    const owner = await actor('noorg', stamp, orgId)
    const other = await orgUser('noorgO', stamp, orgId)
    const listId = await listVia(owner, [[other, 'edit']])
    const before = await listState(listId)
    const bare = tokenFor(owner, null)
    const server = app()
    for (const [method, path, body] of [
      ['post', `/api/task-lists/${listId}/members`, { userId: `${other}n`, role: 'read' }],
      ['patch', `/api/task-lists/${listId}/members/${other}`, { role: 'read' }],
      ['delete', `/api/task-lists/${listId}/members/${other}`, undefined],
      ['post', `/api/task-lists/${listId}/transfer-owner`, { userId: other }],
    ] as const) {
      const call = server[method](path).set(auth(bare))
      const response = body === undefined ? await call : await call.send(body)
      expect(response.status).toBe(422)
      expect(response.body).toEqual({ error: { code: 'ORG_MISSING' } })
    }
    const read = await server.get(`/api/task-lists/${listId}/members`).set(auth(bare))
    expect(read.status).toBe(404)
    expect(read.text).toBe(NOT_FOUND_TEXT)
    expect(await listState(listId)).toBe(before)
  })
})
