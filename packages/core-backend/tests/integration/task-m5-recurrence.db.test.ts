import '../helpers/assert-rbac-optional-off'
import { randomUUID } from 'node:crypto'
import type supertest from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { poolManager } from '../../src/integration/db/connection-pool'
import { buildAuthenticatedUserRoom } from '../../src/services/CollabService'
import { resetTaskCountsBroadcasterForTests, setTaskCountsBroadcaster } from '../../src/services/task-counts-realtime'
import { newTaskListId } from '../../src/services/task-ids-runtime'
import { patchTask } from '../../src/services/task-patch'
import { createTask } from '../../src/services/task-records'
import { setTaskRecurrence } from '../../src/services/task-recurrence-records'
import {
  addAssignee,
  addComment,
  deleteTaskById,
  removeAssignee,
  setTaskParent,
  updateComment,
} from '../../src/services/task-structure'
import { computeDueAt } from '../../src/tasks/task-dates'
import { computeDefaultRemindAt } from '../../src/tasks/task-reminders'
import { dropTaskM4Fixtures, seedOrgDingTalkIntegration, seedTaskActor, type SeededTaskActor } from '../helpers/task-m4-fixtures'
import { startTasksListener, tasksClient, type TasksClient, type TasksListener } from '../helpers/tasks-http-harness'

/**
 * M5 PR-4a slice 3: recurring tasks (design task-m5-pr4a-backend-design-20261010.md §3.2, §3.8,
 * §6.2 candidate M5-a, §6.2.1 first row, §6.4 gate 26 series cell). Cells are named rec-….
 * RULED(2026-10-09): [S14]–[S17], [S33], [S35]. ASSUMPTION(task-m5a): [a-10], [a-15]–[a-17],
 * [a-19], [a-27], [a-30], [a-32], [a-33], [a-35], [a-37]; D3 (ASSUMPTION). Candidate cells: gate 27
 * scores only once a lock revision writes it into arm-set (design §6.2, §7.3).
 *
 * HTTP goes through `tasksRouter()` on one listener per file (tests/helpers/tasks-http-harness.ts;
 * setup.integration.ts, RBAC_TOKEN_TRUST='true'). Tasks are created and given their rule through the
 * services; followers, lists, field definitions and values, departures from the org and the few
 * states no route can reach are written with SQL. The concurrency cells force their interleaving
 * with a third connection holding a lock (design §6.2, opening paragraph).
 *
 * Instants are compared as whole microseconds since the epoch, never as text in a session zone.
 */

if (process.env.EXPECT_DB !== '1') {
  throw new Error('task-m5-recurrence.db.test.ts requires EXPECT_DB=1')
}

const JWT_SECRET = process.env.JWT_SECRET
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error('task-m5-recurrence.db.test.ts requires JWT_SECRET')
}

const ORG_PREFIX = 'org_tasks_m5rec_'
const FAIL_PREFIX = 'tasks_m5rec_fail_'
const ZONE = 'Asia/Shanghai'
const DAILY = { freq: 'daily', interval: 1 }
const seededUsers: string[] = []
const seededRoles: string[] = []

const HOOK_TIMEOUT_MS = 60000

const NOTIFY_SWITCHES = [
  'TASKS_SCHEDULER_ENABLED',
  'TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED',
  'TASKS_NOTIFICATION_DINGTALK_WORK_NOTIFICATION_ENABLED',
] as const

let listener: TasksListener | undefined

beforeAll(async () => {
  listener = await startTasksListener()
})

afterAll(async () => {
  resetTaskCountsBroadcasterForTests()
  await sweepFailTriggers()
  await dropTaskM4Fixtures({ orgPrefix: ORG_PREFIX, userIds: seededUsers, roleIds: seededRoles })
  // Field definitions are not in the M4 sweep; their values went with the tasks (cascade).
  await poolManager.get().query('DELETE FROM task_fields WHERE left(org_id, length($1)) = $1', [ORG_PREFIX])
  await listener?.close()
}, HOOK_TIMEOUT_MS)

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

/** One org per cell: the creator C, assignees A and B, followers F and G, a list editor LE, a list
 * reader LR and an outsider O (active in the org, nothing to do with the task). */
interface World {
  orgId: string
  stamp: string
  c: SeededTaskActor
  a: SeededTaskActor
  b: SeededTaskActor
  f: SeededTaskActor
  g: SeededTaskActor
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
    g: await actor('g', stamp, orgId),
    le: await actor('le', stamp, orgId),
    lr: await actor('lr', stamp, orgId),
    o: await actor('o', stamp, orgId),
  }
}

interface TaskOpts {
  mode?: 'all' | 'any'
  assignees?: SeededTaskActor[]
  dueDate?: string | null
  dueTime?: string | null
  startDate?: string | null
  startTime?: string | null
  remindAt?: string | null
  /** Defaults to Asia/Shanghai when the task has a date. */
  timeZone?: string
  /** The rule set through the service by C after the create; `null` leaves the task without one. */
  rule?: Record<string, unknown> | null
  followers?: SeededTaskActor[]
}

/**
 * A task created by C in `all` mode with A and B as assignees, due 2026-11-02 (all day, Asia/
 * Shanghai) and a daily rule unless `opts` says otherwise; F follows it, and one list holds it with C
 * as owner, LE as editor and LR as reader.
 */
async function taskOf(w: World, opts: TaskOpts = {}): Promise<string> {
  const dueDate = opts.dueDate === undefined ? '2026-11-02' : opts.dueDate
  const startDate = opts.startDate ?? null
  const dated = dueDate !== null || startDate !== null
  const { id } = await createTask({
    orgId: w.orgId,
    creatorId: w.c.userId,
    title: '周报',
    assignees: (opts.assignees ?? [w.a, w.b]).map((who) => who.userId),
    completionMode: opts.mode ?? 'all',
    dueDate,
    dueTime: opts.dueTime ?? null,
    startDate,
    startTime: opts.startTime ?? null,
    timeZone: dated ? (opts.timeZone ?? ZONE) : null,
    remindAt: opts.remindAt === undefined ? undefined : opts.remindAt,
  })
  const db = poolManager.get()
  for (const who of opts.followers ?? [w.f]) {
    await db.query('INSERT INTO task_followers (task_id, user_id) VALUES ($1, $2)', [id, who.userId])
  }
  const listId = newTaskListId()
  await db.query('INSERT INTO task_lists (id, org_id, name, created_by) VALUES ($1, $2, $3, $4)', [listId, w.orgId, '周报', w.c.userId])
  await db.query(
    `INSERT INTO task_list_members (list_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'edit'), ($1, $4, 'read')`,
    [listId, w.c.userId, w.le.userId, w.lr.userId],
  )
  await db.query('INSERT INTO task_list_items (list_id, task_id, org_id) VALUES ($1, $2, $3)', [listId, id, w.orgId])
  const rule = opts.rule === undefined ? DAILY : opts.rule
  if (rule !== null) {
    await setTaskRecurrence({ orgId: w.orgId, actorId: w.c.userId, taskId: id, body: { recurrence: rule } })
  }
  return id
}

function bearer(call: supertest.Test, who: SeededTaskActor): supertest.Test {
  return call.set('Authorization', `Bearer ${who.bearer}`)
}

function complete(who: SeededTaskActor, taskId: string, body?: unknown): supertest.Test {
  const call = bearer(app().post(`/api/tasks/${taskId}/complete`), who)
  return body === undefined ? call : call.send(body as object)
}

function reopen(who: SeededTaskActor, taskId: string, body: unknown): supertest.Test {
  return bearer(app().post(`/api/tasks/${taskId}/reopen`), who).send(body as object)
}

function putRecurrence(who: SeededTaskActor, taskId: string, body: unknown): supertest.Test {
  return bearer(app().put(`/api/tasks/${taskId}/recurrence`), who).send(body as object)
}

function detail(who: SeededTaskActor, taskId: string): supertest.Test {
  return bearer(app().get(`/api/tasks/${taskId}`), who)
}

function deleteTask(who: SeededTaskActor, taskId: string): supertest.Test {
  return bearer(app().delete(`/api/tasks/${taskId}`), who)
}

async function q<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await poolManager.get().query<T>(sql, params)).rows
}

/** The occurrences whose `previous_occurrence_id` is `taskId` (live or soft-deleted). */
async function successorsOf(taskId: string): Promise<string[]> {
  return (await q<{ id: string }>('SELECT id FROM tasks WHERE previous_occurrence_id = $1', [taskId])).map((row) => row.id)
}

/** The one successor of `taskId`; fails unless there is exactly one. */
async function successorOf(taskId: string): Promise<string> {
  const ids = await successorsOf(taskId)
  expect(ids, `successors of ${taskId}`).toHaveLength(1)
  return ids[0]
}

interface TaskRow {
  status: string
  version: number
  completion_mode: string
  due_date: string | null
  due_time: string | null
  start_date: string | null
  start_time: string | null
  time_zone: string | null
  due_us: string | null
  remind_us: string | null
  created_us: string
  updated_us: string
  deleted: boolean
  recurrence: unknown
  recurrence_series_id: string | null
  previous_occurrence_id: string | null
  created_by: string
  title: string
  is_milestone: boolean
  completed_us: string | null
  parent_id: string | null
  depth: number
  description: string | null
}

async function rowOf(taskId: string): Promise<TaskRow> {
  const rows = await q<TaskRow & Record<string, unknown>>(
    `SELECT status, version, completion_mode, due_date::text AS due_date, due_time::text AS due_time,
            start_date::text AS start_date, start_time::text AS start_time, time_zone,
            (extract(epoch FROM due_at) * 1000000)::bigint::text AS due_us,
            (extract(epoch FROM remind_at) * 1000000)::bigint::text AS remind_us,
            (extract(epoch FROM created_at) * 1000000)::bigint::text AS created_us,
            (extract(epoch FROM updated_at) * 1000000)::bigint::text AS updated_us,
            deleted_at IS NOT NULL AS deleted, recurrence, recurrence_series_id, previous_occurrence_id,
            created_by, title, is_milestone,
            (extract(epoch FROM completed_at) * 1000000)::bigint::text AS completed_us,
            parent_id, depth, description
       FROM tasks WHERE id = $1`,
    [taskId],
  )
  if (!rows[0]) throw new Error(`task ${taskId} missing`)
  return rows[0]
}

interface EventRow { type: string; actor: string; payload: unknown; atUs: string; id: string }

async function eventsOf(taskId: string): Promise<EventRow[]> {
  const rows = await q<{ event_type: string; actor_id: string; payload: unknown; at_us: string; id: string }>(
    `SELECT id, event_type, actor_id, payload, (extract(epoch FROM occurred_at) * 1000000)::bigint::text AS at_us
       FROM task_events WHERE task_id = $1 ORDER BY occurred_at, event_type COLLATE "C", id COLLATE "C"`,
    [taskId],
  )
  return rows.map((row) => ({ type: row.event_type, actor: row.actor_id, payload: row.payload, atUs: row.at_us, id: row.id }))
}

async function eventTypes(taskId: string): Promise<string[]> {
  return (await eventsOf(taskId)).map((event) => event.type)
}

async function assigneeRows(taskId: string): Promise<Array<{ user_id: string; completed: boolean; assigned_by: string }>> {
  return q(
    `SELECT user_id, completed_at IS NOT NULL AS completed, assigned_by FROM task_assignees WHERE task_id = $1 ORDER BY user_id COLLATE "C"`,
    [taskId],
  )
}

async function followerIds(taskId: string): Promise<string[]> {
  return (await q<{ user_id: string }>('SELECT user_id FROM task_followers WHERE task_id = $1 ORDER BY user_id COLLATE "C"', [taskId]))
    .map((row) => row.user_id)
}

async function listIdsOf(taskId: string): Promise<string[]> {
  return (await q<{ list_id: string }>('SELECT list_id FROM task_list_items WHERE task_id = $1 ORDER BY list_id COLLATE "C"', [taskId]))
    .map((row) => row.list_id)
}

async function fieldValuesOf(taskId: string): Promise<Record<string, unknown>> {
  const rows = await q<{ field_id: string; value: unknown }>('SELECT field_id, value FROM task_field_values WHERE task_id = $1', [taskId])
  return Object.fromEntries(rows.map((row) => [row.field_id, row.value]))
}

/** The task row, its assignee, follower and list rows and its events, as one string. */
async function snapshot(taskId: string): Promise<string> {
  const task = await q('SELECT status, version, completed_at, updated_at, deleted_at, recurrence FROM tasks WHERE id = $1', [taskId])
  const events = await q('SELECT id, event_type, actor_id, payload, occurred_at FROM task_events WHERE task_id = $1 ORDER BY id COLLATE "C"', [taskId])
  return JSON.stringify({ task, assignees: await assigneeRows(taskId), followers: await followerIds(taskId), lists: await listIdsOf(taskId), events })
}

function sorted(ids: string[]): string[] {
  return [...ids].sort()
}

async function leaveOrg(w: World, who: SeededTaskActor): Promise<void> {
  await poolManager.get().query('UPDATE user_orgs SET is_active = false WHERE user_id = $1 AND org_id = $2', [who.userId, w.orgId])
}

/** The four writes that can flip a task to done (design §3.2), each from the same start: `all`
 * mode, A and B open. Returns the HTTP statuses of the calls it made. */
interface FlipPath {
  label: string
  flip: (w: World, taskId: string) => Promise<number[]>
}

const FLIP_PATHS: FlipPath[] = [
  {
    label: 'completeTask (A, then B completes)',
    flip: async (w, taskId) => [(await complete(w.a, taskId)).status, (await complete(w.b, taskId)).status],
  },
  {
    label: 'completeTask with scope all (G1, the creator)',
    flip: async (w, taskId) => [(await complete(w.c, taskId, { scope: 'all' })).status],
  },
  {
    label: 'removeAssignee (A completed, C removes B)',
    flip: async (w, taskId) => [
      (await complete(w.a, taskId)).status,
      (await bearer(app().delete(`/api/tasks/${taskId}/assignees/${w.b.userId}`), w.c)).status,
    ],
  },
  {
    label: 'switchCompletionMode (A completed, C switches to any)',
    flip: async (w, taskId) => [
      (await complete(w.a, taskId)).status,
      (await bearer(app().patch(`/api/tasks/${taskId}/completion-mode`), w.c).send({ completionMode: 'any' })).status,
    ],
  },
]

async function expectFlippedWithoutSpawn(taskId: string, statuses: number[], label: string): Promise<void> {
  for (const status of statuses) expect(status, label).toBe(200)
  expect((await rowOf(taskId)).status, label).toBe('done')
  expect(await successorsOf(taskId), label).toEqual([])
  expect(await eventTypes(taskId), label).not.toContain('recurrence_spawned')
}

/** Waits until `min` backends of this database are blocked by `holderPid`. */
async function waitUntilBlocked(holderPid: number, min: number): Promise<void> {
  const deadline = Date.now() + 10000
  for (;;) {
    const rows = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND $1 = ANY (pg_blocking_pids(pid))`,
      [holderPid],
    )
    if (rows[0].n >= min) return
    if (Date.now() > deadline) throw new Error(`expected ${min} backends blocked by ${holderPid}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/** Waits until `min` backends of this database, other than `exceptPid`, wait on a lock. */
async function waitForLockWaiters(min: number, exceptPid: number): Promise<void> {
  const deadline = Date.now() + 10000
  for (;;) {
    const rows = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> $1`,
      [exceptPid],
    )
    if (rows[0].n >= min) return
    if (Date.now() > deadline) throw new Error(`expected ${min} backends waiting on a lock`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/**
 * Makes the COMMIT of any transaction that inserts a `task_events` row of `taskId` fail (a deferred
 * constraint trigger; the same technique as the gate 26 rollback cells of task-m4-realtime).
 */
async function failAtCommit(taskId: string, stamp: string): Promise<{ drop: () => Promise<void> }> {
  if (!/^[A-Za-z0-9_]+$/.test(taskId) || !/^[a-f0-9]+$/.test(stamp)) throw new Error('failAtCommit: unexpected id shape')
  const name = `${FAIL_PREFIX}${stamp}`
  const db = poolManager.get()
  await db.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced failure at commit'; END $$`)
  await db.query(
    `CREATE CONSTRAINT TRIGGER ${name} AFTER INSERT ON task_events DEFERRABLE INITIALLY DEFERRED
     FOR EACH ROW WHEN (NEW.task_id = '${taskId}') EXECUTE FUNCTION ${name}()`,
  )
  return {
    drop: async () => {
      await db.query(`DROP TRIGGER IF EXISTS ${name} ON task_events`)
      await db.query(`DROP FUNCTION IF EXISTS ${name}()`)
    },
  }
}

async function sweepFailTriggers(): Promise<void> {
  const db = poolManager.get()
  const triggers = await db.query<{ tgname: string }>(
    `SELECT tgname FROM pg_trigger WHERE tgrelid = 'task_events'::regclass AND left(tgname, length($1)) = $1`,
    [FAIL_PREFIX],
  )
  for (const row of triggers.rows) await db.query(`DROP TRIGGER IF EXISTS ${row.tgname} ON task_events`)
  const functions = await db.query<{ proname: string }>(`SELECT proname FROM pg_proc WHERE left(proname, length($1)) = $1`, [FAIL_PREFIX])
  for (const row of functions.rows) await db.query(`DROP FUNCTION IF EXISTS ${row.proname}()`)
}

async function withNotifications<T>(run: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(NOTIFY_SWITCHES.map((key) => [key, process.env[key]]))
  try {
    for (const key of NOTIFY_SWITCHES) process.env[key] = 'true'
    return await run()
  } finally {
    for (const key of NOTIFY_SWITCHES) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  }
}

// ---------------------------------------------------------------------------------------------
// M5-a: the spawn on each flip (design §3.2; RULED(2026-10-09): [S15] [S16]).
// ---------------------------------------------------------------------------------------------

describe('M5 PR-4a slice 3, M5-a: a flip to done spawns exactly one next occurrence', () => {
  it('rec-complete | the second assignee\'s complete flips the task: one new occurrence, its dates stepped (start shifted by the same days, time and zone copied, due_at recomputed, the reminder kept at the same lead), the series columns set, fresh open assignee rows, followers and lists copied, the two events', async () => {
    const w = await world('cmp')
    const rule = { freq: 'daily', interval: 2 }
    const remindAt = '2026-11-02T00:00:00.000Z' // due_at 01:00Z (09:00 in Asia/Shanghai) − 1 h
    const src = await taskOf(w, { rule, dueDate: '2026-11-02', dueTime: '09:00', startDate: '2026-11-01', startTime: '08:00', remindAt })
    expect((await complete(w.a, src)).body).toEqual({ done: false, version: 1 })
    const res = await complete(w.b, src)
    expect([res.status, res.body]).toEqual([200, { done: true, version: 2 }])
    const next = await successorOf(src)
    const row = await rowOf(next)
    const expectedDue = computeDueAt({ dueDate: '2026-11-04', dueTime: '09:00', timeZone: ZONE })
    expect(row).toMatchObject({
      status: 'open',
      version: 1,
      completion_mode: 'all',
      due_date: '2026-11-04',
      due_time: '09:00:00',
      start_date: '2026-11-03',
      start_time: '08:00:00',
      time_zone: ZONE,
      due_us: String(expectedDue.getTime() * 1000),
      remind_us: String((expectedDue.getTime() - 3600000) * 1000),
      deleted: false,
      recurrence: rule,
      recurrence_series_id: src,
      previous_occurrence_id: src,
      created_by: w.c.userId,
      title: '周报',
      is_milestone: false,
    })
    expect(await assigneeRows(next)).toEqual(
      sorted([w.a.userId, w.b.userId]).map((user_id) => ({ user_id, completed: false, assigned_by: w.c.userId })),
    )
    expect(await followerIds(next)).toEqual([w.f.userId])
    expect(await listIdsOf(next)).toEqual(await listIdsOf(src))
    const spawned = (await eventsOf(src)).filter((event) => event.type === 'recurrence_spawned')
    expect(spawned.map((event) => [event.actor, event.payload])).toEqual([[w.b.userId, { spawnedTaskId: next }]])
    expect((await eventsOf(next)).map((event) => [event.type, event.actor, event.payload])).toEqual([['created', w.b.userId, {}]])
  })

  it('rec-g1 | the creator\'s complete for every assignee (scope all) spawns too (design §5 rule 3)', async () => {
    const w = await world('g1')
    const src = await taskOf(w)
    const res = await complete(w.c, src, { scope: 'all' })
    expect([res.status, res.body]).toEqual([200, { done: true, version: 2 }])
    const next = await successorOf(src)
    expect(await assigneeRows(next)).toEqual(sorted([w.a.userId, w.b.userId]).map((user_id) => ({ user_id, completed: false, assigned_by: w.c.userId })))
    expect((await rowOf(next)).due_date).toBe('2026-11-03')
  })

  it('rec-remove-assignee | removing the last open assignee flips the task and spawns; the removed user is not carried', async () => {
    const w = await world('rm')
    const src = await taskOf(w)
    expect((await complete(w.a, src)).status).toBe(200)
    const res = await bearer(app().delete(`/api/tasks/${src}/assignees/${w.b.userId}`), w.c)
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('done')
    const next = await successorOf(src)
    expect(await assigneeRows(next)).toEqual([{ user_id: w.a.userId, completed: false, assigned_by: w.c.userId }])
  })

  it('rec-switch-mode | switching all to any after one completion flips the task and spawns, in the new mode', async () => {
    const w = await world('sw')
    const src = await taskOf(w)
    expect((await complete(w.a, src)).status).toBe(200)
    const res = await bearer(app().patch(`/api/tasks/${src}/completion-mode`), w.c).send({ completionMode: 'any' })
    expect([res.status, res.body.status]).toEqual([200, 'done'])
    const next = await successorOf(src)
    expect((await rowOf(next)).completion_mode).toBe('any')
    expect(await assigneeRows(next)).toEqual(sorted([w.a.userId, w.b.userId]).map((user_id) => ({ user_id, completed: false, assigned_by: w.c.userId })))
  })

  it('rec-no-flip | a complete that does not flip (one of two assignees) and a reopen spawn nothing', async () => {
    const w = await world('noflip')
    const src = await taskOf(w)
    expect((await complete(w.a, src)).status).toBe(200)
    expect(await successorsOf(src)).toEqual([])
    expect((await reopen(w.a, src, { scope: 'self' })).status).toBe(200)
    expect(await successorsOf(src)).toEqual([])
    expect(await eventTypes(src)).not.toContain('recurrence_spawned')
  })

  it('rec-reopen-again | reopening the spawned occurrence and completing it again spawns no second one (the event check; the unique index behind it)', async () => {
    const w = await world('again')
    const src = await taskOf(w)
    expect((await complete(w.c, src, { scope: 'all' })).status).toBe(200)
    const next = await successorOf(src)
    expect((await reopen(w.c, src, { scope: 'all' })).status).toBe(200)
    expect((await rowOf(src)).status).toBe('open')
    const again = await complete(w.c, src, { scope: 'all' })
    expect([again.status, again.body]).toEqual([200, { done: true, version: 4 }])
    expect(await successorsOf(src)).toEqual([next])
    expect((await eventTypes(src)).filter((type) => type === 'recurrence_spawned')).toHaveLength(1)
  })

  it('rec-count-end | a count of 2: the first completion spawns the second occurrence; completing that one spawns nothing (series_ended) and answers 200', async () => {
    const w = await world('count')
    const src = await taskOf(w, { rule: { freq: 'daily', interval: 1, end: { count: 2 } } })
    expect((await complete(w.c, src, { scope: 'all' })).status).toBe(200)
    const second = await successorOf(src)
    const res = await complete(w.c, second, { scope: 'all' })
    expect([res.status, res.body]).toEqual([200, { done: true, version: 2 }])
    await expectFlippedWithoutSpawn(second, [res.status], 'count')
  })

  it('rec-until-end | an until on the current due date: completing spawns nothing (series_ended) and answers 200; an until one day later spawns', async () => {
    const w = await world('until')
    const ended = await taskOf(w, { rule: { freq: 'daily', interval: 1, end: { until: '2026-11-02' } } })
    const res = await complete(w.c, ended, { scope: 'all' })
    await expectFlippedWithoutSpawn(ended, [res.status], 'until')
    const open = await taskOf(w, { rule: { freq: 'daily', interval: 1, end: { until: '2026-11-03' } } })
    expect((await complete(w.c, open, { scope: 'all' })).status).toBe(200)
    expect((await rowOf(await successorOf(open))).due_date).toBe('2026-11-03')
  })

  it('rec-instant | one spawn: the flipped occurrence\'s completed, its recurrence_spawned and the new occurrence\'s created share one instant, which is also the new row\'s created_at and updated_at ([a-37])', async () => {
    const w = await world('instant')
    const src = await taskOf(w)
    expect((await complete(w.a, src)).status).toBe(200)
    expect((await complete(w.b, src)).status).toBe(200)
    const next = await successorOf(src)
    const srcEvents = await eventsOf(src)
    const completed = srcEvents.filter((event) => event.type === 'completed')
    const spawned = srcEvents.filter((event) => event.type === 'recurrence_spawned')
    const created = (await eventsOf(next)).filter((event) => event.type === 'created')
    expect([completed.length, spawned.length, created.length]).toEqual([1, 1, 1])
    expect(spawned[0].atUs).toBe(completed[0].atUs)
    expect(created[0].atUs).toBe(completed[0].atUs)
    const row = await rowOf(next)
    expect([row.created_us, row.updated_us]).toEqual([completed[0].atUs, completed[0].atUs])
  })

  it.each(FLIP_PATHS.slice(2).map((path) => [path.label, path] as const))(
    'rec-instant-paths | %s: the flipped occurrence\'s completed_at, its recurrence_spawned, the new occurrence\'s created and the new row\'s created_at and updated_at are one instant ([a-37])',
    async (label, path) => {
      const w = await world('instp')
      const src = await taskOf(w)
      for (const status of await path.flip(w, src)) expect(status, label).toBe(200)
      const next = await successorOf(src)
      const flipped = await rowOf(src)
      expect(flipped.status, label).toBe('done')
      const spawned = (await eventsOf(src)).filter((event) => event.type === 'recurrence_spawned')
      const created = (await eventsOf(next)).filter((event) => event.type === 'created')
      expect([spawned.length, created.length], label).toEqual([1, 1])
      const row = await rowOf(next)
      expect([spawned[0].atUs, created[0].atUs, row.created_us, row.updated_us], label).toEqual(Array(4).fill(flipped.completed_us))
    },
  )

  it('rec-monthly-anchor | a monthly rule from 01-31: every occurrence is stepped from the first one\'s due date, not the previous one\'s (02-28, 03-31, 04-30; [S14] no drift)', async () => {
    const w = await world('mon')
    let current = await taskOf(w, { dueDate: '2027-01-31', rule: { freq: 'monthly', interval: 1 } })
    const dues: string[] = []
    for (let i = 0; i < 3; i += 1) {
      expect((await complete(w.c, current, { scope: 'all' })).status).toBe(200)
      current = await successorOf(current)
      dues.push(String((await rowOf(current)).due_date))
    }
    expect(dues).toEqual(['2027-02-28', '2027-03-31', '2027-04-30'])
  })

  it('rec-remind-policy | a source without a reminder: the new occurrence takes the series creator\'s default reminder policy, never the completer\'s ([S16])', async () => {
    const w = await world('rpol')
    const setPolicy = async (who: SeededTaskActor, mode: 'none' | 'default'): Promise<void> => {
      await poolManager.get().query(
        `INSERT INTO task_user_settings (user_id, org_id, default_remind_policy) VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (user_id, org_id) DO UPDATE SET default_remind_policy = EXCLUDED.default_remind_policy`,
        [who.userId, w.orgId, JSON.stringify({ mode })],
      )
    }
    const expected = computeDefaultRemindAt({ dueDate: '2026-11-03', dueTime: null, dueAt: null, timeZone: ZONE, policy: { mode: 'default' } })
    expect(expected).not.toBeNull()
    // The creator keeps the default policy, the completer has none: the new occurrence gets a reminder.
    await setPolicy(w.a, 'none')
    const first = await taskOf(w, { mode: 'any', assignees: [w.a], remindAt: null })
    expect((await rowOf(first)).remind_us).toBeNull()
    expect((await complete(w.a, first)).status).toBe(200)
    expect((await rowOf(await successorOf(first))).remind_us).toBe(String((expected as Date).getTime() * 1000))
    // The creator has none, the completer the default: the new occurrence gets no reminder.
    await setPolicy(w.c, 'none')
    await setPolicy(w.a, 'default')
    const second = await taskOf(w, { mode: 'any', assignees: [w.a], remindAt: null })
    expect((await complete(w.a, second)).status).toBe(200)
    expect((await rowOf(await successorOf(second))).remind_us).toBeNull()
  })

  it('rec-subtask-carried | a recurring subtask: the new occurrence carries the parent, depth, description and milestone flag ([S16])', async () => {
    const w = await world('sub')
    const parent = await createTask({ orgId: w.orgId, creatorId: w.c.userId, title: '父任务', assignees: [w.a.userId] })
    const src = await taskOf(w)
    await setTaskParent({ orgId: w.orgId, actorId: w.c.userId, taskId: src, body: { parentId: parent.id } })
    await poolManager.get().query(`UPDATE tasks SET description = '每周一次', is_milestone = true WHERE id = $1`, [src])
    expect(await rowOf(src)).toMatchObject({ parent_id: parent.id, depth: 1, description: '每周一次', is_milestone: true })
    expect((await complete(w.c, src, { scope: 'all' })).status).toBe(200)
    expect(await rowOf(await successorOf(src))).toMatchObject({ parent_id: parent.id, depth: 1, description: '每周一次', is_milestone: true })
  })
})

// ---------------------------------------------------------------------------------------------
// M5-a: the frozen order before planSpawn (design §3.2 steps 2–4): no spawn, and the write still
// 200, on every flip path.
// ---------------------------------------------------------------------------------------------

interface NoSpawnShape {
  label: string
  /** Builds the occurrence that the flip path then flips. */
  build: (w: World) => Promise<string>
}

const NO_SPAWN_SHAPES: NoSpawnShape[] = [
  {
    label: 'the due date and the time zone cleared together (PATCH, [a-27])',
    build: async (w) => {
      const id = await taskOf(w)
      await patchTask({
        orgId: w.orgId, actorId: w.c.userId, taskId: id,
        body: { expectedVersion: 1, dueDate: null, dueTime: null, startDate: null, startTime: null, timeZone: null },
      })
      expect(await rowOf(id)).toMatchObject({ due_date: null, time_zone: null, recurrence: DAILY })
      return id
    },
  },
  {
    label: 'the first occurrence\'s own due date cleared (PATCH; start date and zone kept)',
    build: async (w) => {
      const id = await taskOf(w, { startDate: '2026-11-01' })
      await patchTask({ orgId: w.orgId, actorId: w.c.userId, taskId: id, body: { expectedVersion: 1, dueDate: null, timeZone: ZONE } })
      expect(await rowOf(id)).toMatchObject({ due_date: null, start_date: '2026-11-01', time_zone: ZONE })
      return id
    },
  },
  {
    label: 'a later occurrence with a due date, the first occurrence\'s due date cleared (empty anchor, [a-33])',
    build: async (w) => {
      const first = await taskOf(w)
      expect((await complete(w.c, first, { scope: 'all' })).status).toBe(200)
      const later = await successorOf(first)
      await poolManager.get().query('UPDATE tasks SET due_date = NULL, due_time = NULL, due_at = NULL WHERE id = $1', [first])
      expect((await rowOf(later)).due_date).toBe('2026-11-03')
      return later
    },
  },
]

/**
 * Rules whose next occurrence reaches the end of the calendar (design §3.2 step 4, task E): the next
 * due date itself past 9999-12-31, or a value derived from a next due date of 9999-12-31 outside the
 * range the direct writes accept. Each is reached with the public writes only.
 */
const LAST_DAY_SHAPES: NoSpawnShape[] = [
  {
    label: 'due 9999-12-31 (Asia/Shanghai, all day)',
    build: async (w) => taskOf(w, { dueDate: '9999-12-31' }),
  },
  {
    label: 'due 9999-12-30 all day west of UTC (the next due instant falls in year 10000, [own-38])',
    build: async (w) => {
      const id = await taskOf(w, { dueDate: '9999-12-30', timeZone: 'America/New_York' })
      expect(await rowOf(id)).toMatchObject({ due_date: '9999-12-30', time_zone: 'America/New_York' })
      return id
    },
  },
  {
    label: 'due 9999-12-30 with a start date of 9999-12-31 ([own-07]: the start would shift past the calendar)',
    build: async (w) => {
      const id = await taskOf(w, { dueDate: '9999-12-30', startDate: '9999-12-31' })
      expect(await rowOf(id)).toMatchObject({ due_date: '9999-12-30', start_date: '9999-12-31' })
      return id
    },
  },
  {
    label: 'due 9999-12-30 09:00 with a reminder after it ([own-30]: the shifted reminder falls in year 10000)',
    build: async (w) => {
      const id = await taskOf(w, { dueDate: '9999-12-30', dueTime: '09:00', remindAt: '9999-12-31T20:00:00.000Z' })
      expect((await rowOf(id)).remind_us).toBe(String(Date.parse('9999-12-31T20:00:00.000Z') * 1000))
      return id
    },
  },
]

describe('M5 PR-4a slice 3, M5-a: no spawn, the write still 200 (design §3.2 steps 2–4)', () => {
  it.each(NO_SPAWN_SHAPES.flatMap((shape) => FLIP_PATHS.map((path) => [`${shape.label} | ${path.label}`, shape, path] as const)))(
    'rec-no-due | %s: 200, the task is done, no new occurrence, no recurrence_spawned',
    async (label, shape, path) => {
      const w = await world('nodue')
      const taskId = await shape.build(w)
      await expectFlippedWithoutSpawn(taskId, await path.flip(w, taskId), label)
    },
  )

  it.each(LAST_DAY_SHAPES.flatMap((shape) => FLIP_PATHS.map((path) => [`${shape.label} | ${path.label}`, shape, path] as const)))(
    'rec-9999 | %s: 200, the task is done, no new occurrence, no recurrence_spawned (series_ended, task E)',
    async (label, shape, path) => {
      const w = await world('last')
      const taskId = await shape.build(w)
      await expectFlippedWithoutSpawn(taskId, await path.flip(w, taskId), label)
    },
  )
})

// ---------------------------------------------------------------------------------------------
// M5-a: the people of the new occurrence ([a-15]) and the ordinal ([a-16]).
// ---------------------------------------------------------------------------------------------

async function seedField(w: World, suffix: string, type: 'member' | 'text'): Promise<string> {
  const id = `tfld_${suffix}${w.stamp}`
  await poolManager.get().query(
    `INSERT INTO task_fields (id, org_id, type, name, config, created_by) VALUES ($1, $2, $3, $4, '{}'::jsonb, $5)`,
    [id, w.orgId, type, type === 'member' ? '负责人' : '备注', w.c.userId],
  )
  return id
}

async function seedValue(w: World, taskId: string, fieldId: string, value: unknown): Promise<void> {
  await poolManager.get().query(
    `INSERT INTO task_field_values (task_id, field_id, org_id, value, updated_by) VALUES ($1, $2, $3, $4::jsonb, $5)`,
    [taskId, fieldId, w.orgId, JSON.stringify(value), w.c.userId],
  )
}

describe('M5 PR-4a slice 3, M5-a: who the new occurrence carries ([a-15])', () => {
  it('rec-people-follower | a follower who left the org is not carried; the active follower is (positive control); the completion is 200', async () => {
    const w = await world('pf')
    const src = await taskOf(w, { followers: [w.f, w.g] })
    await leaveOrg(w, w.f)
    expect((await complete(w.c, src, { scope: 'all' })).status).toBe(200)
    expect(await followerIds(await successorOf(src))).toEqual([w.g.userId])
  })

  it('rec-people-member-many | a member value naming a user who left loses that id and keeps the others; a text value is copied as stored', async () => {
    const w = await world('pmm')
    const src = await taskOf(w)
    const member = await seedField(w, 'm', 'member')
    const text = await seedField(w, 't', 'text')
    await seedValue(w, src, member, [w.a.userId, w.f.userId, w.g.userId])
    await seedValue(w, src, text, '备注')
    await leaveOrg(w, w.f)
    expect((await complete(w.c, src, { scope: 'all' })).status).toBe(200)
    expect(await fieldValuesOf(await successorOf(src))).toEqual({ [member]: [w.a.userId, w.g.userId], [text]: '备注' })
  })

  it('rec-people-member-only | a member value naming only users who left has no row on the new occurrence', async () => {
    const w = await world('pmo')
    const src = await taskOf(w)
    const member = await seedField(w, 'm', 'member')
    await seedValue(w, src, member, [w.f.userId])
    await leaveOrg(w, w.f)
    expect((await complete(w.c, src, { scope: 'all' })).status).toBe(200)
    expect(await fieldValuesOf(await successorOf(src))).toEqual({})
  })

  it('rec-people-assignee | an assignee who left the org gets no row on the new occurrence; the creator\'s completion is 200; the remaining assignee completes the new one', async () => {
    const w = await world('pa')
    const src = await taskOf(w)
    await leaveOrg(w, w.b)
    expect((await complete(w.c, src, { scope: 'all' })).status).toBe(200)
    const next = await successorOf(src)
    expect(await assigneeRows(next)).toEqual([{ user_id: w.a.userId, completed: false, assigned_by: w.c.userId }])
    const res = await complete(w.a, next)
    expect([res.status, res.body]).toEqual([200, { done: true, version: 2 }])
  })

  it('rec-ordinal | a count-3 series whose created_at values are rewritten in reverse chain order: completing the third occurrence spawns nothing, since the ordinal is counted along the chain ([a-16])', async () => {
    const w = await world('ord')
    const first = await taskOf(w, { rule: { freq: 'daily', interval: 1, end: { count: 3 } } })
    expect((await complete(w.c, first, { scope: 'all' })).status).toBe(200)
    const second = await successorOf(first)
    expect((await complete(w.c, second, { scope: 'all' })).status).toBe(200)
    const third = await successorOf(second)
    const db = poolManager.get()
    await db.query(`UPDATE tasks SET created_at = '2026-10-03T00:00:00Z' WHERE id = $1`, [first])
    await db.query(`UPDATE tasks SET created_at = '2026-10-02T00:00:00Z' WHERE id = $1`, [second])
    await db.query(`UPDATE tasks SET created_at = '2026-10-01T00:00:00Z' WHERE id = $1`, [third])
    const res = await complete(w.c, third, { scope: 'all' })
    await expectFlippedWithoutSpawn(third, [res.status], 'ordinal')
    expect((await q('SELECT id FROM tasks WHERE recurrence_series_id = $1 OR id = $1', [first])).length).toBe(3)
  })
})

// ---------------------------------------------------------------------------------------------
// PUT /api/tasks/:id/recurrence (design §3.2, §6.2.1 first row; RULED(2026-10-09): [S35]).
// ---------------------------------------------------------------------------------------------

describe('M5 PR-4a slice 3: PUT /api/tasks/:id/recurrence', () => {
  it('rec-put-auth | set: the creator, an assignee and a list editor get 200 (recurrence_set by them, version unchanged); a follower, a list reader and an outsider get the missing-task 404 byte for byte, nothing written', async () => {
    const w = await world('pauth')
    for (const who of [w.c, w.a, w.le]) {
      const id = await taskOf(w, { rule: null })
      const res = await putRecurrence(who, id, { recurrence: { interval: 2, freq: 'daily' } })
      expect([res.status, res.body], who.userId).toEqual([200, { id, recurrence: { freq: 'daily', interval: 2 }, seriesId: null, previousOccurrenceId: null }])
      const row = await rowOf(id)
      expect([row.recurrence, row.version], who.userId).toEqual([{ freq: 'daily', interval: 2 }, 1])
      expect((await eventsOf(id)).filter((event) => event.type === 'recurrence_set').map((event) => event.actor), who.userId).toEqual([who.userId])
    }
    const id = await taskOf(w, { rule: null })
    const before = await snapshot(id)
    for (const who of [w.f, w.lr, w.o]) {
      const res = await putRecurrence(who, id, { recurrence: DAILY })
      const absent = await putRecurrence(who, `tsk_missing_${w.stamp}`, { recurrence: DAILY })
      expect(res.status, who.userId).toBe(404)
      expect(res.text, who.userId).toBe(absent.text)
    }
    expect(await snapshot(id)).toBe(before)
  })

  it('rec-put-auth-clear | clear: the creator, an assignee and a list editor get 200 (recurrence_cleared by them); a follower, a list reader and an outsider get the missing-task 404 byte for byte, nothing written', async () => {
    const w = await world('pclr')
    for (const who of [w.c, w.a, w.le]) {
      const id = await taskOf(w)
      const res = await putRecurrence(who, id, { recurrence: null })
      expect([res.status, res.body], who.userId).toEqual([200, { id, recurrence: null, seriesId: null, previousOccurrenceId: null }])
      expect((await rowOf(id)).recurrence, who.userId).toBeNull()
      expect((await eventsOf(id)).filter((event) => event.type === 'recurrence_cleared').map((event) => event.actor), who.userId).toEqual([who.userId])
    }
    const id = await taskOf(w)
    const before = await snapshot(id)
    for (const who of [w.f, w.lr, w.o]) {
      const res = await putRecurrence(who, id, { recurrence: null })
      const absent = await putRecurrence(who, `tsk_missing_${w.stamp}`, { recurrence: null })
      expect(res.status, who.userId).toBe(404)
      expect(res.text, who.userId).toBe(absent.text)
    }
    expect(await snapshot(id)).toBe(before)
  })

  it('rec-put-codes | 422 INVALID_RECURRENCE for a body that is not an object, a missing key ([a-32]), an unknown freq and a count over 365; DUE_REQUIRED for a valid rule on a task without a due date, INVALID_RECURRENCE first when both fail; a follower with a bad body is 404; nothing is written by any of them', async () => {
    const w = await world('pcode')
    const dated = await taskOf(w, { rule: null })
    const undated = await taskOf(w, { rule: null, dueDate: null })
    const beforeDated = await snapshot(dated)
    const beforeUndated = await snapshot(undated)
    const code = async (who: SeededTaskActor, id: string, body: unknown): Promise<[number, unknown]> => {
      const res = await putRecurrence(who, id, body)
      return [res.status, res.body]
    }
    const invalid = [422, { error: { code: 'INVALID_RECURRENCE' } }]
    expect(await code(w.c, dated, [])).toEqual(invalid)
    expect(await code(w.c, dated, {})).toEqual(invalid)
    expect(await code(w.c, dated, { rule: DAILY })).toEqual(invalid)
    expect(await code(w.c, dated, { recurrence: { freq: 'hourly', interval: 1 } })).toEqual(invalid)
    expect(await code(w.c, dated, { recurrence: { freq: 'daily', interval: 1, end: { count: 366 } } })).toEqual(invalid)
    expect(await code(w.c, undated, { recurrence: DAILY })).toEqual([422, { error: { code: 'DUE_REQUIRED' } }])
    expect(await code(w.c, undated, { recurrence: { freq: 'hourly', interval: 1 } })).toEqual(invalid)
    const asFollower = await putRecurrence(w.f, dated, {})
    const absent = await putRecurrence(w.f, `tsk_missing_${w.stamp}`, {})
    expect(asFollower.status).toBe(404)
    expect(asFollower.text).toBe(absent.text)
    expect(await snapshot(dated)).toBe(beforeDated)
    expect(await snapshot(undated)).toBe(beforeUndated)
  })

  it('rec-put-noop | the same rule again (after canonicalization) and a clear without a rule are 200 no-ops: no write, no event', async () => {
    const w = await world('pnoop')
    const id = await taskOf(w, { rule: { freq: 'weekly', interval: 1, byWeekday: [5, 1, 1] } })
    expect((await rowOf(id)).recurrence).toEqual({ freq: 'weekly', interval: 1, byWeekday: [1, 5] })
    const before = await snapshot(id)
    const same = await putRecurrence(w.c, id, { recurrence: { byWeekday: [1, 5], interval: 1, freq: 'weekly' } })
    expect([same.status, same.body.recurrence]).toEqual([200, { freq: 'weekly', interval: 1, byWeekday: [1, 5] }])
    expect(await snapshot(id)).toBe(before)
    const bare = await taskOf(w, { rule: null })
    const beforeBare = await snapshot(bare)
    const clear = await putRecurrence(w.c, bare, { recurrence: null })
    expect([clear.status, clear.body.recurrence]).toEqual([200, null])
    expect(await snapshot(bare)).toBe(beforeBare)
  })

  it('rec-clear-latest | clearing an earlier occurrence is 422 NOT_CURRENT_OCCURRENCE, done or reopened while its successor lives; clearing the latest open one is 200 with recurrence_cleared and the version unchanged', async () => {
    const w = await world('clr')
    const first = await taskOf(w)
    expect((await complete(w.c, first, { scope: 'all' })).status).toBe(200)
    const second = await successorOf(first)
    const notCurrent = [422, { error: { code: 'NOT_CURRENT_OCCURRENCE' } }]
    let res = await putRecurrence(w.c, first, { recurrence: null })
    expect([res.status, res.body]).toEqual(notCurrent)
    expect((await reopen(w.c, first, { scope: 'all' })).status).toBe(200)
    res = await putRecurrence(w.c, first, { recurrence: null })
    expect([res.status, res.body]).toEqual(notCurrent)
    expect((await rowOf(first)).recurrence).toEqual(DAILY)
    res = await putRecurrence(w.c, second, { recurrence: null })
    expect([res.status, res.body]).toEqual([200, { id: second, recurrence: null, seriesId: first, previousOccurrenceId: first }])
    const row = await rowOf(second)
    expect([row.recurrence, row.version]).toEqual([null, 1])
    expect(await eventTypes(second)).toContain('recurrence_cleared')
  })

  it('rec-clear-seeded | an earlier occurrence still open with its rule, whose only successor is soft-deleted (seeded with SQL), is the latest: clearing it is 200 with recurrence_cleared', async () => {
    const w = await world('clrs')
    const first = await taskOf(w)
    expect((await complete(w.c, first, { scope: 'all' })).status).toBe(200)
    const second = await successorOf(first)
    expect((await reopen(w.c, first, { scope: 'all' })).status).toBe(200)
    await poolManager.get().query('UPDATE tasks SET deleted_at = clock_timestamp() WHERE id = $1', [second])
    const res = await putRecurrence(w.c, first, { recurrence: null })
    expect([res.status, res.body]).toEqual([200, { id: first, recurrence: null, seriesId: null, previousOccurrenceId: null }])
    expect((await rowOf(first)).recurrence).toBeNull()
    expect((await eventsOf(first)).filter((event) => event.type === 'recurrence_cleared').map((event) => event.actor)).toEqual([w.c.userId])
  })

  it('rec-clear-done-latest | the done last occurrence of an ended series (count, and the calendar end) keeps its rule and has no successor: clearing it is 422 NOT_CURRENT_OCCURRENCE with nothing written; after a reopen it is 200', async () => {
    const w = await world('clrd')
    const notCurrent = [422, { error: { code: 'NOT_CURRENT_OCCURRENCE' } }]
    const first = await taskOf(w, { rule: { freq: 'daily', interval: 1, end: { count: 2 } } })
    expect((await complete(w.c, first, { scope: 'all' })).status).toBe(200)
    const second = await successorOf(first)
    expect((await complete(w.c, second, { scope: 'all' })).status).toBe(200)
    expect(await successorsOf(second)).toEqual([])
    const last = await taskOf(w, { dueDate: '9999-12-31' })
    expect((await complete(w.c, last, { scope: 'all' })).status).toBe(200)
    expect(await successorsOf(last)).toEqual([])
    for (const id of [second, last]) {
      expect((await rowOf(id)).status, id).toBe('done')
      const before = await snapshot(id)
      const res = await putRecurrence(w.c, id, { recurrence: null })
      expect([res.status, res.body], id).toEqual(notCurrent)
      expect(await snapshot(id), id).toBe(before)
    }
    expect((await reopen(w.c, second, { scope: 'all' })).status).toBe(200)
    const res = await putRecurrence(w.c, second, { recurrence: null })
    expect([res.status, res.body.recurrence]).toEqual([200, null])
    expect((await rowOf(second)).recurrence).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------
// The detail's series fields (design §3.8; [a-17], [a-35]).
// ---------------------------------------------------------------------------------------------

describe('M5 PR-4a slice 3: the detail\'s series fields', () => {
  it('rec-detail | the new occurrence reads its rule, series id and previous occurrence; the earlier one names its successor to a caller who can view it, and null to an assignee removed from the new one', async () => {
    const w = await world('det')
    const first = await taskOf(w, { rule: { interval: 3, freq: 'daily' } })
    expect((await complete(w.c, first, { scope: 'all' })).status).toBe(200)
    const second = await successorOf(first)
    const fields = (body: Record<string, unknown>) => ({
      recurrence: body.recurrence, seriesId: body.seriesId, previousOccurrenceId: body.previousOccurrenceId, nextOccurrenceId: body.nextOccurrenceId,
    })
    const ofSecond = await detail(w.a, second)
    expect([ofSecond.status, fields(ofSecond.body)]).toEqual([200, { recurrence: { freq: 'daily', interval: 3 }, seriesId: first, previousOccurrenceId: first, nextOccurrenceId: null }])
    for (const who of [w.c, w.a, w.f, w.le]) {
      const ofFirst = await detail(who, first)
      expect([ofFirst.status, ofFirst.body.nextOccurrenceId], who.userId).toEqual([200, second])
      expect(ofFirst.body.seriesId, who.userId).toBeNull()
    }
    expect((await bearer(app().delete(`/api/tasks/${second}/assignees/${w.a.userId}`), w.c)).status).toBe(200)
    const removed = await detail(w.a, first)
    expect([removed.status, removed.body.nextOccurrenceId]).toEqual([200, null])
    expect((await detail(w.a, second)).status).toBe(404)
    expect((await detail(w.c, first)).body.nextOccurrenceId).toBe(second)
  })
})

// ---------------------------------------------------------------------------------------------
// Series delete (design §3.8; RULED(2026-10-09): [S17] (b)(d)).
// ---------------------------------------------------------------------------------------------

/** first (done) → second (done) → third (open). */
async function chainOfThree(w: World): Promise<[string, string, string]> {
  const first = await taskOf(w)
  expect((await complete(w.c, first, { scope: 'all' })).status).toBe(200)
  const second = await successorOf(first)
  expect((await complete(w.c, second, { scope: 'all' })).status).toBe(200)
  const third = await successorOf(second)
  return [first, second, third]
}

describe('M5 PR-4a slice 3: series delete', () => {
  it('rec-delete-later-open | deleting the first occurrence removes it and the later open one; the later done one stays and loses its rule (recurrence_cleared at the deletion instant); deletedIds lists the target first', async () => {
    const w = await world('del')
    const [first, second, third] = await chainOfThree(w)
    const res = await deleteTask(w.c, first)
    expect([res.status, res.body]).toEqual([200, { id: first, deleted: true, deletedIds: [first, third] }])
    const [a, b, c] = [await rowOf(first), await rowOf(second), await rowOf(third)]
    expect([a.deleted, b.deleted, c.deleted]).toEqual([true, false, true])
    expect(b.recurrence).toBeNull()
    expect(b.version).toBe(2)
    const deletedAt = (await q<{ us: string }>(`SELECT (extract(epoch FROM deleted_at) * 1000000)::bigint::text AS us FROM tasks WHERE id = $1`, [first]))[0].us
    for (const id of [first, third]) {
      const deleted = (await eventsOf(id)).filter((event) => event.type === 'deleted')
      expect(deleted.map((event) => [event.actor, event.atUs]), id).toEqual([[w.c.userId, deletedAt]])
    }
    const cleared = (await eventsOf(second)).filter((event) => event.type === 'recurrence_cleared')
    expect(cleared.map((event) => [event.actor, event.atUs])).toEqual([[w.c.userId, deletedAt]])
  })

  it('rec-delete-not-series | a task outside any series answers deletedIds [id] (M3 path)', async () => {
    const w = await world('delone')
    const id = await taskOf(w, { rule: null })
    const res = await deleteTask(w.c, id)
    expect([res.status, res.body]).toEqual([200, { id, deleted: true, deletedIds: [id] }])
  })

  it('rec-delete-notify | each deleted occurrence queues its own deleted for its own members: the later occurrence\'s follower gets a row naming that occurrence and its event', async () => {
    const w = await world('delntf')
    await seedOrgDingTalkIntegration(w.orgId)
    const first = await taskOf(w)
    expect((await complete(w.c, first, { scope: 'all' })).status).toBe(200)
    const second = await successorOf(first)
    const res = await withNotifications(async () => deleteTask(w.c, first))
    expect([res.status, res.body.deletedIds]).toEqual([200, [first, second]])
    for (const id of [first, second]) {
      const deleted = (await eventsOf(id)).filter((event) => event.type === 'deleted')
      expect(deleted, id).toHaveLength(1)
      const rows = await q<{ recipient_role: string; event: string; event_id: string }>(
        `SELECT recipient_role, payload->>'event' AS event, payload->>'eventId' AS event_id
           FROM task_notification_deliveries WHERE source_id = $1 AND recipient_user_id = $2`,
        [id, w.f.userId],
      )
      expect(rows.map((row) => [row.recipient_role, row.event, row.event_id]), id).toEqual([['follower', 'deleted', deleted[0].id]])
    }
  })

  it('rec-delete-comment-first | a comment write on the later occurrence that holds its row first makes the series delete wait; both then succeed, the comment before the deletion', async () => {
    const w = await world('delcf')
    const first = await taskOf(w)
    expect((await complete(w.c, first, { scope: 'all' })).status).toBe(200)
    const second = await successorOf(first)
    const seeded = await addComment({ orgId: w.orgId, actorId: w.c.userId, taskId: second, body: { body: '已有评论' } })
    const holder = await poolManager.get().getInternalPool().connect()
    let pendingDelete: Promise<unknown> | undefined
    let edit: Promise<unknown> | undefined
    try {
      if (!holder.processID) throw new Error('holder pid missing')
      await holder.query('BEGIN')
      await holder.query('SELECT id FROM task_comments WHERE id = $1 FOR UPDATE', [seeded.id])
      // The edit takes FOR KEY SHARE on the occurrence, then waits on the comment row.
      edit = updateComment({ orgId: w.orgId, actorId: w.c.userId, taskId: second, commentId: seeded.id, body: { body: '停在事务里的编辑' } })
      edit.catch(() => undefined)
      await waitUntilBlocked(holder.processID, 1)
      let settled = false
      pendingDelete = deleteTaskById({ orgId: w.orgId, actorId: w.c.userId, taskId: first }).finally(() => { settled = true })
      pendingDelete.catch(() => undefined)
      await waitForLockWaiters(2, holder.processID)
      expect(settled, 'the delete must wait for the comment write').toBe(false)
      await holder.query('COMMIT')
    } finally {
      try { await holder.query('ROLLBACK') } catch { /* committed */ }
      holder.release()
    }
    await expect(edit).resolves.toMatchObject({ id: seeded.id, body: '停在事务里的编辑' })
    await expect(pendingDelete).resolves.toEqual({ id: first, deleted: true, deletedIds: [first, second] })
    const rows = await q<{ edited_us: string; deleted_us: string }>(
      `SELECT (extract(epoch FROM c.edited_at) * 1000000)::bigint::text AS edited_us,
              (extract(epoch FROM t.deleted_at) * 1000000)::bigint::text AS deleted_us
         FROM task_comments c JOIN tasks t ON t.id = c.task_id WHERE c.id = $1`,
      [seeded.id],
    )
    expect(BigInt(rows[0].edited_us) <= BigInt(rows[0].deleted_us)).toBe(true)
  })

  it('rec-delete-first | a series delete that holds the later occurrence\'s row first makes a comment on it wait, then 404 without writing', async () => {
    const w = await world('deldf')
    const first = await taskOf(w)
    expect((await complete(w.c, first, { scope: 'all' })).status).toBe(200)
    const second = await successorOf(first)
    const holder = await poolManager.get().getInternalPool().connect()
    let pendingDelete: Promise<unknown> | undefined
    let comment: Promise<unknown> | undefined
    try {
      if (!holder.processID) throw new Error('holder pid missing')
      await holder.query('BEGIN')
      // Blocks the delete's event insert, after its row locks and its soft-delete update.
      await holder.query('LOCK TABLE task_events IN SHARE MODE')
      pendingDelete = deleteTaskById({ orgId: w.orgId, actorId: w.c.userId, taskId: first })
      pendingDelete.catch(() => undefined)
      await waitUntilBlocked(holder.processID, 1)
      comment = addComment({ orgId: w.orgId, actorId: w.c.userId, taskId: second, body: { body: '竞态评论' } })
      comment.catch(() => undefined)
      // The comment waits on the delete's row lock of the later occurrence, not on the holder.
      await waitForLockWaiters(2, holder.processID)
      await holder.query('COMMIT')
    } finally {
      try { await holder.query('ROLLBACK') } catch { /* committed */ }
      holder.release()
    }
    await expect(pendingDelete).resolves.toEqual({ id: first, deleted: true, deletedIds: [first, second] })
    await expect(comment).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
    expect(await q('SELECT id FROM task_comments WHERE task_id = $1', [second])).toEqual([])
    expect(await eventTypes(second)).not.toContain('commented')
  })

  it('rec-delete-first-target | a series delete that holds the target\'s own row first makes a comment on the target wait, then 404 without writing', async () => {
    const w = await world('deldt')
    const first = await taskOf(w)
    expect((await complete(w.c, first, { scope: 'all' })).status).toBe(200)
    const second = await successorOf(first)
    const holder = await poolManager.get().getInternalPool().connect()
    let pendingDelete: Promise<unknown> | undefined
    let comment: Promise<unknown> | undefined
    try {
      if (!holder.processID) throw new Error('holder pid missing')
      await holder.query('BEGIN')
      // Blocks the delete's event insert, after its row locks and its soft-delete update.
      await holder.query('LOCK TABLE task_events IN SHARE MODE')
      pendingDelete = deleteTaskById({ orgId: w.orgId, actorId: w.c.userId, taskId: first })
      pendingDelete.catch(() => undefined)
      await waitUntilBlocked(holder.processID, 1)
      comment = addComment({ orgId: w.orgId, actorId: w.c.userId, taskId: first, body: { body: '竞态评论' } })
      comment.catch(() => undefined)
      // The comment waits on the delete's row lock of the target, not on the holder.
      await waitForLockWaiters(2, holder.processID)
      await holder.query('COMMIT')
    } finally {
      try { await holder.query('ROLLBACK') } catch { /* committed */ }
      holder.release()
    }
    await expect(pendingDelete).resolves.toEqual({ id: first, deleted: true, deletedIds: [first, second] })
    await expect(comment).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
    expect(await q('SELECT id FROM task_comments WHERE task_id = $1', [first])).toEqual([])
    expect(await eventTypes(first)).not.toContain('commented')
  })

  it('rec-delete-first-deleted | after a series delete of the first occurrence, its surviving done successor re-armed with a count of 3 still spawns: the anchor and the ordinal read the soft-deleted first occurrence (design §2.10)', async () => {
    const w = await world('delfd')
    const first = await taskOf(w, { rule: { freq: 'daily', interval: 1, end: { count: 2 } } })
    expect((await complete(w.c, first, { scope: 'all' })).status).toBe(200)
    const second = await successorOf(first)
    expect((await complete(w.c, second, { scope: 'all' })).status).toBe(200)
    expect(await successorsOf(second)).toEqual([])
    const res = await deleteTask(w.c, first)
    expect([res.status, res.body.deletedIds]).toEqual([200, [first]])
    expect((await rowOf(second)).recurrence).toBeNull()
    expect((await reopen(w.c, second, { scope: 'all' })).status).toBe(200)
    const rule = { freq: 'daily', interval: 1, end: { count: 3 } }
    expect((await putRecurrence(w.c, second, { recurrence: rule })).status).toBe(200)
    expect((await complete(w.c, second, { scope: 'all' })).status).toBe(200)
    const third = await successorOf(second)
    expect(await rowOf(third)).toMatchObject({ due_date: '2026-11-04', recurrence_series_id: first, previous_occurrence_id: second, recurrence: rule })
    // The ordinal counts the soft-deleted first occurrence: the third one ends the count.
    await expectFlippedWithoutSpawn(third, [(await complete(w.c, third, { scope: 'all' })).status], 'first-deleted')
  })

  it('rec-delete-busy | a row lock held on the later occurrence past the bound: 409 TASK_BUSY, nothing deleted, no deleted event', async () => {
    const w = await world('delbusy')
    const first = await taskOf(w)
    expect((await complete(w.c, first, { scope: 'all' })).status).toBe(200)
    const second = await successorOf(first)
    const holder = await poolManager.get().getInternalPool().connect()
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT 1 FROM tasks WHERE id = $1 FOR KEY SHARE', [second])
      const started = Date.now()
      await expect(deleteTaskById({ orgId: w.orgId, actorId: w.c.userId, taskId: first })).rejects.toMatchObject({ status: 409, code: 'TASK_BUSY' })
      const elapsed = Date.now() - started
      expect(elapsed).toBeGreaterThanOrEqual(2500)
      expect(elapsed).toBeLessThan(8000)
    } finally {
      await holder.query('ROLLBACK')
      holder.release()
    }
    expect([(await rowOf(first)).deleted, (await rowOf(second)).deleted]).toEqual([false, false])
    for (const id of [first, second]) expect(await eventTypes(id), id).not.toContain('deleted')
  })

  it('rec-delete-children | a live subtask under the later open occurrence refuses the whole series delete: 409 HAS_CHILDREN, nothing deleted', async () => {
    const w = await world('delch')
    const first = await taskOf(w)
    expect((await complete(w.c, first, { scope: 'all' })).status).toBe(200)
    const second = await successorOf(first)
    const child = await createTask({ orgId: w.orgId, creatorId: w.c.userId, title: '子任务', assignees: [w.a.userId] })
    await setTaskParent({ orgId: w.orgId, actorId: w.c.userId, taskId: child.id, body: { parentId: second } })
    const before = [await snapshot(first), await snapshot(second)]
    const res = await deleteTask(w.c, first)
    expect([res.status, res.body]).toEqual([409, { error: { code: 'HAS_CHILDREN' } }])
    expect([await snapshot(first), await snapshot(second)]).toEqual(before)
  })

  it('rec-delete-non-creator | an assignee of every occurrence cannot delete the series: the missing-task 404, nothing deleted', async () => {
    const w = await world('delnc')
    const first = await taskOf(w)
    expect((await complete(w.c, first, { scope: 'all' })).status).toBe(200)
    const second = await successorOf(first)
    const before = [await snapshot(first), await snapshot(second)]
    const res = await deleteTask(w.a, first)
    const absent = await deleteTask(w.a, `tsk_missing_${w.stamp}`)
    expect(res.status).toBe(404)
    expect(res.text).toBe(absent.text)
    expect([await snapshot(first), await snapshot(second)]).toEqual(before)
  })
})

// ---------------------------------------------------------------------------------------------
// Gate 26 on series delete (design §3.8 step 5, §6.4).
// ---------------------------------------------------------------------------------------------

describe('M5 PR-4a slice 3: gate 26, series delete', () => {
  /** first [A, C] (done) → second [C, B] (open); F follows both. */
  async function twoAssigneeSets(w: World): Promise<[string, string]> {
    const first = await taskOf(w, { assignees: [w.a, w.c] })
    expect((await complete(w.c, first, { scope: 'all' })).status).toBe(200)
    const second = await successorOf(first)
    await removeAssignee({ orgId: w.orgId, actorId: w.c.userId, taskId: second, userId: w.a.userId })
    await addAssignee({ orgId: w.orgId, actorId: w.c.userId, taskId: second, body: { userId: w.b.userId } })
    expect((await assigneeRows(first)).map((row) => row.user_id)).toEqual(sorted([w.a.userId, w.c.userId]))
    expect((await assigneeRows(second)).map((row) => row.user_id)).toEqual(sorted([w.b.userId, w.c.userId]))
    return [first, second]
  }

  it('rec-gate26 | A only on the target, B only on the later occurrence, C on both: after the commit A, B and C each get exactly one tasks:counts-updated; the followers none', async () => {
    const w = await world('g26')
    const [first, second] = await twoAssigneeSets(w)
    const rooms: string[] = []
    setTaskCountsBroadcaster((room) => { rooms.push(room) })
    try {
      const res = await deleteTask(w.c, first)
      expect([res.status, res.body.deletedIds]).toEqual([200, [first, second]])
    } finally {
      resetTaskCountsBroadcasterForTests()
    }
    expect(sorted(rooms)).toEqual(sorted([w.a, w.b, w.c].map((who) => buildAuthenticatedUserRoom(who.userId))))
    expect(rooms).not.toContain(buildAuthenticatedUserRoom(w.f.userId))
  })

  it('rec-gate26-rollback | the same delete made to fail at COMMIT answers 500, sends nothing and deletes nothing', async () => {
    const w = await world('g26rb')
    const [first, second] = await twoAssigneeSets(w)
    const rooms: string[] = []
    const failure = await failAtCommit(second, w.stamp)
    setTaskCountsBroadcaster((room) => { rooms.push(room) })
    try {
      const res = await deleteTask(w.c, first)
      expect([res.status, res.body]).toEqual([500, { error: { code: 'INTERNAL' } }])
    } finally {
      resetTaskCountsBroadcasterForTests()
      await failure.drop()
    }
    expect(rooms).toEqual([])
    expect([(await rowOf(first)).deleted, (await rowOf(second)).deleted]).toEqual([false, false])
  })
})
