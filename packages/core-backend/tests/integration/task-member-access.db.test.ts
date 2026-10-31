import '../helpers/assert-rbac-optional-off'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import jwt from 'jsonwebtoken'
import pg from 'pg'
import { poolManager } from '../../src/integration/db/connection-pool'
import { createTask, type Db } from '../../src/services/task-records'
import { findTaskAccessHolders } from '../../src/services/task-member-access'
import {
  dropTaskM4Fixtures,
  grantFixtureTaskAccess,
  runSourceMutant,
  seedOrgMembers,
  seedTaskActor,
  signTaskToken,
  TASK_FIXTURE_MEMBER_ROLE,
  whileStructureLockHeld,
  type SeededTaskActor,
} from '../helpers/task-m4-fixtures'
import { rawRequest, startTasksListener, type TasksListener } from '../helpers/tasks-http-harness'

/**
 * The task access test at the two write points that name another user as an assignee: POST
 * /api/tasks (every assignee other than the creator) and POST /api/tasks/:id/assignees (any target
 * other than the caller). The named person must be able to use tasks: the same answer the task
 * routes give that person on a read route and on a write route. Every refusal is the same 422
 * ASSIGNEE_TASK_ACCESS_REQUIRED and nothing is written. The active-org-member test runs first and
 * is unchanged (task-m4-org-members.db.test.ts).
 *
 * The shape table compares, per seeded user, the server's own answer on both routes (a token with
 * no role or permission claims, so the user is read from the database as in production) with the
 * write points and with the predicate called on its own. Each shape uses a fresh user: the route
 * guard keeps a short per-user memo, so a user's grants never change after their first request.
 * The source mutants at the end must each turn a cell red.
 */

if (process.env.EXPECT_DB !== '1') {
  throw new Error('task-member-access.db.test.ts requires EXPECT_DB=1')
}

const ORG_PREFIX = 'org_tasks_mbracc_'
const seededUsers: string[] = []
const seededRoles: string[] = []

const REFUSED_TEXT = JSON.stringify({ error: { code: 'ASSIGNEE_TASK_ACCESS_REQUIRED' } })
const INACTIVE_TEXT = JSON.stringify({ error: { code: 'INACTIVE_ORG_MEMBER' } })

const ACCESS_FILE = new URL('../../src/services/task-member-access.ts', import.meta.url).pathname
const RECORDS_FILE = new URL('../../src/services/task-records.ts', import.meta.url).pathname
const STRUCTURE_FILE = new URL('../../src/services/task-structure.ts', import.meta.url).pathname
const POOL_FILE = new URL('../../src/integration/db/connection-pool.ts', import.meta.url).pathname

type Reply = { status: number; body: unknown; text: string }

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

/** An active member of `orgId` with no task access at all. */
async function bareMember(userId: string, orgId: string, opts: { active?: boolean } = {}): Promise<string> {
  await seedOrgMembers(orgId, [userId], { ...opts, taskAccess: false })
  seededUsers.push(userId)
  return userId
}

/** An active member of `orgId` with the fixture's task access (the default seed). */
async function usableMember(userId: string, orgId: string, opts: { active?: boolean } = {}): Promise<string> {
  await seedOrgMembers(orgId, [userId], opts)
  seededUsers.push(userId)
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

async function admissionRow(userId: string, enabled: boolean, source = 'test'): Promise<void> {
  await pool().query(
    `INSERT INTO user_namespace_admissions (user_id, namespace, enabled, source, created_at, updated_at)
     VALUES ($1, 'tasks', $2, $3, now(), now())`,
    [userId, enabled, source],
  )
}

async function directCodes(userId: string, codes: string[]): Promise<void> {
  for (const code of codes) {
    await pool().query('INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, $2)', [userId, code])
  }
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

function post(path: string, bearer: string, body: unknown): Promise<Reply> {
  return rawRequest(port(), 'POST', path, bearer, body)
}

function get(path: string, bearer: string): Promise<Reply> {
  return rawRequest(port(), 'GET', path, bearer)
}

/** Every task row of the org with its assignee, follower and event rows, for "nothing was written". */
async function orgState(orgId: string): Promise<string> {
  const tasks = await pool().query(
    `SELECT id, status, version, completion_mode, completed_at, updated_at FROM tasks WHERE org_id = $1 ORDER BY id`,
    [orgId],
  )
  const assignees = await pool().query(
    `SELECT a.task_id, a.user_id, a.completed_at FROM task_assignees a JOIN tasks t ON t.id = a.task_id
     WHERE t.org_id = $1 ORDER BY a.task_id, a.user_id`,
    [orgId],
  )
  const followers = await pool().query(
    `SELECT f.task_id, f.user_id FROM task_followers f JOIN tasks t ON t.id = f.task_id
     WHERE t.org_id = $1 ORDER BY f.task_id, f.user_id`,
    [orgId],
  )
  const events = await pool().query(
    `SELECT e.id, e.event_type, e.actor_id, e.payload FROM task_events e JOIN tasks t ON t.id = e.task_id
     WHERE t.org_id = $1 ORDER BY e.id`,
    [orgId],
  )
  return JSON.stringify({ tasks: tasks.rows, assignees: assignees.rows, followers: followers.rows, events: events.rows })
}

/** Member ids in byte order (`COLLATE "C"`, the order of JS's default sort). */
async function memberIds(taskId: string): Promise<string[]> {
  const result = await pool().query(`SELECT user_id FROM task_assignees WHERE task_id = $1 ORDER BY user_id COLLATE "C"`, [taskId])
  return result.rows.map((row) => String(row.user_id))
}

const WRITE_KEYS = ['create', 'assignees'] as const
type WriteKey = typeof WRITE_KEYS[number]

interface Cell {
  stamp: string
  orgId: string
  creator: SeededTaskActor
  /** A task of `creator`'s with the creator as its only assignee (the target of the add). */
  taskId: string
}

async function cellOf(label: string): Promise<Cell> {
  const stamp = stampOf()
  const orgId = orgOf(label, stamp)
  const creator = await actor(label, stamp, orgId)
  const task = await createTask({ orgId, creatorId: creator.userId, title: '备料复核', assignees: [creator.userId], completionMode: 'all' })
  return { stamp, orgId, creator, taskId: task.id }
}

/** The write at `key` naming `target`, by `bearer` (the cell's creator unless said otherwise). The
 * create names the creator too, as a task assigned to "me and someone" does. */
function writeAt(key: WriteKey, cell: Cell, target: string, bearer = cell.creator.bearer): Promise<Reply> {
  if (key === 'create') return post('/api/tasks', bearer, { title: '备料复核', assignees: [cell.creator.userId, target] })
  return post(`/api/tasks/${cell.taskId}/assignees`, bearer, { userId: target })
}

// ---------------------------------------------------------------------------------------------
// The shape table: what is seeded is in code; the expected answers are the vector below.
// ---------------------------------------------------------------------------------------------

const SHAPES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n'] as const
type Shape = typeof SHAPES[number]
const ADMITTED: ReadonlySet<Shape> = new Set<Shape>(['e', 'f', 'g', 'i', 'n'])

async function seedShape(shape: Shape, userId: string, orgId: string, stamp: string): Promise<void> {
  await bareMember(userId, orgId)
  const both = ['tasks:read', 'tasks:write']
  const db = pool()
  switch (shape) {
    case 'a':
      return
    case 'b':
      await roleWith(`role_b_${stamp}`, userId, both)
      return
    case 'c':
      await roleWith(`role_c_${stamp}`, userId, ['tasks:read'])
      await admissionRow(userId, true)
      return
    case 'd':
      await roleWith(`role_d_${stamp}`, userId, ['tasks:write'])
      await admissionRow(userId, true)
      return
    case 'e':
      await grantFixtureTaskAccess([userId])
      return
    case 'f':
      await db.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'admin')`, [userId])
      return
    case 'g':
      await db.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [userId])
      return
    case 'h':
      await db.query(`UPDATE users SET permissions = '["*:*"]'::jsonb WHERE id = $1`, [userId])
      return
    case 'i':
      await db.query(`UPDATE users SET permissions = '["*:*"]'::jsonb WHERE id = $1`, [userId])
      await grantFixtureTaskAccess([userId])
      return
    case 'j':
      await directCodes(userId, both)
      await admissionRow(userId, true)
      return
    case 'k':
      await roleWith(`role_k_${stamp}`, userId, both)
      await admissionRow(userId, false, 'platform_admin')
      return
    case 'l':
      await roleWith(`role_l_${stamp}`, userId, both)
      await admissionRow(userId, false, 'role_unassigned')
      return
    case 'm':
      await directCodes(userId, both)
      await admissionRow(userId, true)
      await roleWith(`role_m_${stamp}`, userId, ['attendance:read'])
      return
    case 'n':
      await db.query(
        `INSERT INTO permissions (code, name, description) VALUES ('tasks:*', 'Tasks All', 'all') ON CONFLICT (code) DO NOTHING`,
      )
      await roleWith(`role_n_${stamp}`, userId, ['tasks:*'])
      await admissionRow(userId, true)
      return
  }
}

describe('task access at the two write points', () => {
  it.each(SHAPES)('shape-%s', async (shape) => {
    const cell = await cellOf(`s${shape}`)
    const target = `usrT_${shape}_${cell.stamp}`
    await seedShape(shape, target, cell.orgId, cell.stamp)
    const admitted = ADMITTED.has(shape)

    // The server's own answer for this person, on a read route and on a write route.
    const bearer = claimsLessToken(target, cell.orgId)
    const read = await get('/api/tasks/context', bearer)
    const write = await post(`/api/tasks/tsk_missing_${cell.stamp}/comments`, bearer, { body: '备料复核' })
    expect([200, 403], read.text).toContain(read.status)
    expect([404, 403], write.text).toContain(write.status)
    const door = read.status === 200 && write.status === 404
    const predicate = (await findTaskAccessHolders(poolDb, [target])).has(target)
    expect(predicate, 'predicate').toBe(door)
    expect(door, 'expected').toBe(admitted)

    const texts: string[] = []
    for (const key of WRITE_KEYS) {
      const before = await orgState(cell.orgId)
      const response = await writeAt(key, cell, target)
      if (!admitted) {
        expect(response.status, key).toBe(422)
        expect(response.text, key).toBe(REFUSED_TEXT)
        expect(await orgState(cell.orgId), key).toBe(before)
        texts.push(response.text)
        continue
      }
      expect(response.status, `${key} ${response.text}`).toBe(200)
      const taskId = key === 'create' ? String((response.body as { id: string }).id) : cell.taskId
      expect(await memberIds(taskId), key).toEqual([cell.creator.userId, target].sort())
      if (key === 'create' && shape === 'e') {
        // The person written as an assignee does reach the task.
        const detail = await get(`/api/tasks/${taskId}`, bearer)
        expect(detail.status, detail.text).toBe(200)
      }
    }
    if (!admitted) expect(new Set(texts)).toEqual(new Set([REFUSED_TEXT]))
  })
})

describe('task access: order, lists, the exemptions', () => {
  it('tma|order: an inactive member is INACTIVE_ORG_MEMBER with or without task access (the org test runs first)', async () => {
    const cell = await cellOf('order')
    const withAccess = await usableMember(`usrI_acc_${cell.stamp}`, cell.orgId, { active: false })
    const without = await bareMember(`usrI_bare_${cell.stamp}`, cell.orgId, { active: false })
    for (const key of WRITE_KEYS) {
      for (const target of [withAccess, without]) {
        const before = await orgState(cell.orgId)
        const response = await writeAt(key, cell, target)
        expect(response.status, `${key} ${target}`).toBe(422)
        expect(response.text, `${key} ${target}`).toBe(INACTIVE_TEXT)
        expect(await orgState(cell.orgId)).toBe(before)
      }
    }
  })

  it('tma|create|mixed: one person without task access among people with it, first or last, is the 422 and no task is created', async () => {
    const cell = await cellOf('mixed')
    const ok1 = await usableMember(`usrA_mixed1_${cell.stamp}`, cell.orgId)
    const ok2 = await usableMember(`usrA_mixed2_${cell.stamp}`, cell.orgId)
    const refused = await bareMember(`usrR_mixed_${cell.stamp}`, cell.orgId)
    for (const assignees of [[refused, ok1, ok2], [ok1, ok2, refused], [cell.creator.userId, ok1, refused]]) {
      const before = await orgState(cell.orgId)
      const response = await post('/api/tasks', cell.creator.bearer, { title: '备料复核', assignees })
      expect(response.status, JSON.stringify(assignees)).toBe(422)
      expect(response.text).toBe(REFUSED_TEXT)
      expect(await orgState(cell.orgId)).toBe(before)
    }
    const control = await post('/api/tasks', cell.creator.bearer, { title: '备料复核', assignees: [ok1, ok2] })
    expect(control.status, control.text).toBe(200)
  })

  it('tma|self: a creator who holds only the write code creates with assignees omitted, only themselves or nobody', async () => {
    const stamp = stampOf()
    const orgId = orgOf('self', stamp)
    const me = await actor('selfw', stamp, orgId, ['tasks:write'])
    for (const body of [{ title: '备料复核' }, { title: '备料复核', assignees: [me.userId] }, { title: '备料复核', assignees: [] }]) {
      const response = await post('/api/tasks', me.bearer, body)
      expect(response.status, `${JSON.stringify(body)} ${response.text}`).toBe(200)
    }
  })

  it('tma|self-add: the same creator, not yet an assignee, adds themselves', async () => {
    const stamp = stampOf()
    const orgId = orgOf('selfadd', stamp)
    const me = await actor('selfaddw', stamp, orgId, ['tasks:write'])
    const created = await post('/api/tasks', me.bearer, { title: '备料复核', assignees: [] })
    expect(created.status, created.text).toBe(200)
    const taskId = String((created.body as { id: string }).id)
    expect(await memberIds(taskId)).toEqual([])
    const added = await post(`/api/tasks/${taskId}/assignees`, me.bearer, { userId: me.userId })
    expect(added.status, added.text).toBe(200)
    expect(await memberIds(taskId)).toEqual([me.userId])
  })

  it('tma|creator named by another: the creator added by an assignee is checked like anyone else', async () => {
    const stamp = stampOf()
    const orgId = orgOf('named', stamp)
    const assignee = await usableMember(`usrE_named_${stamp}`, orgId)
    const assigneeBearer = signTaskToken(assignee, TASK_FIXTURE_MEMBER_ROLE, orgId)

    const partial = await actor('namedw', stamp, orgId, ['tasks:write'])
    const first = await post('/api/tasks', partial.bearer, { title: '备料复核', assignees: [assignee] })
    expect(first.status, first.text).toBe(200)
    const firstId = String((first.body as { id: string }).id)
    const before = await orgState(orgId)
    const refused = await post(`/api/tasks/${firstId}/assignees`, assigneeBearer, { userId: partial.userId })
    expect(refused.status).toBe(422)
    expect(refused.text).toBe(REFUSED_TEXT)
    expect(await orgState(orgId)).toBe(before)

    const full = await actor('namedf', stamp, orgId)
    const second = await post('/api/tasks', full.bearer, { title: '备料复核', assignees: [assignee] })
    expect(second.status, second.text).toBe(200)
    const secondId = String((second.body as { id: string }).id)
    const allowed = await post(`/api/tasks/${secondId}/assignees`, assigneeBearer, { userId: full.userId })
    expect(allowed.status, allowed.text).toBe(200)
    expect(await memberIds(secondId)).toEqual([assignee, full.userId].sort())
  })

  it('tma|re-add: a member whose task access was removed after they were added is re-added as the no-op', async () => {
    const cell = await cellOf('readd')
    const member = await usableMember(`usrM_readd_${cell.stamp}`, cell.orgId)
    const added = await writeAt('assignees', cell, member)
    expect(added.status, added.text).toBe(200)
    await pool().query('DELETE FROM user_namespace_admissions WHERE user_id = $1', [member])
    await pool().query('DELETE FROM user_roles WHERE user_id = $1', [member])
    const before = await orgState(cell.orgId)
    const again = await writeAt('assignees', cell, member)
    expect(again.status, again.text).toBe(200)
    expect(again.text).toBe(added.text)
    expect(await orgState(cell.orgId)).toBe(before)
    // A new create naming the same person is refused now.
    const create = await writeAt('create', cell, member)
    expect(create.status).toBe(422)
    expect(create.text).toBe(REFUSED_TEXT)
  })

  it('tma|create|queued: task access turned off while the create waits on the structure lock is the 422; turned on while it waits, the create goes through', async () => {
    const cell = await cellOf('queued')
    const target = await usableMember(`usrQ_queued_${cell.stamp}`, cell.orgId)
    const body = { title: '备料复核', assignees: [cell.creator.userId, target] }
    const setEnabled = (enabled: boolean) => async (holder: pg.Client) => {
      await holder.query(`UPDATE user_namespace_admissions SET enabled = $2 WHERE user_id = $1 AND namespace = 'tasks'`, [target, enabled])
    }
    const before = await orgState(cell.orgId)
    const refused = await whileStructureLockHeld(cell.orgId, () => post('/api/tasks', cell.creator.bearer, body), setEnabled(false))
    expect(refused.result.status).toBe(422)
    expect(refused.result.text).toBe(REFUSED_TEXT)
    expect(await orgState(cell.orgId)).toBe(before)
    const written = await whileStructureLockHeld(cell.orgId, () => post('/api/tasks', cell.creator.bearer, body), setEnabled(true))
    expect(written.result.status, written.result.text).toBe(200)
    expect(await memberIds(String((written.result.body as { id: string }).id))).toEqual([cell.creator.userId, target].sort())
  })
})

// ---------------------------------------------------------------------------------------------
// Source mutants: each rewrite must turn the cell it names red. The child script exits 0 only when
// it observes the wrong answer the mutant produces.
// ---------------------------------------------------------------------------------------------

/** The child's preamble: a pool-backed Db and the predicate, on the mutated sources. */
function probe(body: string): string {
  return `
    const { poolManager } = await import(${JSON.stringify(POOL_FILE)})
    const pool = poolManager.get()
    const db = { query: async (sql, params) => ({ rows: (await pool.query(sql, params)).rows }) }
    const { findTaskAccessHolders } = await import(${JSON.stringify(ACCESS_FILE)})
    const holds = async (userId) => (await findTaskAccessHolders(db, [userId])).has(userId)
    const codeOf = async (run) => { try { await run(); return 'ok' } catch (error) { return String(error && error.code) } }
    ${body}
  `
}

const ORG_ASSERT_LINE = '    await assertActiveOrgMembers(db, input.orgId, assignees.filter((userId) => userId !== input.creatorId))'
const ACCESS_ASSERT_COMMENT = [
  '    // Then every assignee other than the creator must be able to use tasks (task-member-access.ts);',
  '    // any other id is 422 ASSIGNEE_TASK_ACCESS_REQUIRED and nothing is written. The creator is exempt',
  '    // on this call only.',
].join('\n')
const ACCESS_ASSERT_LINE = '    await assertTaskAccess(db, assignees.filter((userId) => userId !== input.creatorId))'
const ADD_ACCESS_LINE = 'if (userId !== input.actorId) await assertTaskAccess(db, [userId])'

describe('task access: source mutants', () => {
  it('mutant|m1: shape-h is admitted', async () => {
    const stamp = stampOf()
    const orgId = orgOf('mut1', stamp)
    const userId = `usrT_m1_${stamp}`
    await seedShape('h', userId, orgId, stamp)
    expect((await findTaskAccessHolders(poolDb, [userId])).has(userId)).toBe(false)
    runSourceMutant(ACCESS_FILE, " && await userHasEffectiveNamespaceAccess(userId, 'tasks', db.query)", '', probe(`
      const admitted = await holds(${JSON.stringify(userId)})
      console.log(JSON.stringify({ mutant: 'm1', admitted }))
      process.exit(admitted ? 0 : 1)
    `), {}, { unique: true })
  }, 180000)

  it('mutant|m2: shape-c is admitted', async () => {
    const stamp = stampOf()
    const orgId = orgOf('mut2', stamp)
    const userId = `usrT_m2_${stamp}`
    await seedShape('c', userId, orgId, stamp)
    expect((await findTaskAccessHolders(poolDb, [userId])).has(userId)).toBe(false)
    runSourceMutant(ACCESS_FILE, " && holdsTaskCode(codes, 'tasks:write')", '', probe(`
      const admitted = await holds(${JSON.stringify(userId)})
      console.log(JSON.stringify({ mutant: 'm2', admitted }))
      process.exit(admitted ? 0 : 1)
    `), {}, { unique: true })
  }, 180000)

  it('mutant|m3: shape-g is refused', async () => {
    const stamp = stampOf()
    const orgId = orgOf('mut3', stamp)
    const userId = `usrT_m3_${stamp}`
    await seedShape('g', userId, orgId, stamp)
    expect((await findTaskAccessHolders(poolDb, [userId])).has(userId)).toBe(true)
    runSourceMutant(ACCESS_FILE, "u.role = 'admin' OR ", '', probe(`
      const admitted = await holds(${JSON.stringify(userId)})
      console.log(JSON.stringify({ mutant: 'm3', admitted }))
      process.exit(admitted ? 1 : 0)
    `), {}, { unique: true })
  }, 180000)

  it('mutant|m4: the codes read leaves the caller db, so a code removed after the first answer is still honoured', async () => {
    const stamp = stampOf()
    const orgId = orgOf('mut4', stamp)
    const seed = async (label: string): Promise<{ userId: string; roleId: string }> => {
      const userId = `usrT_${label}_${stamp}`
      const roleId = `role_${label}_${stamp}`
      await bareMember(userId, orgId)
      await roleWith(roleId, userId, ['tasks:read', 'tasks:write'])
      await admissionRow(userId, true)
      return { userId, roleId }
    }
    // Control, unmutated: the second answer follows the database.
    const control = await seed('m4c')
    expect((await findTaskAccessHolders(poolDb, [control.userId])).has(control.userId)).toBe(true)
    await pool().query(`DELETE FROM role_permissions WHERE role_id = $1 AND permission_code = 'tasks:write'`, [control.roleId])
    expect((await findTaskAccessHolders(poolDb, [control.userId])).has(control.userId)).toBe(false)

    const target = await seed('m4m')
    runSourceMutant(ACCESS_FILE, 'listUserPermissions(userId, db.query)', 'listUserPermissions(userId)', probe(`
      const first = await holds(${JSON.stringify(target.userId)})
      await pool.query("DELETE FROM role_permissions WHERE role_id = $1 AND permission_code = 'tasks:write'", [${JSON.stringify(target.roleId)}])
      const second = await holds(${JSON.stringify(target.userId)})
      console.log(JSON.stringify({ mutant: 'm4', first, second }))
      process.exit(first && second ? 0 : 1)
    `), {}, { unique: true })
  }, 180000)

  it('mutant|m5: the two checks swapped at create, an inactive member without task access answers the access code', async () => {
    const cell = await cellOf('mut5')
    const target = await bareMember(`usrI_m5_${cell.stamp}`, cell.orgId, { active: false })
    const response = await writeAt('create', cell, target)
    expect(response.text).toBe(INACTIVE_TEXT)
    runSourceMutant(
      RECORDS_FILE,
      `${ORG_ASSERT_LINE}\n${ACCESS_ASSERT_COMMENT}\n${ACCESS_ASSERT_LINE}`,
      `${ACCESS_ASSERT_LINE}\n${ORG_ASSERT_LINE}`,
      probe(`
        const { createTask } = await import(${JSON.stringify(RECORDS_FILE)})
        const code = await codeOf(() => createTask({ orgId: ${JSON.stringify(cell.orgId)}, creatorId: ${JSON.stringify(cell.creator.userId)}, title: '备料复核', assignees: [${JSON.stringify(target)}] }))
        console.log(JSON.stringify({ mutant: 'm5', code }))
        process.exit(code === 'ASSIGNEE_TASK_ACCESS_REQUIRED' ? 0 : 1)
      `),
      {},
      { unique: true },
    )
  }, 180000)

  it('mutant|m6: the creator is not exempt at create, a creator with only the write code is refused for naming themselves', async () => {
    const stamp = stampOf()
    const orgId = orgOf('mut6', stamp)
    const me = await actor('mut6w', stamp, orgId, ['tasks:write'])
    await expect(createTask({ orgId, creatorId: me.userId, title: '备料复核', assignees: [me.userId], completionMode: 'all' })).resolves.toBeDefined()
    runSourceMutant(RECORDS_FILE, ACCESS_ASSERT_LINE.trimStart().replace('await ', ''), 'assertTaskAccess(db, assignees)', probe(`
      const { createTask } = await import(${JSON.stringify(RECORDS_FILE)})
      const code = await codeOf(() => createTask({ orgId: ${JSON.stringify(orgId)}, creatorId: ${JSON.stringify(me.userId)}, title: '备料复核', assignees: [${JSON.stringify(me.userId)}] }))
      console.log(JSON.stringify({ mutant: 'm6', code }))
      process.exit(code === 'ASSIGNEE_TASK_ACCESS_REQUIRED' ? 0 : 1)
    `), {}, { unique: true })
  }, 180000)

  it('mutant|m7: no check at the assignee add, shape-a is added', async () => {
    const cell = await cellOf('mut7')
    const target = await bareMember(`usrT_m7_${cell.stamp}`, cell.orgId)
    expect((await writeAt('assignees', cell, target)).text).toBe(REFUSED_TEXT)
    runSourceMutant(STRUCTURE_FILE, ADD_ACCESS_LINE, '', probe(`
      const { addAssignee } = await import(${JSON.stringify(STRUCTURE_FILE)})
      const code = await codeOf(() => addAssignee({ orgId: ${JSON.stringify(cell.orgId)}, actorId: ${JSON.stringify(cell.creator.userId)}, taskId: ${JSON.stringify(cell.taskId)}, body: { userId: ${JSON.stringify(target)} } }))
      console.log(JSON.stringify({ mutant: 'm7', code }))
      process.exit(code === 'ok' ? 0 : 1)
    `), {}, { unique: true })
  }, 180000)

  it('mutant|m8: no check at create, shape-a is written as an assignee', async () => {
    const cell = await cellOf('mut8')
    const target = await bareMember(`usrT_m8_${cell.stamp}`, cell.orgId)
    expect((await writeAt('create', cell, target)).text).toBe(REFUSED_TEXT)
    runSourceMutant(RECORDS_FILE, ACCESS_ASSERT_LINE.trimStart(), '', probe(`
      const { createTask } = await import(${JSON.stringify(RECORDS_FILE)})
      const code = await codeOf(() => createTask({ orgId: ${JSON.stringify(cell.orgId)}, creatorId: ${JSON.stringify(cell.creator.userId)}, title: '备料复核', assignees: [${JSON.stringify(cell.creator.userId)}, ${JSON.stringify(target)}] }))
      console.log(JSON.stringify({ mutant: 'm8', code }))
      process.exit(code === 'ok' ? 0 : 1)
    `), {}, { unique: true })
  }, 180000)

  it('mutant|m9: self is not exempt at the assignee add, a creator with only the write code is refused for adding themselves', async () => {
    const stamp = stampOf()
    const orgId = orgOf('mut9', stamp)
    const me = await actor('mut9w', stamp, orgId, ['tasks:write'])
    const task = await createTask({ orgId, creatorId: me.userId, title: '备料复核', assignees: [], completionMode: 'all' })
    runSourceMutant(STRUCTURE_FILE, ADD_ACCESS_LINE, 'await assertTaskAccess(db, [userId])', probe(`
      const { addAssignee } = await import(${JSON.stringify(STRUCTURE_FILE)})
      const code = await codeOf(() => addAssignee({ orgId: ${JSON.stringify(orgId)}, actorId: ${JSON.stringify(me.userId)}, taskId: ${JSON.stringify(task.id)}, body: { userId: ${JSON.stringify(me.userId)} } }))
      console.log(JSON.stringify({ mutant: 'm9', code }))
      process.exit(code === 'ASSIGNEE_TASK_ACCESS_REQUIRED' ? 0 : 1)
    `), {}, { unique: true })
  }, 180000)

  it('mutant|m14: shape-n is refused', async () => {
    const stamp = stampOf()
    const orgId = orgOf('mut14', stamp)
    const userId = `usrT_m14_${stamp}`
    await seedShape('n', userId, orgId, stamp)
    expect((await findTaskAccessHolders(poolDb, [userId])).has(userId)).toBe(true)
    runSourceMutant(ACCESS_FILE, 'codes.includes(`${resource}:*`)', 'false', probe(`
      const admitted = await holds(${JSON.stringify(userId)})
      console.log(JSON.stringify({ mutant: 'm14', admitted }))
      process.exit(admitted ? 1 : 0)
    `), {}, { unique: true })
  }, 180000)
})
