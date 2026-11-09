import '../helpers/assert-rbac-optional-off'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import jwt from 'jsonwebtoken'
import { poolManager } from '../../src/integration/db/connection-pool'
import { createTask, type Db } from '../../src/services/task-records'
import { findActiveOrgMembers } from '../../src/services/task-org-members'
import { findTaskAccessHolders } from '../../src/services/task-member-access'
import { loadTaskPeople, resolveOrgPeople, searchOrgPeople } from '../../src/services/task-people'
import {
  dropTaskM4Fixtures,
  grantFixtureTaskAccess,
  runSourceMutant,
  seedOrgMembers,
  seedTaskActor,
  type SeededTaskActor,
} from '../helpers/task-m4-fixtures'
import { rawRequest, startTasksListener, tasksClient, type TasksListener } from '../helpers/tasks-http-harness'

/**
 * Task usability package 1b: the people directory (`GET /api/tasks/people`) and the people on one
 * task (`GET /api/tasks/:id/people`), on a real database.
 *
 * - The directory offers exactly the people the task writes accept: every shape of the write-side
 *   membership test (task-m4-org-members.db.test.ts) is compared with that test called on its own,
 *   and with the expected vector, so both cannot be wrong together. Nobody from another org.
 * - Each row's "can use tasks" mark is the assignee write's own answer (task-member-access.ts).
 * - Rows are bounded (20, then "there is more"), terms are literal, ids match exactly, and a row
 *   carries the id, the name, a masked email and the mark, nothing else.
 * - The people on a task: a name and a status per person, only to someone who can view the task, a
 *   name only for someone who has a membership row in the caller's org.
 *
 * Assignees written through createTask are seeded with task access (seedOrgMembers); the others are
 * written by SQL as earlier assignments. The source mutants at the end must each turn a cell red.
 */

if (process.env.EXPECT_DB !== '1') {
  throw new Error('task-people.db.test.ts requires EXPECT_DB=1')
}

const ORG_PREFIX = 'org_tasks_people_'
const seededUsers: string[] = []
const seededRoles: string[] = []

const PEOPLE_FILE = new URL('../../src/services/task-people.ts', import.meta.url).pathname
const POOL_FILE = new URL('../../src/integration/db/connection-pool.ts', import.meta.url).pathname

const NOT_FOUND_TEXT = JSON.stringify({ error: { code: 'NOT_FOUND' } })
const ORG_MISSING_TEXT = JSON.stringify({ error: { code: 'ORG_MISSING' } })

type Reply = { status: number; body: unknown; text: string }
type Item = { id: string; name: string; detail: string; canUseTasks: boolean }
type PeopleMap = Record<string, { name: string; status: string }>

function stampOf(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12)
}

function orgOf(label: string, stamp: string): string {
  return `${ORG_PREFIX}${label}_${stamp}`
}

const pool = () => poolManager.get()
const poolDb: Db = { query: async (sql, params) => ({ rows: (await pool().query(sql, params)).rows }) }

async function actor(label: string, stamp: string, orgId: string, codes = ['tasks:read', 'tasks:write']): Promise<SeededTaskActor> {
  const seeded = await seedTaskActor({ label, stamp, orgId, codes, admission: true })
  seededUsers.push(seeded.userId)
  seededRoles.push(seeded.roleId)
  return seeded
}

/** A user row with a chosen name (and email), and a `user_orgs` row in `orgId` when one is given.
 * No task access. */
async function person(
  userId: string,
  orgId: string | null,
  opts: { name?: string | null; email?: string; active?: boolean; orgActive?: boolean } = {},
): Promise<string> {
  await pool().query(
    `INSERT INTO users (
       id, email, name, password_hash, role, permissions,
       is_active, activation_status, local_password_set, must_change_password
     ) VALUES ($1, $2, $3, 'x', 'user', '[]'::jsonb, $4, 'activated', TRUE, FALSE)`,
    [userId, opts.email ?? `${userId}@tasks-people.test`, opts.name === undefined ? userId : opts.name, opts.active ?? true],
  )
  seededUsers.push(userId)
  if (orgId) {
    await pool().query('INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, $3)', [userId, orgId, opts.orgActive ?? true])
  }
  return userId
}

async function roleWith(roleId: string, userId: string, codes: string[]): Promise<void> {
  await pool().query('INSERT INTO roles (id, name) VALUES ($1, $1)', [roleId])
  seededRoles.push(roleId)
  for (const code of codes) {
    await pool().query('INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, $2)', [roleId, code])
  }
  await pool().query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [userId, roleId])
}

async function taskAccessEnabled(userId: string): Promise<void> {
  await pool().query(
    `INSERT INTO user_namespace_admissions (user_id, namespace, enabled, source, created_at, updated_at)
     VALUES ($1, 'tasks', TRUE, 'test', now(), now())`,
    [userId],
  )
}

/** A token with no role or permission claims: the server reads the user from the database. */
function claimsLessToken(userId: string, orgId: string): string {
  return jwt.sign({ userId, sub: userId, tenantId: orgId }, String(process.env.JWT_SECRET), { expiresIn: '1h' })
}

let listener: TasksListener | undefined

beforeAll(async () => {
  listener = await startTasksListener()
})

afterAll(async () => {
  await dropTaskM4Fixtures({ orgPrefix: ORG_PREFIX, userIds: seededUsers, roleIds: seededRoles })
  await listener?.close()
})

function port(): number {
  if (!listener) throw new Error('tasks listener not started')
  return listener.port
}

function get(path: string, bearer: string): Promise<Reply> {
  return rawRequest(port(), 'GET', path, bearer)
}

function post(path: string, bearer: string, body: unknown): Promise<Reply> {
  return rawRequest(port(), 'POST', path, bearer, body)
}

async function search(term: string, bearer: string, extra = ''): Promise<{ items: Item[]; hasMore: boolean; text: string }> {
  const reply = await get(`/api/tasks/people?q=${encodeURIComponent(term)}${extra}`, bearer)
  expect(reply.status, reply.text).toBe(200)
  const body = reply.body as { items: Item[]; hasMore: boolean; requiresQuery: boolean }
  expect(body.requiresQuery).toBe(false)
  return { items: body.items, hasMore: body.hasMore, text: reply.text }
}

async function resolve(ids: string[], bearer: string): Promise<Item[]> {
  const reply = await get(`/api/tasks/people?ids=${ids.map(encodeURIComponent).join(',')}`, bearer)
  expect(reply.status, reply.text).toBe(200)
  return (reply.body as { items: Item[] }).items
}

// ---------------------------------------------------------------------------------------------
// Who the directory offers: the write-side membership test, shape by shape.
// ---------------------------------------------------------------------------------------------

describe('people directory: who is offered', () => {
  it('membership parity: the directory offers exactly the people the membership test of the writes admits', async () => {
    const stamp = stampOf()
    const orgId = orgOf('par', stamp)
    const otherOrg = orgOf('parx', stamp)
    const caller = await actor('par', stamp, orgId)
    const term = `Pty${stamp}`
    const account = async (userId: string, name: string, sql: string): Promise<void> => {
      await person(userId, orgId, { name })
      await pool().query(sql, [userId])
    }
    const shapes: Array<{ key: string; offered: boolean; seed: (userId: string, name: string) => Promise<unknown> }> = [
      { key: 'active', offered: true, seed: (userId, name) => person(userId, orgId, { name }) },
      { key: 'other-org', offered: false, seed: (userId, name) => person(userId, otherOrg, { name }) },
      { key: 'org-relation-off', offered: false, seed: (userId, name) => person(userId, orgId, { name, orgActive: false }) },
      { key: 'user-off', offered: false, seed: (userId, name) => person(userId, orgId, { name, active: false }) },
      { key: 'unknown', offered: false, seed: async () => undefined },
      { key: 'role-disabled', offered: false, seed: (userId, name) => account(userId, name, `UPDATE users SET role = 'disabled' WHERE id = $1`) },
      { key: 'pending-activation', offered: false, seed: (userId, name) => account(userId, name, `UPDATE users SET activation_status = 'pending_activation' WHERE id = $1`) },
      { key: 'recycled-active', offered: false, seed: (userId, name) => account(userId, name, `UPDATE users SET deleted_at = now() WHERE id = $1`) },
      { key: 'purged-active', offered: false, seed: (userId, name) => account(userId, name, `UPDATE users SET purged_at = now() WHERE id = $1`) },
      { key: 'role-disabled-admin', offered: true, seed: async (userId, name) => {
        await account(userId, name, `UPDATE users SET role = 'disabled' WHERE id = $1`)
        await pool().query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'admin')`, [userId])
      } },
    ]
    const ids: string[] = []
    for (const shape of shapes) {
      const userId = `usrP_${shape.key.replace(/-/g, '')}_${stamp}`
      await shape.seed(userId, `${term} ${shape.key}`)
      ids.push(userId)
    }
    const found = new Set((await search(term, caller.bearer)).items.map((item) => item.id))
    const resolved = new Set((await resolve(ids, caller.bearer)).map((item) => item.id))
    for (const [index, shape] of shapes.entries()) {
      const userId = ids[index]
      const admitted = (await findActiveOrgMembers(poolDb, orgId, [userId])).has(userId)
      expect(admitted, `${shape.key}: membership test`).toBe(shape.offered)
      expect(found.has(userId), `${shape.key}: search`).toBe(admitted)
      expect(resolved.has(userId), `${shape.key}: resolve`).toBe(admitted)
    }
    expect(found.size).toBe(2)
  })

  it('another org: its member is not offered by name, by exact id or by resolve; a caller of that org is offered them', async () => {
    const stamp = stampOf()
    const orgA = orgOf('xa', stamp)
    const orgB = orgOf('xb', stamp)
    const callerA = await actor('xa', stamp, orgA)
    const callerB = await actor('xb', stamp, orgB)
    const name = `Xog${stamp}`
    const userB = await person(`usrX_b_${stamp}`, orgB, { name })
    expect((await search(name, callerA.bearer)).items).toEqual([])
    expect((await search(userB, callerA.bearer)).items).toEqual([])
    expect(await resolve([userB], callerA.bearer)).toEqual([])
    expect((await search(name, callerB.bearer)).items.map((item) => item.id)).toEqual([userB])
  })
})

// ---------------------------------------------------------------------------------------------
// The "can use tasks" mark: the assignee write's own answer.
// ---------------------------------------------------------------------------------------------

const SHAPES = ['a', 'b', 'c', 'd', 'e', 'f', 'g'] as const
type Shape = typeof SHAPES[number]
const USABLE: ReadonlySet<Shape> = new Set<Shape>(['e', 'f', 'g'])

async function seedShape(shape: Shape, userId: string, orgId: string, stamp: string): Promise<void> {
  await person(userId, orgId, { name: `Acc${stamp}${shape}` })
  const both = ['tasks:read', 'tasks:write']
  switch (shape) {
    case 'a':
      return
    case 'b':
      await roleWith(`role_pb_${stamp}`, userId, both)
      return
    case 'c':
      await roleWith(`role_pc_${stamp}`, userId, ['tasks:read'])
      await taskAccessEnabled(userId)
      return
    case 'd':
      await roleWith(`role_pd_${stamp}`, userId, ['tasks:write'])
      await taskAccessEnabled(userId)
      return
    case 'e':
      await grantFixtureTaskAccess([userId])
      return
    case 'f':
      await pool().query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'admin')`, [userId])
      return
    case 'g':
      await pool().query(`UPDATE users SET role = 'admin' WHERE id = $1`, [userId])
      return
  }
}

describe('people directory: the can-use-tasks mark', () => {
  it.each(SHAPES)('shape-%s', async (shape) => {
    const stamp = stampOf()
    const orgId = orgOf(`acc${shape}`, stamp)
    const caller = await actor(`acc${shape}`, stamp, orgId)
    const target = `usrA_${shape}_${stamp}`
    await seedShape(shape, target, orgId, stamp)
    const holds = (await findTaskAccessHolders(poolDb, [target])).has(target)
    expect(holds, 'expected').toBe(USABLE.has(shape))
    const searched = (await search(target, caller.bearer)).items
    expect(searched.map((item) => [item.id, item.canUseTasks])).toEqual([[target, holds]])
    const resolved = await resolve([target], caller.bearer)
    expect(resolved.map((item) => [item.id, item.canUseTasks])).toEqual([[target, holds]])
  })
})

// ---------------------------------------------------------------------------------------------
// Bounds, literal terms, exact ids, the row's fields.
// ---------------------------------------------------------------------------------------------

describe('people directory: bounds and fields', () => {
  it('21 matching members: 20 rows and "there is more"; 20 matching members: 20 rows and no more; limit=5 gives 5', async () => {
    const stamp = stampOf()
    const orgId = orgOf('bnd', stamp)
    const caller = await actor('bnd', stamp, orgId)
    const term = `Bnd${stamp}`
    const ids: string[] = []
    for (let i = 1; i <= 21; i += 1) ids.push(await person(`usrB_${i}_${stamp}`, orgId, { name: `${term} ${String(i).padStart(2, '0')}` }))
    const full = await search(term, caller.bearer)
    expect(full.items).toHaveLength(20)
    expect(full.hasMore).toBe(true)
    expect(full.items.map((item) => item.id)).toEqual(ids.slice(0, 20))
    const five = await search(term, caller.bearer, '&limit=5')
    expect(five.items).toHaveLength(5)
    expect(five.hasMore).toBe(true)
    await pool().query('UPDATE user_orgs SET is_active = false WHERE user_id = $1 AND org_id = $2', [ids[0], orgId])
    const twenty = await search(term, caller.bearer)
    expect(twenty.items.map((item) => item.id)).toEqual(ids.slice(1))
    expect(twenty.hasMore).toBe(false)
  })

  it('the members who are no longer active do not crowd out an active one past the first batch', async () => {
    const stamp = stampOf()
    const orgId = orgOf('bat', stamp)
    const caller = await actor('bat', stamp, orgId)
    const term = `Bat${stamp}`
    for (let i = 0; i < 105; i += 1) {
      await person(`usrO_${i}_${stamp}`, orgId, { name: `${term} a${String(i).padStart(3, '0')}`, orgActive: false })
    }
    const active = await person(`usrO_on_${stamp}`, orgId, { name: `${term} z` })
    const found = await search(term, caller.bearer)
    expect(found.items.map((item) => item.id)).toEqual([active])
    expect(found.hasMore).toBe(false)
  })

  it('the term is literal: % and _ match only themselves', async () => {
    const stamp = stampOf()
    const orgId = orgOf('lit', stamp)
    const caller = await actor('lit', stamp, orgId)
    const term = `Lit${stamp}`
    const percent = await person(`usrL_p_${stamp}`, orgId, { name: `${term}%a` })
    await person(`usrL_pa_${stamp}`, orgId, { name: `${term}xa` })
    const underscore = await person(`usrL_u_${stamp}`, orgId, { name: `${term}_b` })
    await person(`usrL_ub_${stamp}`, orgId, { name: `${term}yb` })
    expect((await search(`${term}%`, caller.bearer)).items.map((item) => item.id)).toEqual([percent])
    expect((await search(`${term}_`, caller.bearer)).items.map((item) => item.id)).toEqual([underscore])
  })

  it('an id matches only in full: part of an id that is in no name finds nobody', async () => {
    const stamp = stampOf()
    const orgId = orgOf('ids', stamp)
    const caller = await actor('ids', stamp, orgId)
    const member = await person(`usr_idsub_${stamp}_zz`, orgId, { name: `Ids${stamp}` })
    expect((await search(`idsub_${stamp}`, caller.bearer)).items).toEqual([])
    expect((await search(member, caller.bearer)).items.map((item) => item.id)).toEqual([member])
  })

  it('a row is exactly the id, the name, a masked email and the mark; no other profile value leaves the server', async () => {
    const stamp = stampOf()
    const orgId = orgOf('fld', stamp)
    const caller = await actor('fld', stamp, orgId)
    const name = `Fld${stamp}`
    const email = `distinct.fields.${stamp}@example.test`
    const member = await person(`usrF_${stamp}`, orgId, { name, email })
    const mobile = `m${stamp}`
    const employeeNo = `EMP${stamp}`
    const department = `Dept${stamp}`
    await pool().query('UPDATE users SET mobile = $2, employee_no = $3, department = $4 WHERE id = $1', [member, mobile, employeeNo, department])
    const found = await search(name, caller.bearer)
    expect(found.items).toHaveLength(1)
    expect(Object.keys(found.items[0]).sort()).toEqual(['canUseTasks', 'detail', 'id', 'name'])
    expect(found.items[0]).toEqual({ id: member, name, detail: 'di***@example.test', canUseTasks: false })
    const resolved = await get(`/api/tasks/people?ids=${member}`, caller.bearer)
    for (const text of [found.text, resolved.text]) {
      for (const value of [email, 'distinct.fields', mobile, employeeNo, department]) expect(text).not.toContain(value)
    }
  })

  it('a member with no name is found by exact id, with an empty name', async () => {
    const stamp = stampOf()
    const orgId = orgOf('nul', stamp)
    const caller = await actor('nul', stamp, orgId)
    const member = await person(`usrN_${stamp}`, orgId, { name: null })
    expect((await search(member, caller.bearer)).items).toEqual([
      { id: member, name: '', detail: 'us***@tasks-people.test', canUseTasks: false },
    ])
  })
})

// ---------------------------------------------------------------------------------------------
// The people on one task.
// ---------------------------------------------------------------------------------------------

interface TaskCell {
  stamp: string
  orgId: string
  creator: SeededTaskActor
  taskId: string
  expected: PeopleMap
}

/** A task of `creator` with: A1 an active assignee, A2 an assignee deactivated since, A3 one who left
 * the org since, A4 a member of another org only and R an id with no user row (both written by SQL
 * as earlier assignments), and F a follower. A1 and A2 carry profile values that must not leave. */
async function taskCell(label: string): Promise<TaskCell> {
  const stamp = stampOf()
  const orgId = orgOf(label, stamp)
  const otherOrg = orgOf(`${label}x`, stamp)
  const creator = await actor(label, stamp, orgId)
  const a1 = `usrT_a1_${stamp}`
  const a2 = `usrT_a2_${stamp}`
  const a3 = `usrT_a3_${stamp}`
  const a4 = `usrT_a4_${stamp}`
  const rowless = `usrT_r_${stamp}`
  const follower = `usrT_f_${stamp}`
  await seedOrgMembers(orgId, [a1, a2, a3, follower])
  await seedOrgMembers(otherOrg, [a4])
  seededUsers.push(a1, a2, a3, a4, follower)
  await pool().query('UPDATE users SET mobile = $2, employee_no = $3, department = $4 WHERE id = $1', [a1, `m1${stamp}`, `E1${stamp}`, `D1${stamp}`])
  await pool().query('UPDATE users SET mobile = $2, employee_no = $3, department = $4 WHERE id = $1', [a2, `m2${stamp}`, `E2${stamp}`, `D2${stamp}`])
  const task = await createTask({ orgId, creatorId: creator.userId, title: '备料复核', assignees: [creator.userId, a1, a2, a3], completionMode: 'all' })
  await pool().query('UPDATE users SET is_active = false WHERE id = $1', [a2])
  await pool().query('UPDATE user_orgs SET is_active = false WHERE user_id = $1 AND org_id = $2', [a3, orgId])
  for (const userId of [a4, rowless]) {
    await pool().query('INSERT INTO task_assignees (task_id, user_id, assigned_by) VALUES ($1, $2, $3)', [task.id, userId, creator.userId])
  }
  await pool().query('INSERT INTO task_followers (task_id, user_id) VALUES ($1, $2)', [task.id, follower])
  return {
    stamp,
    orgId,
    creator,
    taskId: task.id,
    expected: {
      [creator.userId]: { name: label, status: 'active' },
      [a1]: { name: a1, status: 'active' },
      [a2]: { name: a2, status: 'inactive' },
      [a3]: { name: a3, status: 'inactive' },
      [a4]: { name: '', status: 'inactive' },
      [rowless]: { name: '', status: 'inactive' },
      [follower]: { name: follower, status: 'active' },
    },
  }
}

describe('the people on a task', () => {
  it('a name and a status per person; a name only for a member of the caller\'s org; nothing else', async () => {
    const cell = await taskCell('tpp')
    const reply = await get(`/api/tasks/${cell.taskId}/people`, cell.creator.bearer)
    expect(reply.status, reply.text).toBe(200)
    const people = (reply.body as { people: PeopleMap }).people
    expect(Object.keys(people).sort()).toEqual(Object.keys(cell.expected).sort())
    expect(people).toEqual(cell.expected)
    for (const entry of Object.values(people)) expect(Object.keys(entry).sort()).toEqual(['name', 'status'])
    // No email of anyone, and none of the seeded profile values.
    expect(reply.text).not.toContain('@')
    for (const value of ['m1', 'E1', 'D1', 'm2', 'E2', 'D2']) expect(reply.text).not.toContain(`${value}${cell.stamp}`)
  })

  it('someone with no role on the task gets the same 404 as the detail read; a reader through a list gets the same map', async () => {
    const cell = await taskCell('tpv')
    const outsider = await actor('tpvo', cell.stamp, cell.orgId)
    const detail = await get(`/api/tasks/${cell.taskId}`, outsider.bearer)
    const people = await get(`/api/tasks/${cell.taskId}/people`, outsider.bearer)
    expect([detail.status, detail.text]).toEqual([404, NOT_FOUND_TEXT])
    expect([people.status, people.text]).toEqual([404, NOT_FOUND_TEXT])

    const reader = await actor('tpvr', cell.stamp, cell.orgId)
    const list = await post('/api/task-lists', cell.creator.bearer, { name: '备料复核' })
    expect(list.status, list.text).toBe(200)
    const listId = String((list.body as { id: string }).id)
    expect((await post(`/api/task-lists/${listId}/items`, cell.creator.bearer, { taskId: cell.taskId })).status).toBe(200)
    expect((await post(`/api/task-lists/${listId}/members`, cell.creator.bearer, { userId: reader.userId, role: 'read' })).status).toBe(200)
    expect((await get(`/api/tasks/${cell.taskId}`, reader.bearer)).status).toBe(200)
    const viaList = await get(`/api/tasks/${cell.taskId}/people`, reader.bearer)
    expect(viaList.status, viaList.text).toBe(200)
    expect((viaList.body as { people: PeopleMap }).people).toEqual(cell.expected)
  })

  it('a task of another org, or a missing task, is 404', async () => {
    const cell = await taskCell('tpm')
    const elsewhere = await actor('tpme', cell.stamp, orgOf('tpme', cell.stamp))
    const foreign = await get(`/api/tasks/${cell.taskId}/people`, elsewhere.bearer)
    expect([foreign.status, foreign.text]).toEqual([404, NOT_FOUND_TEXT])
    const missing = await get(`/api/tasks/tsk_missing_${cell.stamp}/people`, cell.creator.bearer)
    expect([missing.status, missing.text]).toEqual([404, NOT_FOUND_TEXT])
  })
})

// ---------------------------------------------------------------------------------------------
// The doors: the directory takes tasks:write, the task people tasks:read; no org answers like the
// routes beside them.
// ---------------------------------------------------------------------------------------------

describe('people routes: doors and the missing org', () => {
  it('tasks:read alone: 403 on the directory, 200 on the people of a task it can view; tasks:write alone: the other way round', async () => {
    const cell = await taskCell('dor')
    const readOnly = await actor('dorr', cell.stamp, cell.orgId, ['tasks:read'])
    const writeOnly = await actor('dorw', cell.stamp, cell.orgId, ['tasks:write'])
    for (const userId of [readOnly.userId, writeOnly.userId]) {
      await pool().query('INSERT INTO task_followers (task_id, user_id) VALUES ($1, $2)', [cell.taskId, userId])
    }
    const readBearer = claimsLessToken(readOnly.userId, cell.orgId)
    const writeBearer = claimsLessToken(writeOnly.userId, cell.orgId)
    expect((await get('/api/tasks/people?q=x', readBearer)).status).toBe(403)
    expect((await get(`/api/tasks/${cell.taskId}/people`, readBearer)).status).toBe(200)
    expect((await get('/api/tasks/people?q=x', writeBearer)).status).toBe(200)
    expect((await get(`/api/tasks/${cell.taskId}/people`, writeBearer)).status).toBe(403)
  })

  it('a token without an org claim: 422 ORG_MISSING on the directory, 404 on the task people, byte for byte', async () => {
    const cell = await taskCell('nog')
    const bearer = jwt.sign({ userId: cell.creator.userId, sub: cell.creator.userId }, String(process.env.JWT_SECRET), { expiresIn: '1h' })
    const client = tasksClient(listener?.baseUrl ?? '')
    const directory = await client.get('/api/tasks/people?q=x').set('Authorization', `Bearer ${bearer}`).set('x-tenant-id', cell.orgId)
    expect([directory.status, directory.text]).toEqual([422, ORG_MISSING_TEXT])
    const people = await client.get(`/api/tasks/${cell.taskId}/people`).set('Authorization', `Bearer ${bearer}`).set('x-tenant-id', cell.orgId)
    expect([people.status, people.text]).toEqual([404, NOT_FOUND_TEXT])
  })
})

// ---------------------------------------------------------------------------------------------
// Source mutants: each rewrite must turn the cell it names red. The child script exits 0 only when
// it observes the wrong answer the mutant produces.
// ---------------------------------------------------------------------------------------------

/** The child's preamble: a pool-backed Db and the service, on the mutated sources. */
function probe(body: string): string {
  return `
    const { poolManager } = await import(${JSON.stringify(POOL_FILE)})
    const pool = poolManager.get()
    const db = { query: async (sql, params) => ({ rows: (await pool.query(sql, params)).rows }) }
    const people = await import(${JSON.stringify(PEOPLE_FILE)})
    ${body}
  `
}

describe('people: source mutants', () => {
  let stamp = ''
  let orgId = ''
  let term = ''
  let off = ''
  let bare = ''
  let outsider = ''
  let cell: TaskCell

  beforeAll(async () => {
    cell = await taskCell('mut')
    stamp = cell.stamp
    orgId = cell.orgId
    term = `Mut${stamp}`
    await person(`usrM_on1_${stamp}`, orgId, { name: `${term} on1` })
    await person(`usrM_on2_${stamp}`, orgId, { name: `${term}%on2` })
    await person(`usrM_on3_${stamp}`, orgId, { name: `${term}xon3` })
    off = await person(`usrM_off_${stamp}`, orgId, { name: `${term} off`, orgActive: false })
    bare = await person(`usrM_bare_${stamp}`, orgId, { name: `Mub${stamp}`, email: `distinct.mutant.${stamp}@example.test` })
    outsider = (await actor('mutout', stamp, orgId)).userId
  })

  const ids = (items: Item[]) => items.map((item) => item.id)

  it('mutant|search-membership: without the membership test, a member who left the org is offered', async () => {
    expect(ids((await searchOrgPeople(poolDb, { orgId, term, limit: 20 })).items)).not.toContain(off)
    runSourceMutant(PEOPLE_FILE, 'for (const row of result.rows) if (active.has(String(row.id))) kept.push(row)', 'for (const row of result.rows) kept.push(row)', probe(`
      const found = (await people.searchOrgPeople(db, { orgId: ${JSON.stringify(orgId)}, term: ${JSON.stringify(term)}, limit: 20 })).items.map((item) => item.id)
      process.exit(found.includes(${JSON.stringify(off)}) ? 0 : 1)
    `), {}, { unique: true })
  }, 180000)

  it('mutant|escape: an unescaped term matches more than the literal', async () => {
    expect(ids((await searchOrgPeople(poolDb, { orgId, term: `${term}%`, limit: 20 })).items)).toEqual([`usrM_on2_${stamp}`])
    runSourceMutant(PEOPLE_FILE, 'const pattern = `%${escapeLikeTerm(input.term)}%`', 'const pattern = `%${input.term}%`', probe(`
      const found = (await people.searchOrgPeople(db, { orgId: ${JSON.stringify(orgId)}, term: ${JSON.stringify(`${term}%`)}, limit: 20 })).items
      process.exit(found.length > 1 ? 0 : 1)
    `), {}, { unique: true })
  }, 180000)

  it('mutant|page: without the page cut, more rows than the limit leave', async () => {
    const found = await searchOrgPeople(poolDb, { orgId, term, limit: 1 })
    expect(found.items).toHaveLength(1)
    expect(found.hasMore).toBe(true)
    runSourceMutant(PEOPLE_FILE, 'const page = kept.slice(0, input.limit)', 'const page = kept', probe(`
      const found = (await people.searchOrgPeople(db, { orgId: ${JSON.stringify(orgId)}, term: ${JSON.stringify(term)}, limit: 1 })).items
      process.exit(found.length > 1 ? 0 : 1)
    `), {}, { unique: true })
  }, 180000)

  it('mutant|detail: the full email as the detail is seen', async () => {
    const [row] = await resolveOrgPeople(poolDb, { orgId, ids: [bare] })
    expect(row.detail).toBe('di***@example.test')
    runSourceMutant(PEOPLE_FILE, 'detail: maskEmail(textOf(row.email))', 'detail: textOf(row.email)', probe(`
      const [row] = await people.resolveOrgPeople(db, { orgId: ${JSON.stringify(orgId)}, ids: [${JSON.stringify(bare)}] })
      process.exit(row && row.detail.includes('distinct.mutant') ? 0 : 1)
    `), {}, { unique: true })
  }, 180000)

  it('mutant|mark: a constant mark reports a member without task access as usable', async () => {
    const [row] = await resolveOrgPeople(poolDb, { orgId, ids: [bare] })
    expect(row.canUseTasks).toBe(false)
    runSourceMutant(PEOPLE_FILE, 'canUseTasks: holders.has(id)', 'canUseTasks: true', probe(`
      const [row] = await people.resolveOrgPeople(db, { orgId: ${JSON.stringify(orgId)}, ids: [${JSON.stringify(bare)}] })
      process.exit(row && row.canUseTasks === true ? 0 : 1)
    `), {}, { unique: true })
  }, 180000)

  it('mutant|view: without the view check, someone with no role on the task reads its people', async () => {
    await expect(loadTaskPeople({ orgId, actorId: outsider, taskId: cell.taskId })).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
    runSourceMutant(PEOPLE_FILE, "  if (!can(roles, 'view')) fail(404, 'NOT_FOUND')\n", '', probe(`
      const read = await people.loadTaskPeople({ orgId: ${JSON.stringify(orgId)}, actorId: ${JSON.stringify(outsider)}, taskId: ${JSON.stringify(cell.taskId)} }).then(() => true, () => false)
      process.exit(read ? 0 : 1)
    `), {}, { unique: true })
  }, 180000)

  it('mutant|names: without the org on the name read, a member of another org is named', async () => {
    const a4 = `usrT_a4_${stamp}`
    expect((await loadTaskPeople({ orgId, actorId: cell.creator.userId, taskId: cell.taskId }))[a4]).toEqual({ name: '', status: 'inactive' })
    // The parameter stays bound, so the statement still runs.
    runSourceMutant(PEOPLE_FILE, ' AND uo.org_id = $2', ' AND $2::text IS NOT NULL', probe(`
      const map = await people.loadTaskPeople({ orgId: ${JSON.stringify(orgId)}, actorId: ${JSON.stringify(cell.creator.userId)}, taskId: ${JSON.stringify(cell.taskId)} })
      process.exit(map[${JSON.stringify(a4)}] && map[${JSON.stringify(a4)}].name !== '' ? 0 : 1)
    `), {}, { unique: true })
  }, 180000)

  it('mutant|status: a constant status reports a deactivated assignee as active', async () => {
    const a2 = `usrT_a2_${stamp}`
    expect((await loadTaskPeople({ orgId, actorId: cell.creator.userId, taskId: cell.taskId }))[a2].status).toBe('inactive')
    runSourceMutant(PEOPLE_FILE, "status: active.has(id) ? 'active' : 'inactive',", "status: 'active',", probe(`
      const map = await people.loadTaskPeople({ orgId: ${JSON.stringify(orgId)}, actorId: ${JSON.stringify(cell.creator.userId)}, taskId: ${JSON.stringify(cell.taskId)} })
      process.exit(map[${JSON.stringify(a2)}] && map[${JSON.stringify(a2)}].status === 'active' ? 0 : 1)
    `), {}, { unique: true })
  }, 180000)
})
