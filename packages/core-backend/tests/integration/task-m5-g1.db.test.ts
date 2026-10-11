import '../helpers/assert-rbac-optional-off'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import type supertest from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { poolManager } from '../../src/integration/db/connection-pool'
import { buildAuthenticatedUserRoom } from '../../src/services/CollabService'
import {
  resetTaskCountsBroadcasterForTests,
  setTaskCountsBroadcaster,
  TASK_COUNTS_UPDATED_EVENT,
} from '../../src/services/task-counts-realtime'
import { newTaskListId } from '../../src/services/task-ids-runtime'
import { completeTask, createTask } from '../../src/services/task-records'
import { addAssignee, switchCompletionMode } from '../../src/services/task-structure'
import { dropTaskM4Fixtures, seedOrgDingTalkIntegration, seedTaskActor, type SeededTaskActor } from '../helpers/task-m4-fixtures'
import { startTasksListener, tasksClient, type TasksClient, type TasksListener } from '../helpers/tasks-http-harness'

/**
 * M5 PR-4a slice 1, G1: the creator completes a task for every assignee (design
 * task-m5-pr4a-backend-design-20261010.md §3.1, §5; the cells of its §5 table, named g1-…).
 * RULED(2026-10-09): six items, item 3: creator only, decided on `tasks.created_by` alone; completing
 * a task that is already done again is a no-op that records no second event. ASSUMPTION(task-m5a):
 * [a-01]–[a-05], [a-37]. Candidate cells: the gate 3 subset row of [a-24] scores only once a lock
 * revision writes it into arm-set (design §6.2, §7.3).
 *
 * HTTP goes through `tasksRouter()` on one listener per file (tests/helpers/tasks-http-harness.ts;
 * setup.integration.ts, RBAC_TOKEN_TRUST='true'). Tasks are created through the service; followers,
 * the list holding a task, seeded completion instants and the done state of g1-repeat-null-row are
 * written with SQL. g1-concurrent calls the service on two pool connections while a third holds a
 * lock that blocks writes and not reads (design §6.2, opening paragraph).
 *
 * Instants are compared as whole microseconds since the epoch (`extract(epoch …)`), never as text
 * rendered in the session time zone.
 */

if (process.env.EXPECT_DB !== '1') {
  throw new Error('task-m5-g1.db.test.ts requires EXPECT_DB=1')
}

const JWT_SECRET = process.env.JWT_SECRET
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error('task-m5-g1.db.test.ts requires JWT_SECRET')
}

const ORG_PREFIX = 'org_tasks_m5g1_'
const seededUsers: string[] = []
const seededRoles: string[] = []

/** A completion instant written by the fixtures, with microseconds no JS `Date` can carry. */
const T0 = '2026-10-01T08:00:00.123456Z'
const T0_US = '1790841600123456'

let listener: TasksListener | undefined

beforeAll(async () => {
  listener = await startTasksListener()
})

afterAll(async () => {
  resetTaskCountsBroadcasterForTests()
  await dropTaskM4Fixtures({ orgPrefix: ORG_PREFIX, userIds: seededUsers, roleIds: seededRoles })
  await listener?.close()
})

/** The file's one listener: `Connection: close`, no keep-alive. */
function app(): TasksClient {
  return tasksClient(listener?.baseUrl ?? '')
}

function stampOf(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12)
}

async function actor(label: string, stamp: string, orgId: string): Promise<SeededTaskActor> {
  const seeded = await seedTaskActor({ label, stamp, orgId, codes: ['tasks:read', 'tasks:write'], admission: true })
  seededUsers.push(seeded.userId)
  seededRoles.push(seeded.roleId)
  return seeded
}

/** One org per cell: the creator C, assignees-to-be A and B, a follower F, a list editor LE, a list
 * reader LR and an outsider O (active in the org, nothing to do with the task). */
interface World {
  orgId: string
  stamp: string
  c: SeededTaskActor
  a: SeededTaskActor
  b: SeededTaskActor
  f: SeededTaskActor
  le: SeededTaskActor
  lr: SeededTaskActor
  o: SeededTaskActor
}

async function world(label: string): Promise<World> {
  const stamp = stampOf()
  const orgId = `${ORG_PREFIX}${label}_${stamp}`
  return {
    orgId,
    stamp,
    c: await actor('c', stamp, orgId),
    a: await actor('a', stamp, orgId),
    b: await actor('b', stamp, orgId),
    f: await actor('f', stamp, orgId),
    le: await actor('le', stamp, orgId),
    lr: await actor('lr', stamp, orgId),
    o: await actor('o', stamp, orgId),
  }
}

/**
 * A task created by C (`assignees` undefined: the create's default, C alone), with F as follower and
 * one list holding it: C its owner, LE an editor, LR a reader.
 */
async function taskOf(w: World, opts: { mode: 'all' | 'any'; assignees?: SeededTaskActor[] }): Promise<string> {
  const { id } = await createTask({
    orgId: w.orgId,
    creatorId: w.c.userId,
    title: '备料复核',
    assignees: opts.assignees?.map((who) => who.userId),
    completionMode: opts.mode,
  })
  const db = poolManager.get()
  await db.query('INSERT INTO task_followers (task_id, user_id) VALUES ($1, $2)', [id, w.f.userId])
  const listId = newTaskListId()
  await db.query('INSERT INTO task_lists (id, org_id, name, created_by) VALUES ($1, $2, $3, $4)', [listId, w.orgId, '备料复核', w.c.userId])
  await db.query(
    `INSERT INTO task_list_members (list_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'edit'), ($1, $4, 'read')`,
    [listId, w.c.userId, w.le.userId, w.lr.userId],
  )
  await db.query('INSERT INTO task_list_items (list_id, task_id, org_id) VALUES ($1, $2, $3)', [listId, id, w.orgId])
  return id
}

/** `POST /api/tasks/:id/complete` as `who`; no body when `body` is undefined. */
function complete(who: SeededTaskActor, taskId: string, body?: unknown): supertest.Test {
  const call = app().post(`/api/tasks/${taskId}/complete`).set('Authorization', `Bearer ${who.bearer}`)
  return body === undefined ? call : call.send(body as object)
}

/** The missing-id answer to the same caller and body, for byte comparisons. */
async function missingAnswer(w: World, who: SeededTaskActor, body?: unknown): Promise<supertest.Response> {
  return complete(who, `tsk_missing_${w.stamp}`, body)
}

interface TaskState { status: string; version: number; completedUs: string | null }

async function taskState(taskId: string): Promise<TaskState> {
  const result = await poolManager.get().query<{ status: string; version: number; completed_us: string | null }>(
    `SELECT status, version, (extract(epoch FROM completed_at) * 1000000)::bigint::text AS completed_us FROM tasks WHERE id = $1`,
    [taskId],
  )
  const row = result.rows[0]
  if (!row) throw new Error(`task ${taskId} missing`)
  return { status: row.status, version: Number(row.version), completedUs: row.completed_us }
}

/** Assignee user id → completion instant in microseconds, or null. */
async function rowInstants(taskId: string): Promise<Record<string, string | null>> {
  const result = await poolManager.get().query<{ user_id: string; completed_us: string | null }>(
    `SELECT user_id, (extract(epoch FROM completed_at) * 1000000)::bigint::text AS completed_us
       FROM task_assignees WHERE task_id = $1 ORDER BY user_id COLLATE "C"`,
    [taskId],
  )
  return Object.fromEntries(result.rows.map((row) => [row.user_id, row.completed_us]))
}

interface EventRow { type: string; actor: string; payload: unknown; atUs: string }

/** Events in time order; events of one write share an instant, so those are ordered by type (a
 * random event id would order the same history differently on two twin tasks). */
async function eventsOf(taskId: string): Promise<EventRow[]> {
  const result = await poolManager.get().query<{ event_type: string; actor_id: string; payload: unknown; at_us: string }>(
    `SELECT event_type, actor_id, payload, (extract(epoch FROM occurred_at) * 1000000)::bigint::text AS at_us
       FROM task_events WHERE task_id = $1 ORDER BY occurred_at, event_type COLLATE "C", id COLLATE "C"`,
    [taskId],
  )
  return result.rows.map((row) => ({ type: row.event_type, actor: row.actor_id, payload: row.payload, atUs: row.at_us }))
}

/** Task row, assignee rows and event rows as one string, for "nothing was written". */
async function snapshot(taskId: string): Promise<string> {
  const db = poolManager.get()
  const task = await db.query('SELECT status, version, completed_at, updated_at, completion_mode FROM tasks WHERE id = $1', [taskId])
  const rows = await db.query('SELECT user_id, completed_at FROM task_assignees WHERE task_id = $1 ORDER BY user_id COLLATE "C"', [taskId])
  const events = await db.query('SELECT id, event_type, actor_id, payload, occurred_at FROM task_events WHERE task_id = $1 ORDER BY id COLLATE "C"', [taskId])
  return JSON.stringify({ task: task.rows, rows: rows.rows, events: events.rows })
}

async function seedCompletedRow(taskId: string, userId: string): Promise<void> {
  await poolManager.get().query(
    'UPDATE task_assignees SET completed_at = $3::timestamptz WHERE task_id = $1 AND user_id = $2',
    [taskId, userId, T0],
  )
}

/** Waits until `min` backends of this database, other than `exceptPid`, wait on a lock. */
async function waitForLockWaiters(min: number, exceptPid: number): Promise<void> {
  const deadline = Date.now() + 10000
  for (;;) {
    const result = await poolManager.get().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> $1`,
      [exceptPid],
    )
    if (result.rows[0].n >= min) return
    if (Date.now() > deadline) throw new Error(`expected ${min} backends waiting on a lock`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

describe('M5 PR-4a slice 1, G1: the creator completes a task for every assignee', () => {
  it('g1-creator-all | all mode, two open assignees, the creator not one of them: 200 { done: true, version: v+1 }; both rows, the task and the one completed share one instant; the completed is the creator\'s with payload { scope: all }', async () => {
    const w = await world('all')
    const taskId = await taskOf(w, { mode: 'all', assignees: [w.a, w.b] })
    const before = await taskState(taskId)
    expect(before).toEqual({ status: 'open', version: 1, completedUs: null })
    const res = await complete(w.c, taskId, { scope: 'all' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ done: true, version: before.version + 1 })
    const rows = await rowInstants(taskId)
    expect(Object.keys(rows).sort()).toEqual([w.a.userId, w.b.userId].sort())
    const stamp = rows[w.a.userId]
    expect(stamp).not.toBeNull()
    expect(rows[w.b.userId]).toBe(stamp)
    expect(await taskState(taskId)).toEqual({ status: 'done', version: 2, completedUs: stamp })
    const events = await eventsOf(taskId)
    expect(events.map((event) => [event.type, event.actor])).toEqual([['created', w.c.userId], ['completed', w.c.userId]])
    expect(events[1].payload).toEqual({ scope: 'all' })
    expect(events[1].atUs).toBe(stamp)
  })

  it('g1-keep-first | one assignee completed at t0: after the call that row is still t0, the other row has the new instant, the instant of the task and of the completed', async () => {
    const w = await world('keep')
    const taskId = await taskOf(w, { mode: 'all', assignees: [w.a, w.b] })
    await seedCompletedRow(taskId, w.a.userId)
    const res = await complete(w.c, taskId, { scope: 'all' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ done: true, version: 2 })
    const rows = await rowInstants(taskId)
    expect(rows[w.a.userId]).toBe(T0_US)
    const fresh = rows[w.b.userId]
    expect(fresh).not.toBeNull()
    expect(BigInt(fresh as string) > BigInt(T0_US)).toBe(true)
    expect((await taskState(taskId)).completedUs).toBe(fresh)
    const completed = (await eventsOf(taskId)).filter((event) => event.type === 'completed')
    expect(completed).toEqual([{ type: 'completed', actor: w.c.userId, payload: { scope: 'all' }, atUs: fresh }])
  })

  it('g1-repeat | the same call again: 200 with the version unchanged; rows, task and events unchanged; still exactly one completed', async () => {
    const w = await world('repeat')
    const taskId = await taskOf(w, { mode: 'all', assignees: [w.a, w.b] })
    const first = await complete(w.c, taskId, { scope: 'all' })
    expect([first.status, first.body]).toEqual([200, { done: true, version: 2 }])
    const after = await snapshot(taskId)
    const again = await complete(w.c, taskId, { scope: 'all' })
    expect([again.status, again.body]).toEqual([200, { done: true, version: 2 }])
    expect(await snapshot(taskId)).toBe(after)
    expect((await eventsOf(taskId)).filter((event) => event.type === 'completed')).toHaveLength(1)
  })

  it('g1-repeat-null-row | a done all-mode task seeded with SQL that still holds an open row (task-c A6 shape): 200 no-op, the row stays null, version unchanged, no event', async () => {
    const w = await world('nullrow')
    const taskId = await taskOf(w, { mode: 'all', assignees: [w.a, w.b] })
    await seedCompletedRow(taskId, w.a.userId)
    await poolManager.get().query(
      `UPDATE tasks SET status = 'done', completed_at = $2::timestamptz, version = 4 WHERE id = $1`,
      [taskId, T0],
    )
    expect(await rowInstants(taskId)).toEqual({ [w.a.userId]: T0_US, [w.b.userId]: null })
    const before = await snapshot(taskId)
    const res = await complete(w.c, taskId, { scope: 'all' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ done: true, version: 4 })
    expect(await snapshot(taskId)).toBe(before)
    expect((await rowInstants(taskId))[w.b.userId]).toBeNull()
  })

  it('g1-concurrent | two connections call scope all at once, both queued by a third holding SHARE on task_assignees: both 200, exactly one completed, one flip', async () => {
    const w = await world('conc')
    const taskId = await taskOf(w, { mode: 'all', assignees: [w.a, w.b] })
    const holder = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await holder.connect()
    let open = false
    let results: unknown[] = []
    try {
      await holder.query('BEGIN')
      open = true
      // Blocks every write of task_assignees, not its reads (design §6.2).
      await holder.query('LOCK TABLE task_assignees IN SHARE MODE')
      const holderPid = Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      let settled = 0
      const calls = [0, 1].map(() => completeTask({ orgId: w.orgId, actorId: w.c.userId, taskId, scope: 'all' })
        .finally(() => { settled += 1 }))
      for (const call of calls) call.catch(() => undefined)
      // With the structure lock one call waits on the table lock and the other on the structure
      // lock; without it both have read the open task and wait on the table lock.
      await waitForLockWaiters(2, holderPid)
      expect(settled).toBe(0)
      await holder.query('COMMIT')
      open = false
      results = await Promise.all(calls)
    } finally {
      if (open) await holder.query('ROLLBACK').catch(() => undefined)
      await holder.end()
    }
    expect(results).toEqual([{ done: true, version: 2 }, { done: true, version: 2 }])
    const completed = (await eventsOf(taskId)).filter((event) => event.type === 'completed')
    expect(completed).toHaveLength(1)
    const rows = await rowInstants(taskId)
    expect(rows[w.a.userId]).toBe(completed[0].atUs)
    expect(rows[w.b.userId]).toBe(completed[0].atUs)
    expect(await taskState(taskId)).toEqual({ status: 'done', version: 2, completedUs: completed[0].atUs })
  })

  it('g1-assignee | an assignee who is not the creator: 404 byte-identical to a missing task, nothing written; the same assignee\'s own complete is 200', async () => {
    const w = await world('asg')
    const taskId = await taskOf(w, { mode: 'all', assignees: [w.a, w.b] })
    const before = await snapshot(taskId)
    const res = await complete(w.a, taskId, { scope: 'all' })
    const absent = await missingAnswer(w, w.a, { scope: 'all' })
    expect(res.status).toBe(404)
    expect(res.text).toBe(absent.text)
    expect(await snapshot(taskId)).toBe(before)
    // Control: the assignee may complete; only completing for everyone is the creator's.
    const own = await complete(w.a, taskId)
    expect([own.status, own.body]).toEqual([200, { done: false, version: 1 }])
    expect((await rowInstants(taskId))[w.a.userId]).not.toBeNull()
  })

  it('g1-list-editor | a member who edits the task only through a list: 404 byte-identical, nothing written; the same member\'s own complete passes the ability check', async () => {
    const w = await world('le')
    const taskId = await taskOf(w, { mode: 'all', assignees: [w.a, w.b] })
    const before = await snapshot(taskId)
    const res = await complete(w.le, taskId, { scope: 'all' })
    const absent = await missingAnswer(w, w.le, { scope: 'all' })
    expect(res.status).toBe(404)
    expect(res.text).toBe(absent.text)
    expect(await snapshot(taskId)).toBe(before)
    // Control: list identity grants `complete` (no row of theirs: 200, nothing changes).
    const own = await complete(w.le, taskId)
    expect([own.status, own.body]).toEqual([200, { done: false, version: 1 }])
    expect(await snapshot(taskId)).toBe(before)
  })

  it('g1-follower / g1-outsider | a follower, an outsider and a list reader: 404 byte-identical, nothing written', async () => {
    const w = await world('fo')
    const taskId = await taskOf(w, { mode: 'all', assignees: [w.a, w.b] })
    const before = await snapshot(taskId)
    for (const who of [w.f, w.o, w.lr]) {
      const res = await complete(who, taskId, { scope: 'all' })
      const absent = await missingAnswer(w, who, { scope: 'all' })
      expect(res.status, who.userId).toBe(404)
      expect(res.text, who.userId).toBe(absent.text)
    }
    expect(await snapshot(taskId)).toBe(before)
  })

  it('g1-bad-scope | the creator with a present scope other than self or all: 422 INVALID_SCOPE, nothing written; callers who cannot complete the task get the missing-task 404 with the same body', async () => {
    const w = await world('bad')
    const taskId = await taskOf(w, { mode: 'all', assignees: [w.a, w.b] })
    const before = await snapshot(taskId)
    for (const scope of ['x', null, 1, 'ALL', ['all']]) {
      const res = await complete(w.c, taskId, { scope })
      expect(res.status, JSON.stringify(scope)).toBe(422)
      expect(res.body, JSON.stringify(scope)).toEqual({ error: { code: 'INVALID_SCOPE' } })
    }
    for (const who of [w.o, w.f]) {
      const res = await complete(who, taskId, { scope: 'x' })
      const absent = await missingAnswer(w, who, { scope: 'x' })
      expect(res.status, who.userId).toBe(404)
      expect(res.text, who.userId).toBe(absent.text)
    }
    expect(await snapshot(taskId)).toBe(before)
  })

  it('g1-detail | canCompleteForAll is true for the creator of an open all-mode task with an assignee, and false for every other caller and state', async () => {
    const w = await world('detail')
    const flag = async (who: SeededTaskActor, taskId: string): Promise<unknown> => {
      const res = await app().get(`/api/tasks/${taskId}`).set('Authorization', `Bearer ${who.bearer}`)
      expect(res.status, who.userId).toBe(200)
      return res.body.canCompleteForAll
    }
    const open = await taskOf(w, { mode: 'all', assignees: [w.a, w.b] })
    expect(await flag(w.c, open)).toBe(true)
    for (const who of [w.a, w.b, w.f, w.le, w.lr]) expect(await flag(who, open), who.userId).toBe(false)
    const creatorAssigned = await taskOf(w, { mode: 'all', assignees: [w.c, w.a] })
    expect(await flag(w.c, creatorAssigned)).toBe(true)
    const anyMode = await taskOf(w, { mode: 'any', assignees: [w.a, w.b] })
    expect(await flag(w.c, anyMode)).toBe(false)
    const zero = await taskOf(w, { mode: 'all', assignees: [] })
    expect(await flag(w.c, zero)).toBe(false)
    const finished = await taskOf(w, { mode: 'all', assignees: [w.a, w.b] })
    expect((await complete(w.c, finished, { scope: 'all' })).status).toBe(200)
    expect(await flag(w.c, finished)).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------
// g1-self-unchanged, g1-any / g1-zero: a twin task per shape, the same steps on both, the complete
// calls of one twin with no body and of the other with the scope under test; the two outcomes must
// be equal, and each shape's anchor (final status, response codes) holds.
// ---------------------------------------------------------------------------------------------

type Step =
  | { complete: (w: World) => SeededTaskActor }
  | { add: (w: World) => SeededTaskActor }
  | { mode: 'all' | 'any' }

interface Shape {
  label: string
  mode: 'all' | 'any'
  assignees: (w: World) => SeededTaskActor[] | undefined
  steps: Step[]
  /** Final task status, the anchor that keeps two equal outcomes from both being wrong. */
  finalStatus: 'open' | 'done'
}

interface Outcome {
  responses: Array<[number, unknown]>
  task: [string, number, boolean]
  rows: Array<[string, boolean]>
  events: Array<[string, string, unknown]>
}

async function runShape(w: World, shape: Shape, body: unknown): Promise<Outcome> {
  const taskId = await taskOf(w, { mode: shape.mode, assignees: shape.assignees(w) })
  const responses: Array<[number, unknown]> = []
  for (const step of shape.steps) {
    if ('complete' in step) {
      const res = await complete(step.complete(w), taskId, body)
      responses.push([res.status, res.body])
    } else if ('add' in step) {
      await addAssignee({ orgId: w.orgId, actorId: w.c.userId, taskId, body: { userId: step.add(w).userId } })
    } else {
      await switchCompletionMode({ orgId: w.orgId, actorId: w.c.userId, taskId, body: { completionMode: step.mode } })
    }
  }
  const task = await taskState(taskId)
  const rows = await rowInstants(taskId)
  const events = await eventsOf(taskId)
  return {
    responses,
    task: [task.status, task.version, task.completedUs !== null],
    rows: Object.entries(rows).map(([userId, at]) => [userId, at !== null]),
    events: events.map((event) => [event.type, event.actor, event.payload]),
  }
}

const SELF_SHAPES: Shape[] = [
  { label: 'M2|3 all x 0', mode: 'all', assignees: () => [], steps: [{ complete: (w) => w.c }], finalStatus: 'done' },
  { label: 'M2|3 any x 0', mode: 'any', assignees: () => [], steps: [{ complete: (w) => w.c }], finalStatus: 'done' },
  { label: 'M2|3 all x 1', mode: 'all', assignees: () => undefined, steps: [{ complete: (w) => w.c }], finalStatus: 'done' },
  { label: 'M2|3 any x 1', mode: 'any', assignees: () => undefined, steps: [{ complete: (w) => w.c }], finalStatus: 'done' },
  { label: 'M2|3 all x n', mode: 'all', assignees: (w) => [w.a, w.b], steps: [{ complete: (w) => w.a }, { complete: (w) => w.b }], finalStatus: 'done' },
  { label: 'M2|3 any x n', mode: 'any', assignees: (w) => [w.a, w.b], steps: [{ complete: (w) => w.a }], finalStatus: 'done' },
  { label: 'all x n, the creator has no row', mode: 'all', assignees: (w) => [w.a, w.b], steps: [{ complete: (w) => w.c }], finalStatus: 'open' },
  {
    label: 'M3|3 all: an assignee added to the done task reopens it, then completes',
    mode: 'all',
    assignees: (w) => [w.a],
    steps: [{ complete: (w) => w.a }, { add: (w) => w.b }, { complete: (w) => w.b }],
    finalStatus: 'done',
  },
  {
    label: 'M3|3 any: an assignee added to the done task (A1) completes: a no-op',
    mode: 'any',
    assignees: (w) => [w.a],
    steps: [{ complete: (w) => w.a }, { add: (w) => w.b }, { complete: (w) => w.b }],
    finalStatus: 'done',
  },
  {
    label: 'M3|3 A6: any done, an assignee added, switched to all, that assignee completes: a no-op',
    mode: 'any',
    assignees: (w) => [w.a],
    steps: [{ complete: (w) => w.a }, { add: (w) => w.b }, { mode: 'all' }, { complete: (w) => w.b }],
    finalStatus: 'done',
  },
]

const ALL_SAME_AS_DEFAULT_SHAPES: Shape[] = [
  { label: 'g1-any: any mode, the creator not an assignee', mode: 'any', assignees: (w) => [w.a, w.b], steps: [{ complete: (w) => w.c }], finalStatus: 'done' },
  { label: 'g1-any: any mode, the creator among the assignees', mode: 'any', assignees: (w) => [w.c, w.a], steps: [{ complete: (w) => w.c }], finalStatus: 'done' },
  { label: 'g1-any: any mode, already done, the creator completes again', mode: 'any', assignees: (w) => [w.a, w.b], steps: [{ complete: (w) => w.c }, { complete: (w) => w.c }], finalStatus: 'done' },
  { label: 'g1-zero: all mode, no assignee', mode: 'all', assignees: () => [], steps: [{ complete: (w) => w.c }], finalStatus: 'done' },
  { label: 'g1-zero: any mode, no assignee', mode: 'any', assignees: () => [], steps: [{ complete: (w) => w.c }], finalStatus: 'done' },
]

const COMPLETION_EVENTS = ['self_completed', 'completed', 'completed_by_any', 'reopened']

/** The shape's final status, every complete answered 200, and every completion event of the
 * default complete written with the payload `{}`. */
function anchors(shape: Shape, outcome: Outcome): void {
  expect(outcome.task[0], shape.label).toBe(shape.finalStatus)
  for (const [status] of outcome.responses) expect(status, shape.label).toBe(200)
  for (const [type, , payload] of outcome.events) {
    if (COMPLETION_EVENTS.includes(type)) expect(payload, `${shape.label} ${type}`).toEqual({})
  }
}

describe('M5 PR-4a slice 1, G1: the default complete is unchanged', () => {
  it('g1-self-unchanged | no body and scope self give the same responses, rows, task and events, shape by shape (the M2|3 grid, the creator without a row, and three M3|3 shapes)', async () => {
    const w = await world('self')
    for (const shape of SELF_SHAPES) {
      const plain = await runShape(w, shape, undefined)
      const self = await runShape(w, shape, { scope: 'self' })
      anchors(shape, plain)
      expect(self, shape.label).toEqual(plain)
    }
  })

  it('g1-any / g1-zero | the creator\'s scope all in any mode and on a task without assignees gives what the default complete gives, payload {} included', async () => {
    const w = await world('anyzero')
    for (const shape of ALL_SAME_AS_DEFAULT_SHAPES) {
      const plain = await runShape(w, shape, undefined)
      const all = await runShape(w, shape, { scope: 'all' })
      anchors(shape, plain)
      expect(all, shape.label).toEqual(plain)
      const done = plain.events.filter(([type]) => type === 'completed' || type === 'completed_by_any')
      expect(done, shape.label).toHaveLength(1)
      expect(done[0][1], shape.label).toBe(w.c.userId)
      expect(done[0][2], shape.label).toEqual({})
    }
  })
})

// ---------------------------------------------------------------------------------------------
// Beyond the §5 table: G1 is a write of `completeTask`, so the PR-3b producer and the PR-3c counts
// signal (gates 24 and 26) see it as they see every complete (design §1.3, the slice 1 regression
// rows; §3.1 events row).
// ---------------------------------------------------------------------------------------------

describe('M5 PR-4a slice 1, G1 with the notification producer and the counts signal', () => {
  const SWITCHES = [
    'TASKS_SCHEDULER_ENABLED',
    'TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED',
    'TASKS_NOTIFICATION_DINGTALK_WORK_NOTIFICATION_ENABLED',
  ] as const

  it('g1-signals | the completed is queued for every member but the creator, once; each assignee gets one counts signal after commit; the repeat queues and signals nothing', async () => {
    const w = await world('sig')
    await seedOrgDingTalkIntegration(w.orgId)
    const taskId = await taskOf(w, { mode: 'all', assignees: [w.a, w.b] })
    const saved = Object.fromEntries(SWITCHES.map((key) => [key, process.env[key]]))
    const sends: Array<{ room: string; event: string; payload: unknown }> = []
    try {
      for (const key of SWITCHES) process.env[key] = 'true'
      setTaskCountsBroadcaster((room, event, payload) => {
        sends.push({ room, event, payload })
      })
      const res = await complete(w.c, taskId, { scope: 'all' })
      expect([res.status, res.body]).toEqual([200, { done: true, version: 2 }])
      const completed = await poolManager.get().query<{ id: string }>(
        `SELECT id FROM task_events WHERE task_id = $1 AND event_type = 'completed'`,
        [taskId],
      )
      expect(completed.rows).toHaveLength(1)
      const outbox = await poolManager.get().query<{ recipient_user_id: string; recipient_role: string; event: string; event_id: string }>(
        `SELECT recipient_user_id, recipient_role, payload->>'event' AS event, payload->>'eventId' AS event_id
           FROM task_notification_deliveries WHERE source_id = $1 ORDER BY recipient_user_id COLLATE "C"`,
        [taskId],
      )
      const expected = [
        [w.a.userId, 'assignee'], [w.b.userId, 'assignee'], [w.f.userId, 'follower'],
        [w.le.userId, 'list_member'], [w.lr.userId, 'list_member'],
      ].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
      expect(outbox.rows.map((row) => [row.recipient_user_id, row.recipient_role])).toEqual(expected)
      for (const row of outbox.rows) expect([row.event, row.event_id]).toEqual(['completed', completed.rows[0].id])
      expect(sends.map((send) => send.room).sort()).toEqual([w.a.userId, w.b.userId].map(buildAuthenticatedUserRoom).sort())
      for (const send of sends) expect([send.event, send.payload]).toEqual([TASK_COUNTS_UPDATED_EVENT, {}])

      sends.length = 0
      const again = await complete(w.c, taskId, { scope: 'all' })
      expect([again.status, again.body]).toEqual([200, { done: true, version: 2 }])
      const after = await poolManager.get().query<{ n: number }>(
        'SELECT count(*)::int AS n FROM task_notification_deliveries WHERE source_id = $1',
        [taskId],
      )
      expect(after.rows[0].n).toBe(outbox.rows.length)
      expect(sends).toEqual([])
    } finally {
      for (const key of SWITCHES) {
        if (saved[key] === undefined) delete process.env[key]
        else process.env[key] = saved[key]
      }
      resetTaskCountsBroadcasterForTests()
    }
  })
})
