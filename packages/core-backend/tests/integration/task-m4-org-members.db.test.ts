import '../helpers/assert-rbac-optional-off'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import jwt from 'jsonwebtoken'
import pg from 'pg'
import { authService } from '../../src/auth/AuthService'
import { poolManager } from '../../src/integration/db/connection-pool'
import { completeTask, createTask, type Db } from '../../src/services/task-records'
import { newTaskListId } from '../../src/services/task-ids-runtime'
import { findActiveOrgMembers } from '../../src/services/task-org-members'
import { TASK_ASSIGNEE_SOFT_LIMIT, TASK_FOLLOWER_SOFT_LIMIT } from '../../src/tasks/task-membership'
import { dropTaskM4Fixtures, seedOrgMembers, seedTaskActor, whileStructureLockHeld, type SeededTaskActor } from '../helpers/task-m4-fixtures'
import { rawRequest, startTasksListener, type TasksListener } from '../helpers/tasks-http-harness'

/**
 * M4 PR-3a S9 (design task-m4-pr3a-backend-design-20260930.md §4.6, §10.1, §13 S9).
 * RULED(2026-10-07): [R17] [N2] the three task writes that name
 * another user, POST /api/tasks (every assignee other than the creator), POST
 * /api/tasks/:id/assignees and POST /api/tasks/:id/followers, require that user to be an active
 * member of the caller's org by the login test (user_orgs.is_active and users.is_active, by
 * org_id, and the account gate: activated, a role other than disabled, an RBAC admin checked as
 * admin). Every failure is the same 422 INACTIVE_ORG_MEMBER and nothing is written.
 * ASSUMPTION(task-m4): [own-16] the operator is never looked up. RULED(2026-10-07): [own-53] a
 * caller without a direct role gets the 404 before any lookup. A re-add (no event) never looks up;
 * LIMIT and the member-id check come first.
 *
 * "No lookup" is observed in the database, not inferred from the outcome: `readsUserOrgs` holds an
 * ACCESS EXCLUSIVE lock on `user_orgs` on a connection of its own while the request runs. A request
 * that reads the table queues on that lock and shows up in pg_locks; one that never reads it
 * finishes while the lock is held. The lane runs its files one at a time, and no auth step reads
 * `user_orgs` under RBAC_TOKEN_TRUST='true' (setup.integration.ts), so nothing else touches the
 * table in that window. The exemption cells use callers whose own org relation is deactivated: with
 * token trust such a token still carries its org, which is what makes "the operator is not looked
 * up" observable here (with trust off the token would resolve no org at all).
 *
 * HTTP goes through `tasksRouter()` on one listener per file (tests/helpers/tasks-http-harness.ts),
 * with `rawRequest` so that response bodies can be compared byte for byte. Tasks that a cell only
 * needs to exist are created through the service; list, list-member and over-limit member rows are
 * seeded with SQL.
 */

if (process.env.EXPECT_DB !== '1') {
  throw new Error('task-m4-org-members.db.test.ts requires EXPECT_DB=1')
}

const ORG_PREFIX = 'org_tasks_m4orgm_'
const seededUsers: string[] = []
const seededRoles: string[] = []

const INACTIVE_TEXT = JSON.stringify({ error: { code: 'INACTIVE_ORG_MEMBER' } })
const NOT_FOUND_TEXT = JSON.stringify({ error: { code: 'NOT_FOUND' } })

type Reply = { status: number; body: unknown; text: string }

function stampOf(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12)
}

function orgOf(label: string, stamp: string): string {
  return `${ORG_PREFIX}${label}_${stamp}`
}

async function actor(label: string, stamp: string, orgId: string, opts: { activeInOrg?: boolean } = {}): Promise<SeededTaskActor> {
  const seeded = await seedTaskActor({
    label, stamp, orgId, codes: ['tasks:read', 'tasks:write'], admission: true, activeInOrg: opts.activeInOrg,
  })
  seededUsers.push(seeded.userId)
  seededRoles.push(seeded.roleId)
  return seeded
}

/** A user someone else can name: `users` + `user_orgs` (active unless said otherwise). */
async function orgUser(userId: string, orgId: string, opts: { active?: boolean } = {}): Promise<string> {
  await seedOrgMembers(orgId, [userId], opts)
  seededUsers.push(userId)
  return userId
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

/**
 * Runs `start()` while this file's own connection holds ACCESS EXCLUSIVE on `user_orgs`. A
 * statement that reads the table queues on that lock: it is seen in pg_locks of this database, the
 * lock is released, and `read` is true. A request that never reads the table finishes while the
 * lock is still held, and `read` is false. Either way the request's own result is returned.
 */
async function readsUserOrgs<T>(start: () => Promise<T>): Promise<{ read: boolean; result: T }> {
  const holder = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await holder.connect()
  let open = false
  try {
    await holder.query('BEGIN')
    open = true
    await holder.query('LOCK TABLE user_orgs IN ACCESS EXCLUSIVE MODE')
    let settled = false
    const pending = start()
    pending.then(() => { settled = true }, () => { settled = true })
    let read = false
    const deadline = Date.now() + 15000
    while (!settled) {
      const waiting = await holder.query(
        `SELECT count(*)::int AS n FROM pg_locks
          WHERE locktype = 'relation' AND relation = 'user_orgs'::regclass AND NOT granted
            AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
      )
      if (Number(waiting.rows[0]?.n ?? 0) > 0) {
        read = true
        break
      }
      if (Date.now() > deadline) throw new Error('readsUserOrgs: the request neither finished nor queued on user_orgs')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    await holder.query('COMMIT')
    open = false
    return { read, result: await pending }
  } finally {
    if (open) await holder.query('ROLLBACK').catch(() => undefined)
    await holder.end()
  }
}

/** Every task row of the org with its assignee, follower and event rows, for "nothing was written". */
async function orgState(orgId: string): Promise<string> {
  const db = poolManager.get()
  const tasks = await db.query(
    `SELECT id, status, version, completion_mode, completed_at, updated_at FROM tasks WHERE org_id = $1 ORDER BY id`,
    [orgId],
  )
  const assignees = await db.query(
    `SELECT a.task_id, a.user_id, a.completed_at FROM task_assignees a JOIN tasks t ON t.id = a.task_id
     WHERE t.org_id = $1 ORDER BY a.task_id, a.user_id`,
    [orgId],
  )
  const followers = await db.query(
    `SELECT f.task_id, f.user_id FROM task_followers f JOIN tasks t ON t.id = f.task_id
     WHERE t.org_id = $1 ORDER BY f.task_id, f.user_id`,
    [orgId],
  )
  const events = await db.query(
    `SELECT e.id, e.event_type, e.actor_id, e.payload FROM task_events e JOIN tasks t ON t.id = e.task_id
     WHERE t.org_id = $1 ORDER BY e.id`,
    [orgId],
  )
  return JSON.stringify({ tasks: tasks.rows, assignees: assignees.rows, followers: followers.rows, events: events.rows })
}

/** Member ids in byte order (`COLLATE "C"`, the order of JS's default sort). */
async function memberIds(table: 'task_assignees' | 'task_followers', taskId: string): Promise<string[]> {
  const result = await poolManager.get().query(`SELECT user_id FROM ${table} WHERE task_id = $1 ORDER BY user_id COLLATE "C"`, [taskId])
  return result.rows.map((row) => String(row.user_id))
}

async function memberEvents(taskId: string): Promise<Array<{ event_type: string; actor_id: string; payload: unknown }>> {
  const result = await poolManager.get().query(
    `SELECT event_type, actor_id, payload FROM task_events
     WHERE task_id = $1 AND event_type IN ('assignee_added', 'follower_added') ORDER BY occurred_at, id`,
    [taskId],
  )
  return result.rows as Array<{ event_type: string; actor_id: string; payload: unknown }>
}

// ---------------------------------------------------------------------------------------------
// The three write points and the four ways a user is not an active member of the org.
// ---------------------------------------------------------------------------------------------

const WRITE_KEYS = ['create', 'assignees', 'followers'] as const
type WriteKey = typeof WRITE_KEYS[number]

interface Cell {
  stamp: string
  orgId: string
  otherOrg: string
  creator: SeededTaskActor
  /** A task of `creator`'s with the creator as its only assignee (the target of the M3 writes). */
  taskId: string
}

async function cellOf(label: string): Promise<Cell> {
  const stamp = stampOf()
  const orgId = orgOf(label, stamp)
  const creator = await actor(label, stamp, orgId)
  const task = await createTask({ orgId, creatorId: creator.userId, title: '备料复核', assignees: [creator.userId], completionMode: 'all' })
  return { stamp, orgId, otherOrg: orgOf(`${label}x`, stamp), creator, taskId: task.id }
}

/** The write at `key` naming `target`, by `bearer` (the cell's creator unless said otherwise). The
 * create names the creator too, as a task assigned to "me and someone" does. */
function writeAt(key: WriteKey, cell: Cell, target: string, bearer = cell.creator.bearer): Promise<Reply> {
  if (key === 'create') return post('/api/tasks', bearer, { title: '备料复核', assignees: [cell.creator.userId, target] })
  return post(`/api/tasks/${cell.taskId}/${key}`, bearer, { userId: target })
}

const REASON_KEYS = ['other-org', 'org-relation-off', 'user-off', 'unknown'] as const
type ReasonKey = typeof REASON_KEYS[number]

/** Seeds `userId` so that it is not an active member of `cell.orgId`, one column at a time. */
async function seedInactive(reason: ReasonKey, cell: Cell, userId: string): Promise<void> {
  if (reason === 'other-org') {
    // An active member of another org only: only `uo.org_id` keeps it out.
    await orgUser(userId, cell.otherOrg)
  } else if (reason === 'org-relation-off') {
    // The org relation exists but `user_orgs.is_active` is false; the user is active.
    await orgUser(userId, cell.orgId, { active: false })
  } else if (reason === 'user-off') {
    // The org relation is active but `users.is_active` is false.
    await orgUser(userId, cell.orgId)
    await poolManager.get().query('UPDATE users SET is_active = false WHERE id = $1', [userId])
  }
  // 'unknown': no users row and no user_orgs row.
}

describe('S9: the three write points (R17, N2)', () => {
  const cases = WRITE_KEYS.flatMap((write) => REASON_KEYS.map((reason) => [write, reason] as const))

  // Gate 17② counts each array row of this it.each (12 rows: 3 write points x 4 reasons).
  it.each(cases)('m4orgm|%s|%s: naming the user is 422 INACTIVE_ORG_MEMBER byte for byte, and nothing is written', async (write, reason) => {
    const cell = await cellOf(`r${WRITE_KEYS.indexOf(write)}${REASON_KEYS.indexOf(reason)}`)
    const target = `usrT_${write}_${cell.stamp}`
    await seedInactive(reason, cell, target)
    const before = await orgState(cell.orgId)
    const response = await writeAt(write, cell, target)
    expect(response.status).toBe(422)
    expect(response.text).toBe(INACTIVE_TEXT)
    expect(await orgState(cell.orgId)).toBe(before)
  })

  // The detector's positive control too: a real addition does read `user_orgs`.
  it.each(WRITE_KEYS)('m4orgm|%s|active: a same-org active member is written, after the lookup ran', async (write) => {
    const cell = await cellOf(`ok${WRITE_KEYS.indexOf(write)}`)
    const target = await orgUser(`usrT_ok_${cell.stamp}`, cell.orgId)
    const { read, result } = await readsUserOrgs(() => writeAt(write, cell, target))
    expect(result.status, result.text).toBe(200)
    expect(read).toBe(true)
    if (write === 'create') {
      const taskId = String((result.body as { id: string }).id)
      expect(await memberIds('task_assignees', taskId)).toEqual([cell.creator.userId, target].sort())
    } else if (write === 'assignees') {
      expect(await memberIds('task_assignees', cell.taskId)).toEqual([cell.creator.userId, target].sort())
      expect(await memberEvents(cell.taskId)).toEqual([
        { event_type: 'assignee_added', actor_id: cell.creator.userId, payload: { targetUserId: target } },
      ])
    } else {
      expect(result.body).toEqual({ id: cell.taskId, followers: [target] })
      expect(await memberIds('task_followers', cell.taskId)).toEqual([target])
      expect(await memberEvents(cell.taskId)).toEqual([
        { event_type: 'follower_added', actor_id: cell.creator.userId, payload: { targetUserId: target } },
      ])
    }
  })

  it('m4orgm|422 body: the four reasons give the same bytes at each write point, and the same bytes across the three', async () => {
    const texts = new Set<string>()
    for (const write of WRITE_KEYS) {
      const cell = await cellOf(`same${WRITE_KEYS.indexOf(write)}`)
      const perWrite: string[] = []
      for (const reason of REASON_KEYS) {
        const target = `usrT_${REASON_KEYS.indexOf(reason)}_${cell.stamp}`
        await seedInactive(reason, cell, target)
        const response = await writeAt(write, cell, target)
        expect(response.status, `${write} ${reason}`).toBe(422)
        perWrite.push(response.text)
        texts.add(response.text)
      }
      expect(new Set(perWrite).size, write).toBe(1)
    }
    expect([...texts]).toEqual([INACTIVE_TEXT])
    // The body names nothing: no user id, no reason.
    expect(JSON.parse(INACTIVE_TEXT)).toEqual({ error: { code: 'INACTIVE_ORG_MEMBER' } })
  })

  it('m4orgm|create|mixed: one inactive id among active ones is the 422 and no task is created', async () => {
    const cell = await cellOf('mixed')
    const active = await orgUser(`usrA_mixed_${cell.stamp}`, cell.orgId)
    const inactive = await orgUser(`usrI_mixed_${cell.stamp}`, cell.orgId, { active: false })
    const before = await orgState(cell.orgId)
    // The inactive id comes second, and the creator is not in the list.
    const response = await post('/api/tasks', cell.creator.bearer, { title: '备料复核', assignees: [active, inactive] })
    expect(response.status).toBe(422)
    expect(response.text).toBe(INACTIVE_TEXT)
    expect(await orgState(cell.orgId)).toBe(before)
    // Control: the same create without the inactive id goes through.
    const ok = await post('/api/tasks', cell.creator.bearer, { title: '备料复核', assignees: [active] })
    expect(ok.status, ok.text).toBe(200)
  })

  // RULED(2026-10-07): [R17] [N2] every distinct id except the creator is looked up, wherever it
  // stands in the list. A separate table from the 12 rows above: the inactive user is the only id,
  // or comes before the creator. The route keeps the order sent (distinct ids, first occurrence
  // wins), so the target really is first.
  const FIRST_SHAPES = ['alone', 'before the creator'] as const
  const firstCases = REASON_KEYS.flatMap((reason) => FIRST_SHAPES.map((shape) => [reason, shape] as const))

  it.each(firstCases)('m4orgm|create|first|%s|%s: naming the inactive user first is 422 INACTIVE_ORG_MEMBER byte for byte, and nothing is written', async (reason, shape) => {
    const cell = await cellOf(`f${REASON_KEYS.indexOf(reason)}${FIRST_SHAPES.indexOf(shape)}`)
    const target = `usrT_first_${cell.stamp}`
    await seedInactive(reason, cell, target)
    const before = await orgState(cell.orgId)
    const assignees = shape === 'alone' ? [target] : [target, cell.creator.userId]
    const response = await post('/api/tasks', cell.creator.bearer, { title: '备料复核', assignees })
    expect(response.status).toBe(422)
    expect(response.text).toBe(INACTIVE_TEXT)
    expect(await orgState(cell.orgId)).toBe(before)
  })

  // The create's lookup runs inside its transaction after the org structure lock (design §4.6): a
  // target deactivated while the create waits on the lock is refused, and one reactivated while it
  // waits is written.
  it('m4orgm|create|queued: a target deactivated while the create waits on the structure lock is 422 with nothing written; reactivated while it waits, the create goes through', async () => {
    const cell = await cellOf('queued')
    const target = await orgUser(`usrQ_queued_${cell.stamp}`, cell.orgId)
    const body = { title: '备料复核', assignees: [cell.creator.userId, target] }
    const setActive = (active: boolean) => async (holder: pg.Client) => {
      await holder.query('UPDATE user_orgs SET is_active = $3 WHERE user_id = $1 AND org_id = $2', [target, cell.orgId, active])
    }
    const before = await orgState(cell.orgId)
    const refused = await whileStructureLockHeld(cell.orgId, () => post('/api/tasks', cell.creator.bearer, body), setActive(false))
    expect(refused.result.status).toBe(422)
    expect(refused.result.text).toBe(INACTIVE_TEXT)
    expect(await orgState(cell.orgId)).toBe(before)
    const written = await whileStructureLockHeld(cell.orgId, () => post('/api/tasks', cell.creator.bearer, body), setActive(true))
    expect(written.result.status, written.result.text).toBe(200)
    expect(await memberIds('task_assignees', String((written.result.body as { id: string }).id))).toEqual([cell.creator.userId, target].sort())
  })

  it('m4orgm|assignees|done: an inactive new assignee on a done all-mode task is the 422; the task stays done at the same version', async () => {
    const cell = await cellOf('done')
    await completeTask({ orgId: cell.orgId, actorId: cell.creator.userId, taskId: cell.taskId })
    const target = await orgUser(`usrI_done_${cell.stamp}`, cell.orgId, { active: false })
    const before = await orgState(cell.orgId)
    expect(before).toContain('"status":"done"')
    const response = await writeAt('assignees', cell, target)
    expect(response.status).toBe(422)
    expect(response.text).toBe(INACTIVE_TEXT)
    expect(await orgState(cell.orgId)).toBe(before)
  })
})

// ---------------------------------------------------------------------------------------------
// The account half of the login test: a disabled role or a pending activation is refused like the
// four reasons above; a disabled role together with the RBAC admin role passes, as it does at
// login (login checks the role it resolves, and the admin role resolves to admin).
// ---------------------------------------------------------------------------------------------

const ACCOUNT_KEYS = ['role-disabled', 'pending-activation', 'role-disabled-admin'] as const
type AccountKey = typeof ACCOUNT_KEYS[number]

/** Seeds `userId` as an active member of `orgId` (both `is_active` columns true) whose account is
 * in state `key`. */
async function seedAccount(key: AccountKey, orgId: string, userId: string): Promise<void> {
  await orgUser(userId, orgId)
  const db = poolManager.get()
  if (key === 'pending-activation') {
    await db.query(`UPDATE users SET activation_status = 'pending_activation' WHERE id = $1`, [userId])
    return
  }
  await db.query(`UPDATE users SET role = 'disabled' WHERE id = $1`, [userId])
  if (key === 'role-disabled-admin') {
    await db.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'admin')`, [userId])
  }
}

describe('S9: the account half of the login test (R17, N2)', () => {
  const cases = WRITE_KEYS.flatMap((write) => ACCOUNT_KEYS.map((key) => [write, key] as const))

  it.each(cases)('m4orgm|%s|%s: the write follows the login gate (a refused account is 422 byte for byte with nothing written; the admin role is written)', async (write, key) => {
    const cell = await cellOf(`a${WRITE_KEYS.indexOf(write)}${ACCOUNT_KEYS.indexOf(key)}`)
    const target = `usrT_acct_${cell.stamp}`
    await seedAccount(key, cell.orgId, target)
    const before = await orgState(cell.orgId)
    const response = await writeAt(write, cell, target)
    if (key !== 'role-disabled-admin') {
      expect(response.status).toBe(422)
      expect(response.text).toBe(INACTIVE_TEXT)
      expect(await orgState(cell.orgId)).toBe(before)
      return
    }
    expect(response.status, response.text).toBe(200)
    const taskId = write === 'create' ? String((response.body as { id: string }).id) : cell.taskId
    expect(await memberIds(write === 'followers' ? 'task_followers' : 'task_assignees', taskId)).toContain(target)
  })

  it('m4orgm|login parity: the lookup admits exactly the users AuthService.verifyToken resolves into the org', async () => {
    const stamp = stampOf()
    const orgId = orgOf('parity', stamp)
    const otherOrg = orgOf('parityx', stamp)
    const pool = poolManager.get()
    const db: Db = { query: async (sql, params) => ({ rows: (await pool.query(sql, params)).rows }) }
    const shapes: Array<{ key: string; login: boolean; seed: (userId: string) => Promise<unknown> }> = [
      { key: 'active', login: true, seed: (userId) => orgUser(userId, orgId) },
      { key: 'other-org', login: false, seed: (userId) => orgUser(userId, otherOrg) },
      { key: 'org-relation-off', login: false, seed: (userId) => orgUser(userId, orgId, { active: false }) },
      { key: 'user-off', login: false, seed: async (userId) => {
        await orgUser(userId, orgId)
        await pool.query('UPDATE users SET is_active = false WHERE id = $1', [userId])
      } },
      { key: 'unknown', login: false, seed: async () => undefined },
      ...ACCOUNT_KEYS.map((key) => ({ key, login: key === 'role-disabled-admin', seed: (userId: string) => seedAccount(key, orgId, userId) })),
    ]
    for (const shape of shapes) {
      const userId = `usrP_${shape.key.replace(/-/g, '')}_${stamp}`
      await shape.seed(userId)
      // A token without roles or perms claims is never taken from its claims: verifyToken reads the
      // user from the database, runs the account gate on it and resolves the claimed org.
      const token = jwt.sign({ userId, sub: userId, tenantId: orgId }, String(process.env.JWT_SECRET), { expiresIn: '1h' })
      const verified = (await authService.verifyToken(token)) as { tenantId?: string } | null
      const login = verified?.tenantId === orgId
      const lookup = (await findActiveOrgMembers(db, orgId, [userId])).has(userId)
      expect(login, `${shape.key}: login`).toBe(shape.login)
      expect(lookup, `${shape.key}: lookup`).toBe(login)
    }
  })
})

// ---------------------------------------------------------------------------------------------
// [own-16]: the operator is exempt, and only the operator.
// ---------------------------------------------------------------------------------------------

describe('S9: the operator exemption ([own-16])', () => {
  it('m4orgm|exempt|operator: a caller whose own org relation is deactivated creates, self-assigns and self-follows without a lookup', async () => {
    const stamp = stampOf()
    const orgId = orgOf('exempt', stamp)
    const me = await actor('exempt', stamp, orgId, { activeInOrg: false })
    for (const body of [{ title: '备料复核' }, { title: '备料复核', assignees: [me.userId] }, { title: '备料复核', assignees: [] }]) {
      const { read, result } = await readsUserOrgs(() => post('/api/tasks', me.bearer, body))
      expect(result.status, JSON.stringify(body)).toBe(200)
      expect(read, JSON.stringify(body)).toBe(false)
    }
    const task = await createTask({ orgId, creatorId: me.userId, title: '备料复核', assignees: [], completionMode: 'all' })
    const assign = await readsUserOrgs(() => post(`/api/tasks/${task.id}/assignees`, me.bearer, { userId: me.userId }))
    expect(assign.result.status, assign.result.text).toBe(200)
    expect(assign.read).toBe(false)
    const follow = await readsUserOrgs(() => post(`/api/tasks/${task.id}/followers`, me.bearer, { userId: me.userId }))
    expect(follow.result.status, follow.result.text).toBe(200)
    expect(follow.read).toBe(false)
    expect(await memberIds('task_assignees', task.id)).toEqual([me.userId])
    expect(await memberIds('task_followers', task.id)).toEqual([me.userId])
    expect((await memberEvents(task.id)).map((event) => event.event_type)).toEqual(['assignee_added', 'follower_added'])
  })

  it('m4orgm|exempt|operator only: the task creator named by an assignee is looked up like anyone else', async () => {
    const stamp = stampOf()
    const orgId = orgOf('xonly', stamp)
    const creator = await actor('xonlyc', stamp, orgId)
    const assignee = await actor('xonlya', stamp, orgId)
    const task = await createTask({ orgId, creatorId: creator.userId, title: '备料复核', assignees: [assignee.userId], completionMode: 'all' })
    await poolManager.get().query('UPDATE user_orgs SET is_active = false WHERE user_id = $1 AND org_id = $2', [creator.userId, orgId])
    const before = await orgState(orgId)
    for (const key of ['assignees', 'followers'] as const) {
      const response = await post(`/api/tasks/${task.id}/${key}`, assignee.bearer, { userId: creator.userId })
      expect(response.status, key).toBe(422)
      expect(response.text, key).toBe(INACTIVE_TEXT)
    }
    expect(await orgState(orgId)).toBe(before)
  })
})

// ---------------------------------------------------------------------------------------------
// Where the lookup sits: after the direct role, the member id and LIMIT; never for a re-add or a
// create that names only its creator.
// ---------------------------------------------------------------------------------------------

describe('S9: the lookup runs only for a real addition', () => {
  it('m4orgm|create|creator only: omitting assignees, naming only the creator, or naming nobody sends no lookup', async () => {
    const cell = await cellOf('conly')
    for (const body of [{ title: '备料复核' }, { title: '备料复核', assignees: [cell.creator.userId] }, { title: '备料复核', assignees: [] }]) {
      const { read, result } = await readsUserOrgs(() => post('/api/tasks', cell.creator.bearer, body))
      expect(result.status, JSON.stringify(body)).toBe(200)
      expect(read, JSON.stringify(body)).toBe(false)
    }
    // Positive control in the same cell: naming one more user does look up.
    const other = await orgUser(`usrO_conly_${cell.stamp}`, cell.orgId)
    const named = await readsUserOrgs(() => post('/api/tasks', cell.creator.bearer, { title: '备料复核', assignees: [cell.creator.userId, other] }))
    expect(named.result.status, named.result.text).toBe(200)
    expect(named.read).toBe(true)
  })

  it.each(['assignees', 'followers'] as const)('m4orgm|%s|re-add: a member who has since left the org is still a member, and adding them again is the no-op without a lookup', async (key) => {
    const cell = await cellOf(`readd${key === 'assignees' ? 'a' : 'f'}`)
    const member = await orgUser(`usrM_readd_${cell.stamp}`, cell.orgId)
    const added = await post(`/api/tasks/${cell.taskId}/${key}`, cell.creator.bearer, { userId: member })
    expect(added.status, added.text).toBe(200)
    await poolManager.get().query('UPDATE user_orgs SET is_active = false WHERE user_id = $1 AND org_id = $2', [member, cell.orgId])
    const before = await orgState(cell.orgId)
    const { read, result } = await readsUserOrgs(() => post(`/api/tasks/${cell.taskId}/${key}`, cell.creator.bearer, { userId: member }))
    expect(result.status, result.text).toBe(200)
    expect(read).toBe(false)
    expect(result.text).toBe(added.text)
    // Leaving the org does not clean the member row up (design §4.6).
    expect(await orgState(cell.orgId)).toBe(before)
    expect(await memberIds(key === 'assignees' ? 'task_assignees' : 'task_followers', cell.taskId)).toContain(member)
  })

  it.each(['assignees', 'followers'] as const)('m4orgm|%s|list editor: a caller whose edit comes only from a list gets the missing-task 404 before any lookup, for an inactive and an active target', async (key) => {
    const stamp = stampOf()
    const orgId = orgOf(`led${key === 'assignees' ? 'a' : 'f'}`, stamp)
    const creator = await actor(`ledc${key === 'assignees' ? 'a' : 'f'}`, stamp, orgId)
    const editor = await actor(`lede${key === 'assignees' ? 'a' : 'f'}`, stamp, orgId)
    const task = await createTask({ orgId, creatorId: creator.userId, title: '备料复核', assignees: [creator.userId], completionMode: 'all' })
    const listId = newTaskListId()
    const db = poolManager.get()
    await db.query(`INSERT INTO task_lists (id, org_id, name, created_by) VALUES ($1, $2, $3, $4)`, [listId, orgId, '备料复核', creator.userId])
    await db.query(`INSERT INTO task_list_members (list_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'edit')`, [listId, creator.userId, editor.userId])
    await db.query(`INSERT INTO task_list_items (list_id, task_id, org_id) VALUES ($1, $2, $3)`, [listId, task.id, orgId])
    const inactive = await orgUser(`usrI_led_${stamp}`, orgId, { active: false })
    const active = await orgUser(`usrA_led_${stamp}`, orgId)
    const before = await orgState(orgId)
    const missing = await post(`/api/tasks/tsk_missing_${stamp}/${key}`, editor.bearer, { userId: active })
    expect(missing.text).toBe(NOT_FOUND_TEXT)
    for (const target of [inactive, active]) {
      const { read, result } = await readsUserOrgs(() => post(`/api/tasks/${task.id}/${key}`, editor.bearer, { userId: target }))
      expect(result.status, target).toBe(404)
      expect(result.text, target).toBe(missing.text)
      expect(read, target).toBe(false)
    }
    expect(await orgState(orgId)).toBe(before)
    // Control: the editor does see the task (the 404 is the direct-role rule, not visibility).
    const detail = await rawRequest(port(), 'GET', `/api/tasks/${task.id}`, editor.bearer)
    expect(detail.status).toBe(200)
    expect((detail.body as { canManageMembers: boolean }).canManageMembers).toBe(false)
  })

  it.each(['assignees', 'followers'] as const)('m4orgm|%s|order: a malformed id is INVALID_ASSIGNEES and a full task is LIMIT, both before the lookup', async (key) => {
    const cell = await cellOf(`ord${key === 'assignees' ? 'a' : 'f'}`)
    const malformed = await readsUserOrgs(() => post(`/api/tasks/${cell.taskId}/${key}`, cell.creator.bearer, { userId: '..' }))
    expect(malformed.result.status).toBe(422)
    expect(malformed.result.body).toEqual({ error: { code: 'INVALID_ASSIGNEES' } })
    expect(malformed.read).toBe(false)
    // Fill the task to the soft limit with SQL (the creator already holds one assignee row).
    const db = poolManager.get()
    const table = key === 'assignees' ? 'task_assignees' : 'task_followers'
    const existing = key === 'assignees' ? 1 : 0
    const limit = key === 'assignees' ? TASK_ASSIGNEE_SOFT_LIMIT : TASK_FOLLOWER_SOFT_LIMIT
    await db.query(
      `INSERT INTO ${table} (task_id, user_id) SELECT $1, 'usrF_' || g || '_' || $2::text FROM generate_series(1, $3::int) AS g`,
      [cell.taskId, cell.stamp, limit - existing],
    )
    const before = await orgState(cell.orgId)
    const full = await readsUserOrgs(() => post(`/api/tasks/${cell.taskId}/${key}`, cell.creator.bearer, { userId: `usrI_ord_${cell.stamp}` }))
    expect(full.result.status).toBe(422)
    expect(full.result.body).toEqual({ error: { code: 'LIMIT' } })
    expect(full.read).toBe(false)
    expect(await orgState(cell.orgId)).toBe(before)
  })
})
