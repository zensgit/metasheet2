import '../helpers/assert-rbac-optional-off'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type express from 'express'
import request from 'supertest'
import { ICollabService } from '../../src/di/identifiers'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { buildAuthenticatedUserRoom } from '../../src/services/CollabService'
import {
  resetTaskCountsBroadcasterForTests,
  setTaskCountsBroadcaster,
  TASK_COUNTS_UPDATED_EVENT,
  type TaskCountsBroadcaster,
} from '../../src/services/task-counts-realtime'
import { completeTask, createTask } from '../../src/services/task-records'
import { dropTaskM4Fixtures, runSourceMutant, seedOrgMembers, seedTaskActor, type SeededTaskActor } from '../helpers/task-m4-fixtures'
import { rawRequest, startTasksListener, type TasksListener } from '../helpers/tasks-http-harness'

/**
 * M4 PR-3c (design task-m4-pr3c-backend-design-20261008.md §3–§5, §7.2). Candidate gate 26 cells
 * (`M4|26|整门`, unscored until the R01 lock amendment lands; ASSUMPTION(task-m4): [own-3c-13]).
 *
 * RULED(2026-10-07): [R16] a committed task write that changed an input of the pending predicate
 * sends `tasks:counts-updated` once to every assignee before or after it, on the authenticated user
 * room, with a payload that carries nothing; followers get nothing; a write that rolls back sends
 * nothing. The send port is replaced by a recorder for the whole file (no socket server).
 *
 * HTTP goes through `tasksRouter()` on one listener per file (tests/helpers/tasks-http-harness.ts;
 * setup.integration.ts, RBAC_TOKEN_TRUST='true'). Tasks a cell only needs to exist are created
 * through the service (that create's own sends are outside every measured window); followers are
 * seeded with SQL.
 *
 * The rollback cells make COMMIT itself fail: a constraint trigger, deferred to commit time, raises
 * for `task_events` rows of one task id only, and is dropped in `finally` (and swept in `afterAll`).
 * A failure inside the handler could not tell a send made inside the transaction from one made
 * after it; a failure at COMMIT can.
 */

if (process.env.EXPECT_DB !== '1') {
  throw new Error('task-m4-realtime.db.test.ts requires EXPECT_DB=1')
}

const ORG_PREFIX = 'org_tasks_m4rt_'
const FAIL_PREFIX = 'tasks_m4rt_fail_'
const seededUsers: string[] = []
const seededRoles: string[] = []

const INTERNAL_TEXT = JSON.stringify({ error: { code: 'INTERNAL' } })

const INDEX_FILE = new URL('../../src/index.ts', import.meta.url).pathname
const IDENTIFIERS_FILE = new URL('../../src/di/identifiers.ts', import.meta.url).pathname
const RECORDS_FILE = new URL('../../src/services/task-records.ts', import.meta.url).pathname
const STRUCTURE_FILE = new URL('../../src/services/task-structure.ts', import.meta.url).pathname
const REALTIME_FILE = new URL('../../src/services/task-counts-realtime.ts', import.meta.url).pathname
const COLLAB_FILE = new URL('../../src/services/CollabService.ts', import.meta.url).pathname

interface Send { room: string; event: string; payload: unknown }

const sends: Send[] = []
const record: TaskCountsBroadcaster = (room, event, payload) => {
  sends.push({ room, event, payload })
}

let listener: TasksListener | undefined

beforeAll(async () => {
  setTaskCountsBroadcaster(record)
  listener = await startTasksListener()
})

afterAll(async () => {
  resetTaskCountsBroadcasterForTests()
  await sweepFailTriggers()
  await dropTaskM4Fixtures({ orgPrefix: ORG_PREFIX, userIds: seededUsers, roleIds: seededRoles })
  await listener?.close()
})

function stampOf(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12)
}

function orgOf(label: string, stamp: string): string {
  return `${ORG_PREFIX}${label}_${stamp}`
}

async function actor(label: string, stamp: string, orgId: string): Promise<SeededTaskActor> {
  const seeded = await seedTaskActor({ label, stamp, orgId, codes: ['tasks:read', 'tasks:write'], admission: true })
  seededUsers.push(seeded.userId)
  seededRoles.push(seeded.roleId)
  return seeded
}

/** A user someone else can name: `users` + an active `user_orgs` row. */
async function member(label: string, stamp: string, orgId: string): Promise<string> {
  const userId = `usr_${label}_${stamp}`
  await seedOrgMembers(orgId, [userId])
  seededUsers.push(userId)
  return userId
}

async function taskWith(input: {
  orgId: string
  creator: string
  assignees: string[]
  followers?: string[]
  mode?: 'all' | 'any'
}): Promise<string> {
  const { id } = await createTask({
    orgId: input.orgId,
    creatorId: input.creator,
    title: '备料复核',
    assignees: input.assignees,
    completionMode: input.mode ?? 'all',
  })
  for (const follower of input.followers ?? []) {
    await poolManager.get().query('INSERT INTO task_followers (task_id, user_id) VALUES ($1, $2)', [id, follower])
  }
  return id
}

function port(): number {
  if (!listener) throw new Error('tasks listener not started')
  return listener.port
}

type Reply = { status: number; body: unknown; text: string }

function http(method: string, path: string, bearer: string, body?: unknown): Promise<Reply> {
  return rawRequest(port(), method, path, bearer, body)
}

/** Rooms of `userIds`, in user id order (the order recipients are sent in). */
function roomsOf(...userIds: string[]): string[] {
  return [...userIds].sort().map(buildAuthenticatedUserRoom)
}

/**
 * Runs one write and returns its result with the rooms it sent to, in send order. Every send of the
 * write is checked here: the event name, the empty payload, a room of the authenticated-user form.
 */
async function sendsOf<T>(write: () => Promise<T>): Promise<{ result: T; rooms: string[] }> {
  const mark = sends.length
  const result = await write()
  const made = sends.slice(mark)
  for (const send of made) {
    expect(send.event).toBe('tasks:counts-updated')
    expect(JSON.stringify(send.payload)).toBe('{}')
    expect(send.room).toMatch(/^auth-user:/)
  }
  return { result, rooms: made.map((send) => send.room) }
}

async function assigneesOf(taskId: string): Promise<string[]> {
  const result = await poolManager.get().query<{ user_id: string }>(
    'SELECT user_id FROM task_assignees WHERE task_id = $1 ORDER BY user_id',
    [taskId],
  )
  return result.rows.map((row) => row.user_id)
}

async function eventTypesOf(taskId: string): Promise<string[]> {
  const result = await poolManager.get().query<{ event_type: string }>(
    'SELECT event_type FROM task_events WHERE task_id = $1 ORDER BY occurred_at, id',
    [taskId],
  )
  return result.rows.map((row) => row.event_type)
}

/**
 * Makes the COMMIT of any transaction that inserts a matching `task_events` row fail: an AFTER
 * INSERT constraint trigger, DEFERRABLE INITIALLY DEFERRED, whose WHEN names this cell's own rows
 * only (`column = 'value'` pairs, the values checked to be plain ids). The write's statements all
 * succeed; the exception is raised when COMMIT runs the deferred trigger.
 */
async function failAtCommitWhere(match: Record<string, string>, name: string): Promise<{ drop: () => Promise<void> }> {
  const pairs = Object.entries(match)
  if (pairs.length === 0 || !/^[a-z0-9_]+$/.test(name)) throw new Error('failAtCommitWhere: bad trigger')
  for (const [column, value] of pairs) {
    if (!/^[a-z_]+$/.test(column) || !/^[A-Za-z0-9_]+$/.test(value)) throw new Error('failAtCommitWhere: unexpected id shape')
  }
  const when = pairs.map(([column, value]) => `NEW.${column} = '${value}'`).join(' AND ')
  const db = poolManager.get()
  await db.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced failure at commit'; END $$`)
  await db.query(
    `CREATE CONSTRAINT TRIGGER ${name} AFTER INSERT ON task_events DEFERRABLE INITIALLY DEFERRED
     FOR EACH ROW WHEN (${when}) EXECUTE FUNCTION ${name}()`,
  )
  return {
    drop: async () => {
      await db.query(`DROP TRIGGER IF EXISTS ${name} ON task_events`)
      await db.query(`DROP FUNCTION IF EXISTS ${name}()`)
    },
  }
}

/** `failAtCommitWhere` for the `task_events` rows of one task. */
function failAtCommit(taskId: string, stamp: string): Promise<{ drop: () => Promise<void> }> {
  if (!/^[a-f0-9]+$/.test(stamp)) throw new Error('failAtCommit: unexpected stamp')
  return failAtCommitWhere({ task_id: taskId }, `${FAIL_PREFIX}${stamp}`)
}

/** Drops any failure trigger or function of this file still in the database. */
async function sweepFailTriggers(): Promise<void> {
  const db = poolManager.get()
  const triggers = await db.query<{ tgname: string }>(
    `SELECT tgname FROM pg_trigger WHERE tgrelid = 'task_events'::regclass AND left(tgname, length($1)) = $1`,
    [FAIL_PREFIX],
  )
  for (const row of triggers.rows) await db.query(`DROP TRIGGER IF EXISTS ${row.tgname} ON task_events`)
  const functions = await db.query<{ proname: string }>(
    `SELECT proname FROM pg_proc WHERE left(proname, length($1)) = $1`,
    [FAIL_PREFIX],
  )
  for (const row of functions.rows) await db.query(`DROP FUNCTION IF EXISTS ${row.proname}()`)
}

// ---------------------------------------------------------------------------------------------
// Gate 26 positive control and rollback (design §7.2; the R01 lock amendment marks both as the
// drafter's design, not ruling text).
// ---------------------------------------------------------------------------------------------

describe('gate 26: positive control and rollback', () => {
  it('gate26|positive control: C removes A, then adds B, in two committed writes; the first goes to {A}, the second to {B}; the follower F and C get nothing', async () => {
    const stamp = stampOf()
    const orgId = orgOf('pc', stamp)
    const c = await actor('c', stamp, orgId)
    const a = await member('a', stamp, orgId)
    const b = await member('b', stamp, orgId)
    const f = await member('f', stamp, orgId)
    const taskId = await taskWith({ orgId, creator: c.userId, assignees: [a], followers: [f], mode: 'all' })
    expect(await assigneesOf(taskId)).toEqual([a])

    const first = await sendsOf(() => http('DELETE', `/api/tasks/${taskId}/assignees/${a}`, c.bearer))
    expect(first.result.status).toBe(200)
    expect(first.rooms).toEqual(roomsOf(a))
    expect(await assigneesOf(taskId)).toEqual([])
    const status = await poolManager.get().query<{ status: string }>('SELECT status FROM tasks WHERE id = $1', [taskId])
    expect(status.rows[0].status).toBe('open')

    const second = await sendsOf(() => http('POST', `/api/tasks/${taskId}/assignees`, c.bearer, { userId: b }))
    expect(second.result.status).toBe(200)
    expect(second.rooms).toEqual(roomsOf(b))

    const all = [...first.rooms, ...second.rooms]
    expect(all.filter((room) => room === buildAuthenticatedUserRoom(a))).toHaveLength(1)
    expect(all.filter((room) => room === buildAuthenticatedUserRoom(b))).toHaveLength(1)
    expect(all).not.toContain(buildAuthenticatedUserRoom(f))
    expect(all).not.toContain(buildAuthenticatedUserRoom(c.userId))
  })

  it('gate26|rollback: the same removal made to fail at COMMIT answers 500, sends nothing and leaves A assigned; without the trigger it commits and sends to {A}', async () => {
    const stamp = stampOf()
    const orgId = orgOf('rb', stamp)
    const c = await actor('c', stamp, orgId)
    const a = await member('a', stamp, orgId)
    const f = await member('f', stamp, orgId)
    const taskId = await taskWith({ orgId, creator: c.userId, assignees: [a], followers: [f], mode: 'all' })
    const eventsBefore = await eventTypesOf(taskId)

    const failure = await failAtCommit(taskId, stamp)
    try {
      const failed = await sendsOf(() => http('DELETE', `/api/tasks/${taskId}/assignees/${a}`, c.bearer))
      expect(failed.result.status).toBe(500)
      expect(failed.result.text).toBe(INTERNAL_TEXT)
      expect(failed.rooms).toEqual([])
      expect(await assigneesOf(taskId)).toEqual([a])
      expect(await eventTypesOf(taskId)).toEqual(eventsBefore)
    } finally {
      await failure.drop()
    }

    const committed = await sendsOf(() => http('DELETE', `/api/tasks/${taskId}/assignees/${a}`, c.bearer))
    expect(committed.result.status).toBe(200)
    expect(committed.rooms).toEqual(roomsOf(a))
    expect(await assigneesOf(taskId)).toEqual([])
  })

  it('gate26|rollback on every kind of write: complete, reopen, mode switch, PATCH of the due date, add, remove, delete and create, each failing at COMMIT, send nothing and change nothing', async () => {
    const stamp = stampOf()
    const orgId = orgOf('rbx', stamp)
    const c = await actor('c', stamp, orgId)
    const a = await actor('a', stamp, orgId)
    const b = await actor('b', stamp, orgId)
    const d = await member('d', stamp, orgId)
    const taskId = await taskWith({ orgId, creator: c.userId, assignees: [a.userId, b.userId], mode: 'all' })
    await completeTask({ orgId, actorId: a.userId, taskId })
    const snapshot = async () => JSON.stringify((await poolManager.get().query(
      `SELECT t.status, t.completion_mode, t.due_date::text AS due_date, t.time_zone, t.deleted_at IS NULL AS live, t.version,
              (SELECT json_agg(json_build_object('u', user_id, 'done', completed_at IS NOT NULL) ORDER BY user_id) FROM task_assignees WHERE task_id = t.id) AS rows,
              (SELECT count(*) FROM task_events WHERE task_id = t.id) AS events
         FROM tasks t WHERE t.id = $1`,
      [taskId],
    )).rows[0])
    const before = await snapshot()
    const failure = await failAtCommit(taskId, stamp)
    try {
      for (const [method, path, bearer, body] of [
        ['POST', `/api/tasks/${taskId}/complete`, b.bearer, undefined],
        ['POST', `/api/tasks/${taskId}/reopen`, a.bearer, {}],
        ['PATCH', `/api/tasks/${taskId}/completion-mode`, c.bearer, { completionMode: 'any' }],
        ['PATCH', `/api/tasks/${taskId}`, c.bearer, { expectedVersion: 1, dueDate: '2026-10-21', timeZone: 'Asia/Tokyo' }],
        ['POST', `/api/tasks/${taskId}/assignees`, c.bearer, { userId: d }],
        ['DELETE', `/api/tasks/${taskId}/assignees/${a.userId}`, c.bearer, undefined],
        ['DELETE', `/api/tasks/${taskId}`, c.bearer, undefined],
      ] as const) {
        const failed = await sendsOf(() => http(method, path, bearer, body))
        expect(failed.result.status, `${method} ${path}`).toBe(500)
        expect(failed.rooms, `${method} ${path}`).toEqual([])
      }
    } finally {
      await failure.drop()
    }
    expect(await snapshot()).toBe(before)

    // A create has no task id before it runs: its trigger names the creator and the `created` event.
    const tasksOfCreator = async () => (await poolManager.get().query(
      'SELECT count(*)::int AS n FROM tasks WHERE org_id = $1 AND created_by = $2', [orgId, c.userId],
    )).rows[0].n
    expect(await tasksOfCreator()).toBe(1)
    const createFailure = await failAtCommitWhere({ actor_id: c.userId, event_type: 'created' }, `${FAIL_PREFIX}${stamp}_create`)
    try {
      const failed = await sendsOf(() => http('POST', '/api/tasks', c.bearer, { title: '备料复核', assignees: [a.userId, b.userId] }))
      expect(failed.result.status).toBe(500)
      expect(failed.rooms).toEqual([])
    } finally {
      await createFailure.drop()
    }
    expect(await tasksOfCreator()).toBe(1)
  })
})

// ---------------------------------------------------------------------------------------------
// Every touchpoint (design §3), each with a follower who never receives.
// ---------------------------------------------------------------------------------------------

describe('gate 26: touchpoints', () => {
  it('gate26|create: named assignees get one send each (a repeated id once); an omitted list makes the creator the one recipient; an empty list sends nothing', async () => {
    const stamp = stampOf()
    const orgId = orgOf('cr', stamp)
    const c = await actor('c', stamp, orgId)
    const a = await member('a', stamp, orgId)
    const b = await member('b', stamp, orgId)
    const named = await sendsOf(() => http('POST', '/api/tasks', c.bearer, { title: '备料复核', assignees: [a, b, a] }))
    expect(named.result.status).toBe(200)
    expect(named.rooms).toEqual(roomsOf(a, b))
    const omitted = await sendsOf(() => http('POST', '/api/tasks', c.bearer, { title: '备料复核' }))
    expect(omitted.result.status).toBe(200)
    expect(omitted.rooms).toEqual(roomsOf(c.userId))
    const none = await sendsOf(() => http('POST', '/api/tasks', c.bearer, { title: '备料复核', assignees: [] }))
    expect(none.result.status).toBe(200)
    expect(none.rooms).toEqual([])
    const refused = await sendsOf(() => http('POST', '/api/tasks', c.bearer, { title: '备料复核', assignees: [a, `usr_gone_${stamp}`] }))
    expect(refused.result.status).toBe(422)
    expect(refused.rooms).toEqual([])
  })

  it('gate26|complete and reopen: every assignee, never the follower; a repeated complete or reopen sends nothing', async () => {
    const stamp = stampOf()
    const orgId = orgOf('cp', stamp)
    const c = await actor('c', stamp, orgId)
    const a = await actor('a', stamp, orgId)
    const b = await member('b', stamp, orgId)
    const f = await member('f', stamp, orgId)
    const taskId = await taskWith({ orgId, creator: c.userId, assignees: [a.userId, b], followers: [f], mode: 'all' })
    const done = await sendsOf(() => http('POST', `/api/tasks/${taskId}/complete`, a.bearer))
    expect(done.result.status).toBe(200)
    expect(done.rooms).toEqual(roomsOf(a.userId, b))
    const again = await sendsOf(() => http('POST', `/api/tasks/${taskId}/complete`, a.bearer))
    expect(again.result.status).toBe(200)
    expect(again.rooms).toEqual([])
    const reopened = await sendsOf(() => http('POST', `/api/tasks/${taskId}/reopen`, a.bearer, {}))
    expect(reopened.result.status).toBe(200)
    expect(reopened.rooms).toEqual(roomsOf(a.userId, b))
    const reopenedAgain = await sendsOf(() => http('POST', `/api/tasks/${taskId}/reopen`, a.bearer, {}))
    expect(reopenedAgain.result.status).toBe(200)
    expect(reopenedAgain.rooms).toEqual([])
  })

  it('gate26|completion mode: a switch that completes the task and a switch that does not both go to every assignee ([own-3c-02]); the same mode sends nothing', async () => {
    const stamp = stampOf()
    const orgId = orgOf('md', stamp)
    const c = await actor('c', stamp, orgId)
    const a = await member('a', stamp, orgId)
    const b = await member('b', stamp, orgId)
    const f = await member('f', stamp, orgId)
    const taskId = await taskWith({ orgId, creator: c.userId, assignees: [a, b], followers: [f], mode: 'all' })
    await completeTask({ orgId, actorId: a, taskId })
    const toAny = await sendsOf(() => http('PATCH', `/api/tasks/${taskId}/completion-mode`, c.bearer, { completionMode: 'any' }))
    expect(toAny.result.status).toBe(200)
    expect((toAny.result.body as { status: string }).status).toBe('done')
    expect(toAny.rooms).toEqual(roomsOf(a, b))
    const toAll = await sendsOf(() => http('PATCH', `/api/tasks/${taskId}/completion-mode`, c.bearer, { completionMode: 'all' }))
    expect(toAll.result.status).toBe(200)
    expect((toAll.result.body as { status: string }).status).toBe('done')
    expect(toAll.rooms).toEqual(roomsOf(a, b))
    const same = await sendsOf(() => http('PATCH', `/api/tasks/${taskId}/completion-mode`, c.bearer, { completionMode: 'all' }))
    expect(same.result.status).toBe(200)
    expect(same.rooms).toEqual([])
  })

  it('gate26|delete: every assignee, one who already completed included; never the follower', async () => {
    const stamp = stampOf()
    const orgId = orgOf('dl', stamp)
    const c = await actor('c', stamp, orgId)
    const a = await member('a', stamp, orgId)
    const b = await member('b', stamp, orgId)
    const f = await member('f', stamp, orgId)
    const taskId = await taskWith({ orgId, creator: c.userId, assignees: [a, b], followers: [f], mode: 'all' })
    // A completes; the task stays open (`all` mode).
    expect(await completeTask({ orgId, actorId: a, taskId })).toEqual({ done: false, version: 1 })
    const deleted = await sendsOf(() => http('DELETE', `/api/tasks/${taskId}`, c.bearer))
    expect(deleted.result.status).toBe(200)
    expect(deleted.rooms).toEqual(roomsOf(a, b))
    const again = await sendsOf(() => http('DELETE', `/api/tasks/${taskId}`, c.bearer))
    expect(again.result.status).toBe(404)
    expect(again.rooms).toEqual([])
  })

  it('gate26|PATCH: a change of the due date, the due time or the time zone goes to every assignee ([own-3c-03]); title, reminder, start, description, an unchanged body, 409 and 422 send nothing', async () => {
    const stamp = stampOf()
    const orgId = orgOf('pt', stamp)
    const c = await actor('c', stamp, orgId)
    const a = await member('a', stamp, orgId)
    const b = await member('b', stamp, orgId)
    const f = await member('f', stamp, orgId)
    const taskId = await taskWith({ orgId, creator: c.userId, assignees: [a, b], followers: [f] })
    let version = 1
    const patch = async (body: Record<string, unknown>) => {
      const made = await sendsOf(() => http('PATCH', `/api/tasks/${taskId}`, c.bearer, { expectedVersion: version, ...body }))
      if (made.result.status === 200) version = (made.result.body as { version: number }).version
      return made
    }
    const everyone = roomsOf(a, b)
    const zoneWithoutDue = await patch({ timeZone: 'Asia/Tokyo' })
    expect(zoneWithoutDue.result.status).toBe(200)
    expect(zoneWithoutDue.rooms).toEqual(everyone)
    const title = await patch({ title: '复核' })
    expect(title.result.status).toBe(200)
    expect(title.rooms).toEqual([])
    const remind = await patch({ remindAt: '2026-10-20T01:00:00Z' })
    expect(remind.result.status).toBe(200)
    expect(remind.rooms).toEqual([])
    const due = await patch({ dueDate: '2026-10-21', timeZone: 'Asia/Tokyo' })
    expect(due.result.status).toBe(200)
    expect(due.rooms).toEqual(everyone)
    const time = await patch({ dueDate: '2026-10-21', dueTime: '09:30', timeZone: 'Asia/Tokyo' })
    expect(time.result.status).toBe(200)
    expect(time.rooms).toEqual(everyone)
    const zone = await patch({ timeZone: 'Asia/Shanghai' })
    expect(zone.result.status).toBe(200)
    expect(zone.rooms).toEqual(everyone)
    // [own-3c-03] the start and the description are no inputs of the pending predicate: each write
    // commits (the version moves) and sends nothing. A date key needs the zone: the stored one.
    const beforeStart = version
    const start = await patch({ startDate: '2026-10-19', startTime: '08:00', timeZone: 'Asia/Shanghai' })
    expect(start.result.status).toBe(200)
    expect(version).toBe(beforeStart + 1)
    expect(start.rooms).toEqual([])
    const description = await patch({ description: '核对型号与数量' })
    expect(description.result.status).toBe(200)
    expect(version).toBe(beforeStart + 2)
    expect(description.rooms).toEqual([])
    const unchanged = await patch({ title: '复核', dueDate: '2026-10-21', dueTime: '09:30', timeZone: 'Asia/Shanghai' })
    expect(unchanged.result.status).toBe(200)
    expect(unchanged.rooms).toEqual([])
    const stale = await sendsOf(() => http('PATCH', `/api/tasks/${taskId}`, c.bearer, { expectedVersion: version - 1, dueDate: '2026-10-22', timeZone: 'Asia/Tokyo' }))
    expect(stale.result.status).toBe(409)
    expect(stale.rooms).toEqual([])
    const invalid = await patch({ dueDate: '2026-02-30', timeZone: 'Asia/Tokyo' })
    expect(invalid.result.status).toBe(422)
    expect(invalid.rooms).toEqual([])
  })

  it('gate26|operator (delete): the creator deletes their own task, created with the assignees omitted so the creator is its one assignee; the creator is the one recipient ([own-3c-09])', async () => {
    const stamp = stampOf()
    const orgId = orgOf('od', stamp)
    const c = await actor('c', stamp, orgId)
    const f = await member('f', stamp, orgId)
    const created = await http('POST', '/api/tasks', c.bearer, { title: '备料复核' })
    expect(created.status).toBe(200)
    const taskId = (created.body as { id: string }).id
    await poolManager.get().query('INSERT INTO task_followers (task_id, user_id) VALUES ($1, $2)', [taskId, f])
    expect(await assigneesOf(taskId)).toEqual([c.userId])
    const deleted = await sendsOf(() => http('DELETE', `/api/tasks/${taskId}`, c.bearer))
    expect(deleted.result.status).toBe(200)
    expect(deleted.rooms).toEqual(roomsOf(c.userId))
  })

  it('gate26|operator (PATCH): a creator who is also an assignee moves the due date; every assignee receives, the creator and one who already completed included ([own-3c-09])', async () => {
    const stamp = stampOf()
    const orgId = orgOf('op', stamp)
    const c = await actor('c', stamp, orgId)
    const a = await member('a', stamp, orgId)
    const b = await member('b', stamp, orgId)
    const f = await member('f', stamp, orgId)
    const taskId = await taskWith({ orgId, creator: c.userId, assignees: [c.userId, a, b], followers: [f], mode: 'all' })
    // A completes; the task stays open (`all` mode) and its version stays 1.
    expect(await completeTask({ orgId, actorId: a, taskId })).toEqual({ done: false, version: 1 })
    const moved = await sendsOf(() => http('PATCH', `/api/tasks/${taskId}`, c.bearer, { expectedVersion: 1, dueDate: '2026-10-21', timeZone: 'Asia/Tokyo' }))
    expect(moved.result.status).toBe(200)
    expect(moved.rooms).toEqual(roomsOf(a, b, c.userId))
  })

  it('gate26|assignee writes that change nothing or fail send nothing: a re-add, removing a follower who is no assignee, an inactive user, a caller without a direct role, a malformed id', async () => {
    const stamp = stampOf()
    const orgId = orgOf('nf', stamp)
    const c = await actor('c', stamp, orgId)
    const o = await actor('o', stamp, orgId)
    const a = await member('a', stamp, orgId)
    const f = await member('f', stamp, orgId)
    const taskId = await taskWith({ orgId, creator: c.userId, assignees: [a], followers: [f] })
    for (const [method, path, bearer, body, status] of [
      ['POST', `/api/tasks/${taskId}/assignees`, c.bearer, { userId: a }, 200],
      ['DELETE', `/api/tasks/${taskId}/assignees/${f}`, c.bearer, undefined, 200],
      ['POST', `/api/tasks/${taskId}/assignees`, c.bearer, { userId: `usr_gone_${stamp}` }, 422],
      ['DELETE', `/api/tasks/${taskId}/assignees/${a}`, o.bearer, undefined, 404],
      ['POST', `/api/tasks/${taskId}/assignees`, o.bearer, { userId: f }, 404],
      ['POST', `/api/tasks/${taskId}/assignees`, c.bearer, { userId: '..' }, 422],
    ] as const) {
      const made = await sendsOf(() => http(method, path, bearer, body))
      expect(made.result.status, `${method} ${path}`).toBe(status)
      expect(made.rooms, `${method} ${path}`).toEqual([])
    }
    expect(await assigneesOf(taskId)).toEqual([a])
  })

  it('gate26|a task without assignees has no badge anywhere: its create, complete, reopen and delete by the creator send nothing', async () => {
    const stamp = stampOf()
    const orgId = orgOf('za', stamp)
    const c = await actor('c', stamp, orgId)
    const f = await member('f', stamp, orgId)
    const created = await sendsOf(() => http('POST', '/api/tasks', c.bearer, { title: '备料复核', assignees: [] }))
    expect(created.result.status).toBe(200)
    expect(created.rooms).toEqual([])
    const taskId = (created.result.body as { id: string }).id
    await poolManager.get().query('INSERT INTO task_followers (task_id, user_id) VALUES ($1, $2)', [taskId, f])
    for (const [method, path] of [
      ['POST', `/api/tasks/${taskId}/complete`],
      ['POST', `/api/tasks/${taskId}/reopen`],
      ['DELETE', `/api/tasks/${taskId}`],
    ] as const) {
      const made = await sendsOf(() => http(method, path, c.bearer, method === 'POST' ? {} : undefined))
      expect(made.result.status, `${method} ${path}`).toBe(200)
      expect(made.rooms, `${method} ${path}`).toEqual([])
    }
    expect(await eventTypesOf(taskId)).toEqual(['created', 'completed', 'reopened', 'deleted'])
  })
})

// ---------------------------------------------------------------------------------------------
// Payload, failure isolation, rooms and orgs (design §4.1, §4.3, §5).
// ---------------------------------------------------------------------------------------------

describe('gate 26: payload, failure isolation, rooms', () => {
  it('gate26|payload: one send per recipient, on auth-user:<id>, named tasks:counts-updated, carrying exactly {}', async () => {
    const stamp = stampOf()
    const orgId = orgOf('pl', stamp)
    const c = await actor('c', stamp, orgId)
    const a = await actor('a', stamp, orgId)
    const b = await member('b', stamp, orgId)
    const taskId = await taskWith({ orgId, creator: c.userId, assignees: [a.userId, b] })
    const mark = sends.length
    const response = await http('POST', `/api/tasks/${taskId}/complete`, a.bearer)
    expect(response.status).toBe(200)
    const made = sends.slice(mark)
    expect(TASK_COUNTS_UPDATED_EVENT).toBe('tasks:counts-updated')
    expect(made).toEqual([a.userId, b].sort().map((userId) => ({
      room: buildAuthenticatedUserRoom(userId),
      event: 'tasks:counts-updated',
      payload: {},
    })))
    for (const send of made) {
      expect(Object.keys(send.payload as object)).toEqual([])
      expect(JSON.stringify(send.payload)).toBe('{}')
      expect(send.room).toBe(`auth-user:${send.room.slice('auth-user:'.length)}`)
    }
  })

  it('gate26|a send that throws for one recipient does not fail the write: 200, the completion is stored, the other recipient still gets its send', async () => {
    const stamp = stampOf()
    const orgId = orgOf('fi', stamp)
    const c = await actor('c', stamp, orgId)
    const a = await actor('a', stamp, orgId)
    const b = await member('b', stamp, orgId)
    const taskId = await taskWith({ orgId, creator: c.userId, assignees: [a.userId, b], mode: 'all' })
    const failingRoom = buildAuthenticatedUserRoom(a.userId)
    setTaskCountsBroadcaster((room, event, payload) => {
      if (room === failingRoom) throw new Error('socket down')
      record(room, event, payload)
    })
    try {
      const made = await sendsOf(() => http('POST', `/api/tasks/${taskId}/complete`, a.bearer))
      expect(made.result.status).toBe(200)
      expect(made.result.body).toEqual({ done: false, version: 1 })
      expect(made.rooms).toEqual(roomsOf(b))
    } finally {
      setTaskCountsBroadcaster(record)
    }
    const row = await poolManager.get().query<{ done: boolean }>(
      'SELECT completed_at IS NOT NULL AS done FROM task_assignees WHERE task_id = $1 AND user_id = $2',
      [taskId, a.userId],
    )
    expect(row.rows[0].done).toBe(true)
  })

  it('gate26|rooms are per user, not per org: a user active in two orgs gets one send for a write in each, and the payload names no org', async () => {
    const stamp = stampOf()
    const orgA = orgOf('tA', stamp)
    const orgB = orgOf('tB', stamp)
    const u = await actor('u', stamp, orgA)
    await poolManager.get().query('INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)', [u.userId, orgB])
    const inA = await taskWith({ orgId: orgA, creator: `usr_ca_${stamp}`, assignees: [u.userId] })
    const inB = await taskWith({ orgId: orgB, creator: `usr_cb_${stamp}`, assignees: [u.userId] })
    const writeB = await sendsOf(() => completeTask({ orgId: orgB, actorId: u.userId, taskId: inB }))
    expect(writeB.rooms).toEqual(roomsOf(u.userId))
    const writeA = await sendsOf(() => completeTask({ orgId: orgA, actorId: u.userId, taskId: inA }))
    expect(writeA.rooms).toEqual(roomsOf(u.userId))
    // The org of the write is nowhere in what was sent.
    expect(JSON.stringify(sends.slice(-2))).not.toContain(orgA)
    expect(JSON.stringify(sends.slice(-2))).not.toContain(orgB)
  })
})

// ---------------------------------------------------------------------------------------------
// Production wiring (design §4.4): the real MetaSheetServer's constructor binds the send port to its
// websocket API, which calls CollabService.broadcastTo of its injector.
// ---------------------------------------------------------------------------------------------

describe('gate 26: production wiring', () => {
  const WIRING = '    setTaskCountsBroadcaster((room, event, payload) => coreAPI.websocket.broadcastTo(room, event, payload))\n'

  it('gate26|wiring: a write through MetaSheetServer reaches CollabService.broadcastTo of its injector, once per assignee, with the event name and {}', async () => {
    const stamp = stampOf()
    const orgId = orgOf('wr', stamp)
    const c = await actor('c', stamp, orgId)
    const a = await actor('a', stamp, orgId)
    const b = await member('b', stamp, orgId)
    const f = await member('f', stamp, orgId)
    const taskId = await taskWith({ orgId, creator: c.userId, assignees: [a.userId, b], followers: [f] })
    const instance = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [], manageProcessSignals: false })
    const collab = (instance as unknown as { injector: { get: (id: unknown) => { broadcastTo: (room: string, event: string, data: unknown) => void } } })
      .injector.get(ICollabService)
    const original = collab.broadcastTo
    const pushes: Send[] = []
    collab.broadcastTo = (room, event, data) => {
      pushes.push({ room, event, payload: data })
    }
    const mark = sends.length
    try {
      const app = (instance as unknown as { app: express.Express }).app
      const response = await request(app).post(`/api/tasks/${taskId}/complete`).set('Authorization', `Bearer ${a.bearer}`).send({})
      expect(response.status).toBe(200)
      expect(pushes).toEqual([a.userId, b].sort().map((userId) => ({
        room: buildAuthenticatedUserRoom(userId),
        event: 'tasks:counts-updated',
        payload: {},
      })))
      // Through the server's own port, not this file's recorder.
      expect(sends.length).toBe(mark)
    } finally {
      collab.broadcastTo = original
      setTaskCountsBroadcaster(record)
    }
  })

  it('gate26|wiring negative: with the index.ts line commented out, the same write reaches CollabService zero times', async () => {
    const stamp = stampOf()
    const orgId = orgOf('wn', stamp)
    const c = await actor('c', stamp, orgId)
    const a = await member('a', stamp, orgId)
    const b = await member('b', stamp, orgId)
    const taskId = await taskWith({ orgId, creator: c.userId, assignees: [a, b] })
    runSourceMutant(INDEX_FILE, WIRING, `    // ${WIRING.trimStart()}`, `
      process.env.TASKS_ENABLED = 'true'
      const { MetaSheetServer } = await import(${JSON.stringify(INDEX_FILE)})
      const { ICollabService } = await import(${JSON.stringify(IDENTIFIERS_FILE)})
      const { completeTask } = await import(${JSON.stringify(RECORDS_FILE)})
      const instance = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [], manageProcessSignals: false })
      const collab = instance.injector.get(ICollabService)
      const pushes = []
      collab.broadcastTo = (room, event, payload) => { pushes.push({ room, event, payload }) }
      const result = await completeTask({ orgId: process.env.G26_ORG, actorId: process.env.G26_ACTOR, taskId: process.env.G26_TASK })
      const stored = result.done === false && result.version === 1
      console.log(JSON.stringify({ gate26wiring: 'red', pushes: pushes.length, stored }))
      process.exit(pushes.length === 0 && stored ? 0 : 1)
    `, { G26_ORG: orgId, G26_ACTOR: a, G26_TASK: taskId }, { unique: true, timeoutMs: 240000 })
  }, 300000)
})

// ---------------------------------------------------------------------------------------------
// Gate 26 negative controls (design §7.2; the R01 lock amendment marks them as the drafter's
// design). Each rewrites one source line through `runSourceMutant` (needle asserted unique, backup,
// tsx child, byte-identical restore) and runs the positive-control scenario in the child, calling
// the service directly with the send port set to a recorder. The child exits 0 only when the
// mutant shows the failure this file's cells catch.
// ---------------------------------------------------------------------------------------------

describe('gate 26: negative controls', () => {
  const RECIPIENTS = '      for (const userId of countsUpdateRecipients(before, after)) sendOne(userId)\n'

  function childPrelude(): string {
    return `
      const { setTaskCountsBroadcaster } = await import(${JSON.stringify(REALTIME_FILE)})
      const { buildAuthenticatedUserRoom } = await import(${JSON.stringify(COLLAB_FILE)})
      const { addAssignee, removeAssignee } = await import(${JSON.stringify(STRUCTURE_FILE)})
      const sent = []
      setTaskCountsBroadcaster((room) => { sent.push(room) })
      const env = process.env
      const count = (userId) => sent.filter((room) => room === buildAuthenticatedUserRoom(userId)).length
    `
  }

  it('gate26|negative (a): recipients taken from the set after the write only: the removal of A sends to nobody', async () => {
    const stamp = stampOf()
    const orgId = orgOf('ncA', stamp)
    const c = await actor('c', stamp, orgId)
    const a = await member('a', stamp, orgId)
    const f = await member('f', stamp, orgId)
    const taskId = await taskWith({ orgId, creator: c.userId, assignees: [a], followers: [f] })
    runSourceMutant(REALTIME_FILE, RECIPIENTS, RECIPIENTS.replace('(before, after)', '([], after)'), `
      ${childPrelude()}
      const result = await removeAssignee({ orgId: env.G26_ORG, actorId: env.G26_C, taskId: env.G26_TASK, userId: env.G26_A })
      const committed = result.assignees.length === 0
      console.log(JSON.stringify({ gate26nc: 'a', toA: count(env.G26_A), sent: sent.length, committed }))
      process.exit(committed && count(env.G26_A) === 0 ? 0 : 1)
    `, { G26_ORG: orgId, G26_C: c.userId, G26_A: a, G26_TASK: taskId }, { unique: true })
    expect(await assigneesOf(taskId)).toEqual([])
  }, 180000)

  it('gate26|negative (b): recipients taken from the set before the write only: the addition of B sends to nobody', async () => {
    const stamp = stampOf()
    const orgId = orgOf('ncB', stamp)
    const c = await actor('c', stamp, orgId)
    const b = await member('b', stamp, orgId)
    const f = await member('f', stamp, orgId)
    const taskId = await taskWith({ orgId, creator: c.userId, assignees: [], followers: [f] })
    runSourceMutant(REALTIME_FILE, RECIPIENTS, RECIPIENTS.replace('(before, after)', '(before, [])'), `
      ${childPrelude()}
      const result = await addAssignee({ orgId: env.G26_ORG, actorId: env.G26_C, taskId: env.G26_TASK, body: { userId: env.G26_B } })
      const committed = result.assignees.length === 1
      console.log(JSON.stringify({ gate26nc: 'b', toB: count(env.G26_B), sent: sent.length, committed }))
      process.exit(committed && count(env.G26_B) === 0 ? 0 : 1)
    `, { G26_ORG: orgId, G26_C: c.userId, G26_B: b, G26_TASK: taskId }, { unique: true })
    expect(await assigneesOf(taskId)).toEqual([b])
  }, 180000)

  it('gate26|negative (c): a send made inside the transaction (note sends at once): the removal that fails at COMMIT still reached A', async () => {
    const stamp = stampOf()
    const orgId = orgOf('ncC', stamp)
    const c = await actor('c', stamp, orgId)
    const a = await member('a', stamp, orgId)
    const f = await member('f', stamp, orgId)
    const taskId = await taskWith({ orgId, creator: c.userId, assignees: [a], followers: [f] })
    const NOTE = '      noted = true\n'
    const failure = await failAtCommit(taskId, stamp)
    try {
      runSourceMutant(REALTIME_FILE, NOTE, `${NOTE}      for (const userId of countsUpdateRecipients(input.before, input.after)) sendOne(userId)\n`, `
        ${childPrelude()}
        let rejected = false
        try {
          await removeAssignee({ orgId: env.G26_ORG, actorId: env.G26_C, taskId: env.G26_TASK, userId: env.G26_A })
        } catch {
          rejected = true
        }
        console.log(JSON.stringify({ gate26nc: 'c', rejected, toA: count(env.G26_A), sent: sent.length }))
        process.exit(rejected && count(env.G26_A) > 0 ? 0 : 1)
      `, { G26_ORG: orgId, G26_C: c.userId, G26_A: a, G26_TASK: taskId }, { unique: true })
    } finally {
      await failure.drop()
    }
    expect(await assigneesOf(taskId)).toEqual([a])
  }, 180000)

  it('gate26|negative (follower): the removal also notes the followers: F receives', async () => {
    const stamp = stampOf()
    const orgId = orgOf('ncF', stamp)
    const c = await actor('c', stamp, orgId)
    const a = await member('a', stamp, orgId)
    const f = await member('f', stamp, orgId)
    const taskId = await taskWith({ orgId, creator: c.userId, assignees: [a], followers: [f] })
    const REMOVAL = '    // set before it; never the followers.\n'
      + '    if (result.events.length > 0 || result.status !== task.status) {\n'
      + '      counts.note({ before: assigneeIds(rows), after: assigneeIds(result.rows) })\n'
    runSourceMutant(STRUCTURE_FILE, REMOVAL, REMOVAL.replace(
      'before: assigneeIds(rows),',
      'before: [...assigneeIds(rows), ...(await loadFollowerIds(db, input.taskId))],',
    ), `
      ${childPrelude()}
      const result = await removeAssignee({ orgId: env.G26_ORG, actorId: env.G26_C, taskId: env.G26_TASK, userId: env.G26_A })
      const committed = result.assignees.length === 0
      console.log(JSON.stringify({ gate26nc: 'follower', toF: count(env.G26_F), toA: count(env.G26_A), committed }))
      process.exit(committed && count(env.G26_F) > 0 ? 0 : 1)
    `, { G26_ORG: orgId, G26_C: c.userId, G26_A: a, G26_F: f, G26_TASK: taskId }, { unique: true })
    expect(await assigneesOf(taskId)).toEqual([])
  }, 180000)
})
