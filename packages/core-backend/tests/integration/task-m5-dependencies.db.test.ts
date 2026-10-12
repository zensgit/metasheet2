import '../helpers/assert-rbac-optional-off'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import type supertest from 'supertest'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { setTaskLockOrderRecorderForTests, type TaskLockOrderLock } from '../../src/db/task-advisory-locks'
import { poolManager } from '../../src/integration/db/connection-pool'
import { addTaskDependency, removeTaskDependency, setTaskMilestone } from '../../src/services/task-dependency-records'
import { newTaskId, newTaskListId } from '../../src/services/task-ids-runtime'
import { completeTask, createTask } from '../../src/services/task-records'
import { setTaskRecurrence } from '../../src/services/task-recurrence-records'
import { deleteTaskById, setTaskParent } from '../../src/services/task-structure'
import { dropTaskM4Fixtures, seedOrgDingTalkIntegration, seedTaskActor, signTaskToken, type SeededTaskActor } from '../helpers/task-m4-fixtures'
import { startTasksListener, tasksClient, type TasksClient, type TasksListener } from '../helpers/tasks-http-harness'

/**
 * M5 PR-4a slice 4: the milestone flag and task dependencies (design
 * task-m5-pr4a-backend-design-20261010.md §3.3, §3.4, §3.8, §4.2, §4.4, §4.7, §6.1 `M5|7`, §6.1
 * `M5|10`, §6.2 candidate M5-c, §6.2.1 the milestone, dependency, candidate, read and DepItem rows,
 * §6.4 the pending cell). Cells are named ms-… (milestone), dep-… (dependencies), cand-…
 * (candidates) and lock-… (M5|7).
 * RULED(2026-10-09): [S09] [S11] [S12] [S13]; S31's adopted M5-c cell (self, duplicate and cycle are
 * 422). ASSUMPTION(task-m5a): [a-10], [a-12], [a-18], [a-28], [a-32], [a-34], [a-36], [a-39]; D4,
 * D17, D18 (ASSUMPTION); X3 (task E's own choice, the design default). Candidate cells: gate 29 scores
 * only once a lock revision writes it into arm-set (design §6.2, §7.3); M5|7 and M5|10 are ratified
 * rows.
 *
 * HTTP goes through `tasksRouter()` on one listener per file (tests/helpers/tasks-http-harness.ts;
 * setup.integration.ts, RBAC_TOKEN_TRUST='true'). Tasks are created through the service; followers,
 * lists, edges whose timing or count a cell controls, and a second org membership are written with
 * SQL. The concurrent cross-add calls the service on two pool connections while a third holds SHARE
 * on task_dependencies, a lock that blocks writes of that table and not its reads (design §6.2,
 * opening paragraph), and releases it only once both requests wait on a lock (gate 6's settle rule).
 *
 * Instants are compared as whole microseconds since the epoch, never as text in a session zone.
 */

if (process.env.EXPECT_DB !== '1') {
  throw new Error('task-m5-dependencies.db.test.ts requires EXPECT_DB=1')
}

const JWT_SECRET = process.env.JWT_SECRET
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error('task-m5-dependencies.db.test.ts requires JWT_SECRET')
}

const ORG_PREFIX = 'org_tasks_m5dep_'
const seededUsers: string[] = []
const seededRoles: string[] = []

const HOOK_TIMEOUT_MS = 60000
/** The cells that seed 50 edges and their tasks get a budget of their own. */
const LIMIT_CELL_TIMEOUT_MS = 120000

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
  setTaskLockOrderRecorderForTests(null)
  // Edges go with the tasks (both foreign keys cascade).
  await dropTaskM4Fixtures({ orgPrefix: ORG_PREFIX, userIds: seededUsers, roleIds: seededRoles })
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

/** One org per cell: the creator C, an assignee A, a follower F, a list editor LE, a list reader LR
 * and an outsider O (active in the org, nothing to do with the task). */
interface World {
  orgId: string
  stamp: string
  c: SeededTaskActor
  a: SeededTaskActor
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
    f: await actor('f', stamp, orgId),
    le: await actor('le', stamp, orgId),
    lr: await actor('lr', stamp, orgId),
    o: await actor('o', stamp, orgId),
  }
}

async function q<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await poolManager.get().query<T>(sql, params)).rows
}

/** A list of `orgId` owned by `owner` holding `taskIds`, with `members` as `[who, 'edit' | 'read']`. */
async function listOf(orgId: string, owner: SeededTaskActor, taskIds: string[], members: Array<[SeededTaskActor, 'edit' | 'read']>): Promise<string> {
  const listId = newTaskListId()
  await q('INSERT INTO task_lists (id, org_id, name, created_by) VALUES ($1, $2, $3, $4)', [listId, orgId, '依赖', owner.userId])
  await q(`INSERT INTO task_list_members (list_id, user_id, role) VALUES ($1, $2, 'owner')`, [listId, owner.userId])
  for (const [who, role] of members) {
    await q('INSERT INTO task_list_members (list_id, user_id, role) VALUES ($1, $2, $3)', [listId, who.userId, role])
  }
  for (const taskId of taskIds) {
    await q('INSERT INTO task_list_items (list_id, task_id, org_id) VALUES ($1, $2, $3)', [listId, taskId, orgId])
  }
  return listId
}

async function follow(taskId: string, who: SeededTaskActor): Promise<void> {
  await q('INSERT INTO task_followers (task_id, user_id) VALUES ($1, $2)', [taskId, who.userId])
}

/**
 * The cell's main task T: created by C with A as its assignee, F following it, and one list holding
 * it with C as owner, LE as editor and LR as reader.
 */
async function taskOf(w: World, opts: { title?: string; dueDate?: string | null } = {}): Promise<string> {
  const dueDate = opts.dueDate ?? null
  const { id } = await createTask({
    orgId: w.orgId,
    creatorId: w.c.userId,
    title: opts.title ?? '总装',
    assignees: [w.a.userId],
    dueDate,
    timeZone: dueDate === null ? null : 'Asia/Shanghai',
  })
  await follow(id, w.f)
  await listOf(w.orgId, w.c, [id], [[w.le, 'edit'], [w.lr, 'read']])
  return id
}

/** A task of `orgId` created by `creator`, who is its only assignee (the create default). */
async function plain(orgId: string, creator: SeededTaskActor, title = '部件'): Promise<string> {
  return (await createTask({ orgId, creatorId: creator.userId, title, assignees: undefined })).id
}

/** An edge written with SQL (the cells that fix its timing or that need it without the route). */
async function seedEdge(orgId: string, predecessorId: string, successorId: string, createdAt?: string): Promise<void> {
  await q(
    `INSERT INTO task_dependencies (predecessor_id, successor_id, org_id, created_by, created_at)
     VALUES ($1, $2, $3, 'usr_seed', COALESCE($4::timestamptz, now()))`,
    [predecessorId, successorId, orgId, createdAt ?? null],
  )
}

function bearer(call: supertest.Test, who: SeededTaskActor | string): supertest.Test {
  return call.set('Authorization', `Bearer ${typeof who === 'string' ? who : who.bearer}`)
}

function patchMilestone(who: SeededTaskActor, taskId: string, body: unknown): supertest.Test {
  return bearer(app().patch(`/api/tasks/${taskId}/milestone`), who).send(body as object)
}

function getDeps(who: SeededTaskActor | string, taskId: string): supertest.Test {
  return bearer(app().get(`/api/tasks/${taskId}/dependencies`), who)
}

function postDep(who: SeededTaskActor, taskId: string, body: unknown): supertest.Test {
  return bearer(app().post(`/api/tasks/${taskId}/dependencies`), who).send(body as object)
}

function deletePredecessor(who: SeededTaskActor, taskId: string, otherId: string): supertest.Test {
  return bearer(app().delete(`/api/tasks/${taskId}/dependencies/predecessors/${otherId}`), who)
}

function deleteSuccessor(who: SeededTaskActor, taskId: string, otherId: string): supertest.Test {
  return bearer(app().delete(`/api/tasks/${taskId}/dependencies/successors/${otherId}`), who)
}

function candidates(who: SeededTaskActor, taskId: string, query: Record<string, string | string[]>): supertest.Test {
  return bearer(app().get(`/api/tasks/${taskId}/dependency-candidates`), who).query(query)
}

function detail(who: SeededTaskActor, taskId: string): supertest.Test {
  return bearer(app().get(`/api/tasks/${taskId}`), who)
}

function missingId(w: World): string {
  return `tsk_missing${w.stamp}`
}

/** Every live and soft-deleted edge touching `ids`, as `pred>succ`, sorted. */
async function edgesTouching(ids: string[]): Promise<string[]> {
  const rows = await q<{ p: string; s: string }>(
    'SELECT predecessor_id AS p, successor_id AS s FROM task_dependencies WHERE predecessor_id = ANY($1) OR successor_id = ANY($1)',
    [ids],
  )
  return rows.map((row) => `${row.p}>${row.s}`).sort()
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

/** The events of `taskId` other than `created`. */
async function changeEvents(taskId: string): Promise<EventRow[]> {
  return (await eventsOf(taskId)).filter((event) => event.type !== 'created')
}

/** Every edge row of `orgId`, live or not. */
async function orgEdgeCount(orgId: string): Promise<number> {
  return (await q<{ n: number }>('SELECT count(*)::int AS n FROM task_dependencies WHERE org_id = $1', [orgId]))[0].n
}

/** The task rows, the edges touching them and their events, as one string ("nothing was written"). */
async function snapshot(ids: string[]): Promise<string> {
  const tasks = await q('SELECT id, is_milestone, version, updated_at, status, deleted_at FROM tasks WHERE id = ANY($1) ORDER BY id COLLATE "C"', [ids])
  const edges = await q(
    `SELECT predecessor_id, successor_id, org_id, created_by, created_at FROM task_dependencies
      WHERE predecessor_id = ANY($1) OR successor_id = ANY($1) ORDER BY predecessor_id COLLATE "C", successor_id COLLATE "C"`,
    [ids],
  )
  const events = await q('SELECT id, task_id, event_type, actor_id, payload, occurred_at FROM task_events WHERE task_id = ANY($1) ORDER BY id COLLATE "C"', [ids])
  return JSON.stringify({ tasks, edges, events })
}

async function taskFacts(taskId: string): Promise<{ version: number; updatedUs: string; isMilestone: boolean }> {
  const rows = await q<{ version: number; updated_us: string; is_milestone: boolean }>(
    `SELECT version, (extract(epoch FROM updated_at) * 1000000)::bigint::text AS updated_us, is_milestone FROM tasks WHERE id = $1`,
    [taskId],
  )
  return { version: Number(rows[0].version), updatedUs: rows[0].updated_us, isMilestone: rows[0].is_milestone }
}

/** The edge's `created_at` in microseconds. */
async function edgeUs(predecessorId: string, successorId: string): Promise<string> {
  const rows = await q<{ us: string }>(
    `SELECT (extract(epoch FROM created_at) * 1000000)::bigint::text AS us FROM task_dependencies WHERE predecessor_id = $1 AND successor_id = $2`,
    [predecessorId, successorId],
  )
  return rows[0].us
}

/** Waits until `min` backends of this database, other than `exceptPid`, wait on a lock. The lane
 * runs its files one at a time (vitest.integration.config.ts: no file parallelism). */
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

/** Settles a promise into a plain outcome (the concurrency cells compare both sides). */
async function outcome(run: Promise<unknown>): Promise<{ ok: true; value: unknown } | { ok: false; status: unknown; code: unknown }> {
  return run.then(
    (value) => ({ ok: true as const, value }),
    (error: { status?: unknown; code?: unknown }) => ({ ok: false as const, status: error?.status, code: error?.code }),
  )
}

// ---------------------------------------------------------------------------------------------
// §3.3 the milestone flag (RULED(2026-10-09): [S13]; the authorization cells of §6.2.1 hang on the
// M5-c row, ASSUMPTION(task-m5a): [a-39]).
// ---------------------------------------------------------------------------------------------

describe('M5 PR-4a slice 4: PATCH /api/tasks/:id/milestone', () => {
  it('ms-set-clear | set and clear without a due date: one milestone_set / milestone_cleared each, the same value again writes nothing, version stays ([a-10]), updated_at takes the event instant; the detail reads it', async () => {
    const w = await world('msset')
    const taskId = await taskOf(w)
    const before = await taskFacts(taskId)
    const set = await patchMilestone(w.c, taskId, { isMilestone: true })
    expect([set.status, set.body]).toEqual([200, { id: taskId, isMilestone: true }])
    const afterSet = await taskFacts(taskId)
    const events = await changeEvents(taskId)
    expect(events.map((event) => [event.type, event.actor, event.payload])).toEqual([['milestone_set', w.c.userId, {}]])
    expect(afterSet).toEqual({ version: before.version, updatedUs: events[0].atUs, isMilestone: true })
    expect((await detail(w.a, taskId)).body.isMilestone).toBe(true)
    const snap = await snapshot([taskId])
    const again = await patchMilestone(w.a, taskId, { isMilestone: true })
    expect([again.status, again.body]).toEqual([200, { id: taskId, isMilestone: true }])
    expect(await snapshot([taskId])).toBe(snap)
    const cleared = await patchMilestone(w.le, taskId, { isMilestone: false })
    expect([cleared.status, cleared.body]).toEqual([200, { id: taskId, isMilestone: false }])
    expect((await changeEvents(taskId)).map((event) => [event.type, event.actor])).toEqual([
      ['milestone_set', w.c.userId], ['milestone_cleared', w.le.userId],
    ])
    expect((await taskFacts(taskId)).version).toBe(before.version)
    expect((await detail(w.a, taskId)).body.isMilestone).toBe(false)
  })

  it('ms-invalid | only a real boolean: "true", 1, null, a missing key, an array or no object at all are 422 INVALID_MILESTONE and write nothing; a caller without edit gets the 404 whatever the body', async () => {
    const w = await world('msbad')
    const taskId = await taskOf(w)
    const snap = await snapshot([taskId])
    for (const body of [{ isMilestone: 'true' }, { isMilestone: 1 }, { isMilestone: null }, {}, [true], { milestone: true }]) {
      const res = await patchMilestone(w.c, taskId, body)
      expect([res.status, res.body], JSON.stringify(body)).toEqual([422, { error: { code: 'INVALID_MILESTONE' } }])
    }
    const absent = await patchMilestone(w.o, missingId(w), { isMilestone: 'true' })
    const outsider = await patchMilestone(w.o, taskId, { isMilestone: 'true' })
    expect([outsider.status, outsider.text]).toEqual([404, absent.text])
    expect(await snapshot([taskId])).toBe(snap)
  })

  it('ms-auth | §6.2.1: C, A and LE 200; F, LR and O 404 byte-identical to a missing task, nothing written', async () => {
    const w = await world('msauth')
    const taskId = await taskOf(w)
    let value = false
    for (const who of [w.c, w.a, w.le]) {
      value = !value
      const res = await patchMilestone(who, taskId, { isMilestone: value })
      expect([res.status, res.body], who.userId).toEqual([200, { id: taskId, isMilestone: value }])
    }
    const snap = await snapshot([taskId])
    for (const who of [w.f, w.lr, w.o]) {
      const absent = await patchMilestone(who, missingId(w), { isMilestone: !value })
      const res = await patchMilestone(who, taskId, { isMilestone: !value })
      expect([res.status, res.text], who.userId).toEqual([404, absent.text])
    }
    expect(await snapshot([taskId])).toBe(snap)
  })

  it('ms-lists | GET /api/tasks and the list items read carry is_milestone after the M2 columns ([a-18])', async () => {
    const w = await world('mslist')
    const marked = await taskOf(w, { title: '里程碑' })
    const other = await plain(w.orgId, w.c, '普通')
    await setTaskMilestone({ orgId: w.orgId, actorId: w.c.userId, taskId: marked, body: { isMilestone: true } })
    const listId = await listOf(w.orgId, w.c, [marked, other], [])
    const created = await bearer(app().get('/api/tasks').query({ view: 'created' }), w.c)
    expect(created.status).toBe(200)
    const byId = new Map((created.body.items as Array<Record<string, unknown>>).map((row) => [row.id, row]))
    expect(Object.keys(byId.get(marked) ?? {})).toEqual(['id', 'title', 'status', 'completion_mode', 'created_by', 'due_at', 'is_milestone'])
    expect(byId.get(marked)?.is_milestone).toBe(true)
    expect(byId.get(other)?.is_milestone).toBe(false)
    const items = await bearer(app().get(`/api/task-lists/${listId}/items`), w.c)
    expect(items.status).toBe(200)
    const itemsById = new Map((items.body.items as Array<Record<string, unknown>>).map((row) => [row.id, row]))
    expect(Object.keys(itemsById.get(marked) ?? {})).toEqual(['id', 'title', 'status', 'completion_mode', 'created_by', 'due_at', 'is_milestone'])
    expect([itemsById.get(marked)?.is_milestone, itemsById.get(other)?.is_milestone]).toEqual([true, false])
  })

  it('ms-pending-unchanged | §6.4: milestone tasks on /api/tasks/pending keep exactly the five keys (no due date) and six keys (a due date) of gate 5', async () => {
    const w = await world('mspend')
    const undated = await taskOf(w, { title: '无截止' })
    const dated = await taskOf(w, { title: '有截止', dueDate: '2031-03-15' })
    for (const id of [undated, dated]) {
      await setTaskMilestone({ orgId: w.orgId, actorId: w.c.userId, taskId: id, body: { isMilestone: true } })
    }
    const res = await bearer(app().get('/api/tasks/pending'), w.a)
    expect(res.status).toBe(200)
    const byId = new Map((res.body.items as Array<Record<string, unknown>>).map((row) => [row.id, row]))
    expect(Object.keys(byId.get(undated) ?? {}).sort()).toEqual(['href', 'id', 'source', 'title', 'updatedAt'])
    expect(Object.keys(byId.get(dated) ?? {}).sort()).toEqual(['dueAt', 'href', 'id', 'source', 'title', 'updatedAt'])
  })
})

// ---------------------------------------------------------------------------------------------
// §3.4 dependencies (RULED(2026-10-09): [S11] [S12]; candidate M5-c, gate 29).
// ---------------------------------------------------------------------------------------------

describe('M5 PR-4a slice 4, M5-c: adding and removing an edge', () => {
  it('dep-add-both-forms | { predecessorId } adds other → :id, { successorId } adds :id → other; the row carries the org and the caller; one dependency_added on each end naming the other end, at the edge instant; no task row moves ([a-10])', async () => {
    const w = await world('add')
    const t = await taskOf(w)
    const p = await plain(w.orgId, w.a, '前置')
    const s = await plain(w.orgId, w.a, '后置')
    const before = await Promise.all([t, p, s].map(taskFacts))
    const first = await postDep(w.a, t, { predecessorId: p })
    expect([first.status, first.body]).toEqual([200, { predecessorId: p, successorId: t }])
    const second = await postDep(w.a, t, { successorId: s })
    expect([second.status, second.body]).toEqual([200, { predecessorId: t, successorId: s }])
    expect(await edgesTouching([t])).toEqual([`${p}>${t}`, `${t}>${s}`].sort())
    const rows = await q('SELECT org_id, created_by FROM task_dependencies WHERE predecessor_id = $1 AND successor_id = $2', [p, t])
    expect(rows).toEqual([{ org_id: w.orgId, created_by: w.a.userId }])
    const atFirst = await edgeUs(p, t)
    const atSecond = await edgeUs(t, s)
    expect((await changeEvents(t)).map((event) => [event.type, event.actor, event.payload, event.atUs])).toEqual([
      ['dependency_added', w.a.userId, { predecessorId: p }, atFirst],
      ['dependency_added', w.a.userId, { successorId: s }, atSecond],
    ])
    expect((await changeEvents(p)).map((event) => [event.type, event.payload, event.atUs])).toEqual([['dependency_added', { successorId: t }, atFirst]])
    expect((await changeEvents(s)).map((event) => [event.type, event.payload, event.atUs])).toEqual([['dependency_added', { predecessorId: t }, atSecond]])
    expect(await Promise.all([t, p, s].map(taskFacts))).toEqual(before)
  })

  it('dep-self | an edge from a task to itself, in either form: 422 SELF, nothing written', async () => {
    const w = await world('self')
    const t = await taskOf(w)
    const snap = await snapshot([t])
    for (const body of [{ predecessorId: t }, { successorId: t }]) {
      const res = await postDep(w.a, t, body)
      expect([res.status, res.body], JSON.stringify(body)).toEqual([422, { error: { code: 'SELF' } }])
    }
    expect(await snapshot([t])).toBe(snap)
  })

  it('dep-duplicate | the same edge again, from either end and in either form: 422 DUPLICATE (S31\'s M5-c cell), nothing written', async () => {
    const w = await world('dup')
    const t = await taskOf(w)
    const p = await plain(w.orgId, w.a)
    expect((await postDep(w.a, t, { predecessorId: p })).status).toBe(200)
    const snap = await snapshot([t, p])
    const again = await postDep(w.a, t, { predecessorId: p })
    const fromOther = await postDep(w.a, p, { successorId: t })
    expect([again.status, again.body]).toEqual([422, { error: { code: 'DUPLICATE' } }])
    expect([fromOther.status, fromOther.body]).toEqual([422, { error: { code: 'DUPLICATE' } }])
    expect(await snapshot([t, p])).toBe(snap)
  })

  it('dep-cycle | with A → B → C, adding C → A or B → A: 422 CYCLE, nothing written', async () => {
    const w = await world('cycle')
    const [a, b, c] = [await plain(w.orgId, w.a, 'A'), await plain(w.orgId, w.a, 'B'), await plain(w.orgId, w.a, 'C')]
    expect((await postDep(w.a, b, { predecessorId: a })).status).toBe(200)
    expect((await postDep(w.a, c, { predecessorId: b })).status).toBe(200)
    const snap = await snapshot([a, b, c])
    const long = await postDep(w.a, a, { predecessorId: c })
    const short = await postDep(w.a, b, { successorId: a })
    expect([long.status, long.body]).toEqual([422, { error: { code: 'CYCLE' } }])
    expect([short.status, short.body]).toEqual([422, { error: { code: 'CYCLE' } }])
    expect(await snapshot([a, b, c])).toBe(snap)
  })

  it('dep-diamond | A → B, A → C, B → D, C → D: every edge 200 (a diamond is not a cycle)', async () => {
    const w = await world('diam')
    const [a, b, c, d] = [await plain(w.orgId, w.a, 'A'), await plain(w.orgId, w.a, 'B'), await plain(w.orgId, w.a, 'C'), await plain(w.orgId, w.a, 'D')]
    for (const [pred, succ] of [[a, b], [a, c], [b, d], [c, d]]) {
      const res = await postDep(w.a, succ, { predecessorId: pred })
      expect([res.status, res.body]).toEqual([200, { predecessorId: pred, successorId: succ }])
    }
    expect(await edgesTouching([a, b, c, d])).toEqual([`${a}>${b}`, `${a}>${c}`, `${b}>${d}`, `${c}>${d}`].sort())
  })

  it('dep-remove | removing an edge from either end deletes the row and writes one dependency_removed on each end naming the other; removing it again is a no-op 200 with nothing written', async () => {
    const w = await world('rm')
    const t = await taskOf(w)
    const p = await plain(w.orgId, w.a)
    const s = await plain(w.orgId, w.a)
    expect((await postDep(w.a, t, { predecessorId: p })).status).toBe(200)
    expect((await postDep(w.a, t, { successorId: s })).status).toBe(200)
    const before = await Promise.all([t, p, s].map(taskFacts))
    const viaPredecessors = await deletePredecessor(w.a, t, p)
    expect([viaPredecessors.status, viaPredecessors.body]).toEqual([200, { predecessorId: p, successorId: t }])
    // The edge t → s, removed from its successor's side.
    const viaSuccessorsOfP = await deleteSuccessor(w.a, t, s)
    expect([viaSuccessorsOfP.status, viaSuccessorsOfP.body]).toEqual([200, { predecessorId: t, successorId: s }])
    expect(await edgesTouching([t, p, s])).toEqual([])
    const removedOnT = (await changeEvents(t)).filter((event) => event.type === 'dependency_removed')
    expect(removedOnT.map((event) => [event.actor, event.payload])).toEqual([[w.a.userId, { predecessorId: p }], [w.a.userId, { successorId: s }]])
    expect((await changeEvents(p)).filter((event) => event.type === 'dependency_removed').map((event) => event.payload)).toEqual([{ successorId: t }])
    expect((await changeEvents(s)).filter((event) => event.type === 'dependency_removed').map((event) => event.payload)).toEqual([{ predecessorId: t }])
    expect(await Promise.all([t, p, s].map(taskFacts))).toEqual(before)
    const snap = await snapshot([t, p, s])
    const again = await deletePredecessor(w.a, t, p)
    expect([again.status, again.body]).toEqual([200, { predecessorId: p, successorId: t }])
    expect(await snapshot([t, p, s])).toBe(snap)
  })

  it('dep-remove-missing | removing an edge that never existed between two visible tasks: 200 no-op in both directions, nothing written; the wrong direction of an existing edge is also a no-op that leaves it', async () => {
    const w = await world('rmnone')
    const t = await taskOf(w)
    const o = await plain(w.orgId, w.a)
    const snap = await snapshot([t, o])
    expect([(await deletePredecessor(w.a, t, o)).status, (await deleteSuccessor(w.a, t, o)).status]).toEqual([200, 200])
    expect(await snapshot([t, o])).toBe(snap)
    expect((await postDep(w.a, t, { predecessorId: o })).status).toBe(200)
    const withEdge = await snapshot([t, o])
    const wrongWay = await deleteSuccessor(w.a, t, o)
    expect([wrongWay.status, wrongWay.body]).toEqual([200, { predecessorId: t, successorId: o }])
    expect(await snapshot([t, o])).toBe(withEdge)
  })

  it('dep-invalid-body | not exactly one of predecessorId / successorId with a task-domain id: 422 INVALID_DEPENDENCY, nothing written; a caller without edit gets the 404 whatever the body ([a-12], [a-32])', async () => {
    const w = await world('badbody')
    const t = await taskOf(w)
    const p = await plain(w.orgId, w.a)
    const snap = await snapshot([t, p])
    const bodies: unknown[] = [
      {}, { predecessorId: p, successorId: p }, { predecessorId: p, note: 'x' }, { parentId: p }, [p], { predecessorId: 1 },
      { predecessorId: '' }, { predecessorId: null }, { successorId: 'tsk a' }, { predecessorId: 'tsk__a' },
    ]
    for (const body of bodies) {
      const res = await postDep(w.a, t, body)
      expect([res.status, res.body], JSON.stringify(body)).toEqual([422, { error: { code: 'INVALID_DEPENDENCY' } }])
    }
    const absent = await postDep(w.o, missingId(w), {})
    const outsider = await postDep(w.o, t, {})
    expect([outsider.status, outsider.text]).toEqual([404, absent.text])
    expect(await snapshot([t, p])).toBe(snap)
  })

  it('dep-m5-10-ids | M5|10 (id cells, write path): a task id with a leading or a trailing underscore in either body key is 422 INVALID_DEPENDENCY', async () => {
    const w = await world('m510')
    const t = await taskOf(w)
    const p = await plain(w.orgId, w.a)
    const snap = await snapshot([t, p])
    for (const key of ['predecessorId', 'successorId']) {
      for (const id of [`_${p}`, `${p}_`]) {
        const res = await postDep(w.a, t, { [key]: id })
        expect([res.status, res.body], `${key} ${id}`).toEqual([422, { error: { code: 'INVALID_DEPENDENCY' } }])
      }
    }
    expect(await snapshot([t, p])).toBe(snap)
  })

  it('dep-counterpart | a counterpart that does not exist, is soft-deleted, or is in another org (the caller is active and its creator there): 404 byte-identical to a missing task, in either form and on remove; nothing written', async () => {
    const w = await world('cp')
    const t = await taskOf(w)
    const gone = await plain(w.orgId, w.a, '已删')
    await deleteTaskById({ orgId: w.orgId, actorId: w.a.userId, taskId: gone })
    const orgB = `${ORG_PREFIX}cpb_${w.stamp}`
    await q('INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)', [w.a.userId, orgB])
    const foreign = await plain(orgB, w.a, '他组织')
    const snap = await snapshot([t, gone, foreign])
    const absent = await postDep(w.a, t, { predecessorId: newTaskId() })
    expect(absent.status).toBe(404)
    for (const other of [gone, foreign]) {
      for (const body of [{ predecessorId: other }, { successorId: other }]) {
        const res = await postDep(w.a, t, body)
        expect([res.status, res.text], JSON.stringify(body)).toEqual([404, absent.text])
      }
      expect([(await deletePredecessor(w.a, t, other)).text, (await deleteSuccessor(w.a, t, other)).text]).toEqual([absent.text, absent.text])
    }
    expect(await snapshot([t, gone, foreign])).toBe(snap)
  })

  it('dep-auth | §6.2.1: A (edit on :id) with LE on the other end 200 to add and to remove; edit on :id but only F or LR on the other end (add and remove), or only F on :id with edit on the other end: 404 byte-identical, nothing written', async () => {
    const w = await world('auth')
    const t = await taskOf(w)
    const uLe = await plain(w.orgId, w.c, '可编辑')
    await listOf(w.orgId, w.c, [uLe], [[w.a, 'edit']])
    const uF = await plain(w.orgId, w.c, '仅关注')
    await follow(uF, w.a)
    const uLr = await plain(w.orgId, w.c, '仅只读')
    await listOf(w.orgId, w.c, [uLr], [[w.a, 'read']])
    const v = await plain(w.orgId, w.c, '本任务仅关注')
    await follow(v, w.a)
    const added = await postDep(w.a, t, { predecessorId: uLe })
    expect([added.status, added.body]).toEqual([200, { predecessorId: uLe, successorId: t }])
    const removed = await deletePredecessor(w.a, t, uLe)
    expect([removed.status, removed.body]).toEqual([200, { predecessorId: uLe, successorId: t }])
    // Edges the 404 removes must leave in place.
    await seedEdge(w.orgId, uF, t)
    await seedEdge(w.orgId, uLr, t)
    await seedEdge(w.orgId, t, v)
    const all = [t, uLe, uF, uLr, v]
    const snap = await snapshot(all)
    const absent = await postDep(w.a, missingId(w), { predecessorId: uLe })
    const refused: Array<[string, supertest.Test]> = [
      ['add, other end F', postDep(w.a, t, { successorId: uF })],
      ['add, other end LR', postDep(w.a, t, { predecessorId: uLr })],
      ['add, :id only F', postDep(w.a, v, { predecessorId: uLe })],
      ['remove, other end F', deletePredecessor(w.a, t, uF)],
      ['remove, other end LR', deletePredecessor(w.a, t, uLr)],
      ['remove, :id only F', deletePredecessor(w.a, v, t)],
    ]
    for (const [label, call] of refused) {
      const res = await call
      expect([res.status, res.text], label).toEqual([404, absent.text])
    }
    expect(await snapshot(all)).toBe(snap)
  })

  it('dep-limit | D18: 50 edges on one end already; one more on that end, as predecessor or as successor: 422 LIMIT, nothing written', async () => {
    const w = await world('limit')
    const full = await plain(w.orgId, w.a, '满')
    const others: string[] = []
    for (let i = 0; i < 50; i += 1) others.push(newTaskId())
    await q(
      `INSERT INTO tasks (id, org_id, title, created_by) SELECT u.id, $2, '填充', $3 FROM unnest($1::text[]) AS u(id)`,
      [others, w.orgId, w.c.userId],
    )
    await q(
      `INSERT INTO task_dependencies (predecessor_id, successor_id, org_id, created_by)
       SELECT u.id, $2, $3, 'usr_seed' FROM unnest($1::text[]) AS u(id)`,
      [others, full, w.orgId],
    )
    const free = await plain(w.orgId, w.a, '空')
    const snap = await snapshot([full, free])
    const onFull = await postDep(w.a, full, { predecessorId: free })
    const onFree = await postDep(w.a, free, { predecessorId: full })
    expect([onFull.status, onFull.body]).toEqual([422, { error: { code: 'LIMIT' } }])
    expect([onFree.status, onFree.body]).toEqual([422, { error: { code: 'LIMIT' } }])
    expect(await snapshot([full, free])).toBe(snap)
    // Control: with one seeded edge gone the same request is accepted.
    await q('DELETE FROM task_dependencies WHERE predecessor_id = $1 AND successor_id = $2', [others[0], full])
    expect((await postDep(w.a, full, { predecessorId: free })).status).toBe(200)
  }, LIMIT_CELL_TIMEOUT_MS)

  it('dep-soft-deleted | D17: soft-deleting a counterpart, at either end, leaves the edge row and writes no dependency_removed; the reads leave it out; an edge to it is 404', async () => {
    const w = await world('soft')
    const t = await taskOf(w)
    const p = await plain(w.orgId, w.a)
    const s = await plain(w.orgId, w.a)
    expect((await postDep(w.a, t, { predecessorId: p })).status).toBe(200)
    expect((await postDep(w.a, t, { successorId: s })).status).toBe(200)
    const before = await getDeps(w.a, t)
    expect([before.body.predecessors.length, before.body.successors.length]).toEqual([1, 1])
    await deleteTaskById({ orgId: w.orgId, actorId: w.a.userId, taskId: p })
    await deleteTaskById({ orgId: w.orgId, actorId: w.a.userId, taskId: s })
    expect(await edgesTouching([t])).toEqual([`${p}>${t}`, `${t}>${s}`].sort())
    expect((await changeEvents(t)).map((event) => event.type)).toEqual(['dependency_added', 'dependency_added'])
    const read = await getDeps(w.a, t)
    expect([read.status, read.body]).toEqual([200, { predecessors: [], successors: [] }])
    expect((await detail(w.a, t)).body.dependencies).toEqual({ predecessors: [], successors: [] })
    expect((await postDep(w.a, t, { successorId: p })).status).toBe(404)
    expect((await postDep(w.a, t, { predecessorId: s })).status).toBe(404)
  })
})

describe('M5 PR-4a slice 4, M5-c: the graph the add checks read (D4, D17, ASSUMPTION)', () => {
  it('dep-cycle-far | the cycle check reads the whole org graph: with A → B → C → D, adding D → A (no edge of B → C touches either end) is 422 CYCLE, nothing written', async () => {
    const w = await world('far')
    const [a, b, c, d] = [await plain(w.orgId, w.a, 'A'), await plain(w.orgId, w.a, 'B'), await plain(w.orgId, w.a, 'C'), await plain(w.orgId, w.a, 'D')]
    for (const [pred, succ] of [[a, b], [b, c], [c, d]]) expect((await postDep(w.a, succ, { predecessorId: pred })).status).toBe(200)
    const snap = await snapshot([a, b, c, d])
    const res = await postDep(w.a, a, { predecessorId: d })
    expect([res.status, res.body]).toEqual([422, { error: { code: 'CYCLE' } }])
    expect(await orgEdgeCount(w.orgId)).toBe(3)
    expect(await snapshot([a, b, c, d])).toBe(snap)
  })

  it('dep-cycle-hidden | the cycle check reads edges whatever the caller sees: X → H → Y with H invisible to A (C wrote both edges); A adding Y → X is 422 CYCLE, nothing written', async () => {
    const w = await world('hidden')
    const x = (await createTask({ orgId: w.orgId, creatorId: w.c.userId, title: 'X', assignees: [w.a.userId] })).id
    const y = (await createTask({ orgId: w.orgId, creatorId: w.c.userId, title: 'Y', assignees: [w.a.userId] })).id
    const h = await plain(w.orgId, w.c, 'H')
    expect((await postDep(w.c, h, { predecessorId: x })).status).toBe(200)
    expect((await postDep(w.c, y, { predecessorId: h })).status).toBe(200)
    expect((await detail(w.a, h)).status).toBe(404)
    const snap = await snapshot([x, y, h])
    const res = await postDep(w.a, x, { predecessorId: y })
    expect([res.status, res.body]).toEqual([422, { error: { code: 'CYCLE' } }])
    expect(await orgEdgeCount(w.orgId)).toBe(2)
    expect(await snapshot([x, y, h])).toBe(snap)
  })

  it('dep-dead-middle | D17: an edge to a soft-deleted task is not in the cycle graph: A → B → C with B soft-deleted, adding C → A is 200', async () => {
    const w = await world('deadmid')
    const [a, b, c] = [await plain(w.orgId, w.a, 'A'), await plain(w.orgId, w.a, 'B'), await plain(w.orgId, w.a, 'C')]
    expect((await postDep(w.a, b, { predecessorId: a })).status).toBe(200)
    expect((await postDep(w.a, c, { predecessorId: b })).status).toBe(200)
    await deleteTaskById({ orgId: w.orgId, actorId: w.a.userId, taskId: b })
    const res = await postDep(w.a, a, { predecessorId: c })
    expect([res.status, res.body]).toEqual([200, { predecessorId: c, successorId: a }])
  })

  it('dep-limit-dead | D17 and D18: an edge to a soft-deleted task does not count toward the 50: 50 edges with one counterpart soft-deleted, one more edge on that end is 200', async () => {
    const w = await world('limdead')
    const full = await plain(w.orgId, w.a, '满')
    const others: string[] = []
    for (let i = 0; i < 50; i += 1) others.push(newTaskId())
    await q(
      `INSERT INTO tasks (id, org_id, title, created_by) SELECT u.id, $2, '填充', $3 FROM unnest($1::text[]) AS u(id)`,
      [others, w.orgId, w.c.userId],
    )
    await q(
      `INSERT INTO task_dependencies (predecessor_id, successor_id, org_id, created_by)
       SELECT u.id, $2, $3, 'usr_seed' FROM unnest($1::text[]) AS u(id)`,
      [others, full, w.orgId],
    )
    await deleteTaskById({ orgId: w.orgId, actorId: w.c.userId, taskId: others[0] })
    const free = await plain(w.orgId, w.a, '空')
    const res = await postDep(w.a, full, { predecessorId: free })
    expect([res.status, res.body]).toEqual([200, { predecessorId: free, successorId: full }])
    expect(await orgEdgeCount(w.orgId)).toBe(51)
  }, LIMIT_CELL_TIMEOUT_MS)
})

describe('M5 PR-4a slice 4, M5-c: the concurrent cross-add (design §6.2, opening paragraph)', () => {
  it('dep-concurrent-cross | X → Y and Y → X at once, both queued by a third connection holding SHARE on task_dependencies: exactly one 200, the other 422 CYCLE; the graph ends acyclic', async () => {
    const w = await world('cross')
    const x = await plain(w.orgId, w.a, 'X')
    const y = await plain(w.orgId, w.a, 'Y')
    const holder = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await holder.connect()
    let open = false
    let results: Array<Awaited<ReturnType<typeof outcome>>> = []
    try {
      await holder.query('BEGIN')
      open = true
      // Blocks every write of task_dependencies, not its reads (design §6.2).
      await holder.query('LOCK TABLE task_dependencies IN SHARE MODE')
      const holderPid = Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      let settled = 0
      const calls = [
        outcome(addTaskDependency({ orgId: w.orgId, actorId: w.a.userId, taskId: y, body: { predecessorId: x } })),
        outcome(addTaskDependency({ orgId: w.orgId, actorId: w.a.userId, taskId: x, body: { predecessorId: y } })),
      ].map((call) => call.finally(() => { settled += 1 }))
      // With the structure lock one request waits on the table lock and the other on the structure
      // lock; without it both have read the empty graph and wait on the table lock.
      await waitForLockWaiters(2, holderPid)
      expect(settled).toBe(0)
      await holder.query('COMMIT')
      open = false
      results = await Promise.all(calls)
    } finally {
      if (open) await holder.query('ROLLBACK').catch(() => undefined)
      await holder.end()
    }
    const wins = results.filter((result) => result.ok)
    const losses = results.filter((result) => !result.ok)
    expect([wins.length, losses.length]).toEqual([1, 1])
    expect(losses[0]).toEqual({ ok: false, status: 422, code: 'CYCLE' })
    const edges = await edgesTouching([x, y])
    expect(edges).toHaveLength(1)
    expect([`${x}>${y}`, `${y}>${x}`]).toContain(edges[0])
  })
})

describe('M5 PR-4a slice 4, M5-c: reading the dependencies', () => {
  it('dep-read-auth | §6.2.1 read side: C, A, LE, F and LR read the lists (200); O 404 byte-identical to a missing task; no org claim 404', async () => {
    const w = await world('read')
    const t = await taskOf(w)
    const p = await plain(w.orgId, w.c, '前置')
    await listOf(w.orgId, w.c, [p], [[w.a, 'read'], [w.le, 'read'], [w.f, 'read'], [w.lr, 'read']])
    expect((await postDep(w.c, t, { predecessorId: p })).status).toBe(200)
    for (const who of [w.c, w.a, w.le, w.f, w.lr]) {
      const res = await getDeps(who, t)
      expect([res.status, res.body.predecessors.map((item: { id: string }) => item.id), res.body.successors], who.userId).toEqual([200, [p], []])
    }
    const absent = await getDeps(w.o, missingId(w))
    const outsider = await getDeps(w.o, t)
    expect([outsider.status, outsider.text]).toEqual([404, absent.text])
    const noOrg = await getDeps(signTaskToken(w.c.userId, w.c.roleId, ''), t)
    expect([noOrg.status, noOrg.body]).toEqual([404, { error: { code: 'NOT_FOUND' } }])
  })

  it('dep-item | DepItem: id, title, status, dueAt, isMilestone, canRemove; a counterpart the caller cannot view is neither listed nor counted ([a-28]); canRemove only with edit on both ends ([a-12]): edit on the counterpart with only view on :id is false; the detail carries the same lists', async () => {
    const w = await world('item')
    const t = await taskOf(w)
    const pLe = (await createTask({ orgId: w.orgId, creatorId: w.c.userId, title: '可编辑前置', assignees: undefined, dueDate: '2031-03-15', timeZone: 'Asia/Shanghai' })).id
    await listOf(w.orgId, w.c, [pLe], [[w.a, 'edit']])
    await setTaskMilestone({ orgId: w.orgId, actorId: w.c.userId, taskId: pLe, body: { isMilestone: true } })
    const pF = await plain(w.orgId, w.c, '仅关注前置')
    await follow(pF, w.a)
    const pNone = await plain(w.orgId, w.c, '看不见的前置')
    const s = await plain(w.orgId, w.c, '后置')
    await listOf(w.orgId, w.c, [s], [[w.a, 'edit']])
    for (const p of [pLe, pF, pNone]) expect((await postDep(w.c, t, { predecessorId: p })).status).toBe(200)
    expect((await postDep(w.c, t, { successorId: s })).status).toBe(200)
    // Created by F, who only follows T: F edits this end and views the other. C may not edit it, so
    // the edge is written with SQL.
    const pByF = await plain(w.orgId, w.f, 'F 的前置')
    await seedEdge(w.orgId, pByF, t)
    const dueAt = (await q<{ due_at: Date }>('SELECT due_at FROM tasks WHERE id = $1', [pLe]))[0].due_at.toISOString()
    const asA = await getDeps(w.a, t)
    expect(asA.status).toBe(200)
    expect(asA.body).toEqual({
      predecessors: [
        { id: pLe, title: '可编辑前置', status: 'open', dueAt, isMilestone: true, canRemove: true },
        { id: pF, title: '仅关注前置', status: 'open', dueAt: null, isMilestone: false, canRemove: false },
      ],
      successors: [{ id: s, title: '后置', status: 'open', dueAt: null, isMilestone: false, canRemove: true }],
    })
    expect((await detail(w.a, t)).body.dependencies).toEqual(asA.body)
    const asC = await getDeps(w.c, t)
    expect(asC.body.predecessors.map((item: { id: string; canRemove: boolean }) => [item.id, item.canRemove])).toEqual([[pLe, true], [pF, true], [pNone, true]])
    // F views T and edits only the counterpart it created: listed, never removable.
    const asF = await getDeps(w.f, t)
    expect([asF.status, asF.body]).toEqual([200, {
      predecessors: [{ id: pByF, title: 'F 的前置', status: 'open', dueAt: null, isMilestone: false, canRemove: false }],
      successors: [],
    }])
    expect((await detail(w.f, t)).body.dependencies).toEqual(asF.body)
    // LR views T and none of its counterparts: both lists are empty.
    const asLr = await getDeps(w.lr, t)
    expect(asLr.body).toEqual({ predecessors: [], successors: [] })
  })

  it('dep-item-order | each list by the edge\'s created_at, then the counterpart id in byte order ([a-34])', async () => {
    const w = await world('order')
    const t = await taskOf(w)
    const ids = [await plain(w.orgId, w.c), await plain(w.orgId, w.c), await plain(w.orgId, w.c)]
    const [low, high] = [...ids.slice(0, 2)].sort()
    const early = ids[2]
    // The successors are other tasks than the predecessors, so the seeded graph stays acyclic (S12).
    const [sLow, sHigh] = [await plain(w.orgId, w.c), await plain(w.orgId, w.c)].sort()
    await seedEdge(w.orgId, high, t, '2026-10-01T00:00:00.000002Z')
    await seedEdge(w.orgId, low, t, '2026-10-01T00:00:00.000002Z')
    await seedEdge(w.orgId, early, t, '2026-10-01T00:00:00.000001Z')
    await seedEdge(w.orgId, t, sHigh, '2026-10-01T00:00:00.000001Z')
    await seedEdge(w.orgId, t, sLow, '2026-10-01T00:00:00.000003Z')
    const res = await getDeps(w.c, t)
    expect(res.body.predecessors.map((item: { id: string }) => item.id)).toEqual([early, low, high])
    expect(res.body.successors.map((item: { id: string }) => item.id)).toEqual([sHigh, sLow])
  })
})

describe('M5 PR-4a slice 4, M5-c: GET /api/tasks/:id/dependency-candidates', () => {
  /** A as assignee of T; E1 by A, E2 with A as list editor, F1 followed by A, R1 with A as list
   * reader, N1 unrelated; L1 → T already; T → D1 → D2 downstream; U1 → L1 upstream. */
  async function graph(w: World): Promise<Record<string, string>> {
    const t = await taskOf(w)
    const e1 = await plain(w.orgId, w.a, '备料 Alpha%')
    const e2 = await plain(w.orgId, w.c, '备料 beta_x')
    await listOf(w.orgId, w.c, [e2], [[w.a, 'edit']])
    const f1 = await plain(w.orgId, w.c, '仅关注')
    await follow(f1, w.a)
    const r1 = await plain(w.orgId, w.c, '仅只读')
    await listOf(w.orgId, w.c, [r1], [[w.a, 'read']])
    const n1 = await plain(w.orgId, w.c, '无关')
    const l1 = await plain(w.orgId, w.a, '已连')
    const d1 = await plain(w.orgId, w.a, '下游一')
    const d2 = await plain(w.orgId, w.a, '下游二')
    const u1 = await plain(w.orgId, w.a, 'Gamma')
    await seedEdge(w.orgId, l1, t)
    await seedEdge(w.orgId, t, d1)
    await seedEdge(w.orgId, d1, d2)
    await seedEdge(w.orgId, u1, l1)
    // The page order is updated_at DESC, id DESC: fix it.
    const order = [e1, e2, u1, d2, d1, l1, f1, r1, n1]
    for (const [i, id] of order.entries()) {
      await q(`UPDATE tasks SET updated_at = timestamptz '2026-10-01T00:00:00Z' - make_interval(secs => $2) WHERE id = $1`, [id, i])
    }
    return { t, e1, e2, f1, r1, n1, l1, d1, d2, u1 }
  }

  it('cand-direction | only tasks A may edit, never T or a task linked to it, never one that closes a cycle (X3): predecessor ⇒ E1, E2, U1 (D2 is downstream); successor ⇒ E1, E2, D2 (U1 is upstream); in the task page order; total counts them', async () => {
    const w = await world('cand')
    const g = await graph(w)
    const pred = await candidates(w.a, g.t, { direction: 'predecessor' })
    expect([pred.status, pred.body]).toEqual([200, {
      items: [
        { id: g.e1, title: '备料 Alpha%', status: 'open' },
        { id: g.e2, title: '备料 beta_x', status: 'open' },
        { id: g.u1, title: 'Gamma', status: 'open' },
      ],
      total: 3,
    }])
    const succ = await candidates(w.a, g.t, { direction: 'successor' })
    expect([succ.status, succ.body.items.map((item: { id: string }) => item.id), succ.body.total]).toEqual([200, [g.e1, g.e2, g.d2], 3])
  })

  it('cand-q | q is a literal, case-insensitive title substring: "alpha" ⇒ E1, "%" ⇒ E1 only, "_" ⇒ E2 only; blank ⇒ no filter; the limit is 200 characters (code points) once trimmed: 200 supplementary-plane characters or 200 with blanks around them pass; 201 characters or a repeated q ⇒ 422 INVALID_QUERY', async () => {
    const w = await world('candq')
    const g = await graph(w)
    const ids = async (query: Record<string, string | string[]>): Promise<unknown> => {
      const res = await candidates(w.a, g.t, { direction: 'predecessor', ...query })
      return [res.status, res.body.items?.map((item: { id: string }) => item.id)]
    }
    expect(await ids({ q: 'ALPHA' })).toEqual([200, [g.e1]])
    expect(await ids({ q: '%' })).toEqual([200, [g.e1]])
    expect(await ids({ q: '_' })).toEqual([200, [g.e2]])
    expect(await ids({ q: '   ' })).toEqual([200, [g.e1, g.e2, g.u1]])
    expect(await ids({ q: 'x'.repeat(200) })).toEqual([200, []])
    const astral = String.fromCodePoint(0x20000)
    expect(await ids({ q: astral.repeat(200) })).toEqual([200, []])
    expect(await ids({ q: ` ${'x'.repeat(200)} ` })).toEqual([200, []])
    for (const query of [{ q: 'x'.repeat(201) }, { q: astral.repeat(201) }, { q: ` ${'x'.repeat(201)} ` }, { q: ['a', 'b'] }]) {
      const res = await candidates(w.a, g.t, { direction: 'predecessor', ...query })
      expect([res.status, res.body], JSON.stringify(query).slice(0, 40)).toEqual([422, { error: { code: 'INVALID_QUERY' } }])
    }
  })

  it('cand-page | limit / offset cut the filtered list; total is the filtered count; a bad page is 422', async () => {
    const w = await world('candp')
    const g = await graph(w)
    const res = await candidates(w.a, g.t, { direction: 'predecessor', limit: '1', offset: '1' })
    expect([res.status, res.body]).toEqual([200, { items: [{ id: g.e2, title: '备料 beta_x', status: 'open' }], total: 3 }])
    const past = await candidates(w.a, g.t, { direction: 'predecessor', offset: '5' })
    expect([past.status, past.body]).toEqual([200, { items: [], total: 3 }])
    expect((await candidates(w.a, g.t, { direction: 'predecessor', limit: '0' })).body).toEqual({ error: { code: 'INVALID_LIMIT' } })
    expect((await candidates(w.a, g.t, { direction: 'predecessor', offset: '-1' })).body).toEqual({ error: { code: 'INVALID_OFFSET' } })
  })

  it('cand-order | §3.0: the 404 comes first: F (view only) with direction=x ⇒ 404 byte-identical; A without a direction or with direction=x ⇒ 422 INVALID_DIRECTION', async () => {
    const w = await world('cando')
    const t = await taskOf(w)
    const absent = await candidates(w.f, missingId(w), { direction: 'x' })
    const res = await candidates(w.f, t, { direction: 'x' })
    expect([res.status, res.text]).toEqual([404, absent.text])
    const lrRes = await candidates(w.lr, t, { direction: 'predecessor' })
    expect([lrRes.status, lrRes.text]).toEqual([404, absent.text])
    for (const query of [{}, { direction: 'x' }, { direction: ['predecessor', 'successor'] }]) {
      const bad = await candidates(w.a, t, query)
      expect([bad.status, bad.body], JSON.stringify(query)).toEqual([422, { error: { code: 'INVALID_DIRECTION' } }])
    }
    expect((await candidates(w.le, t, { direction: 'successor' })).status).toBe(200)
  })

  it('cand-two-orgs | a user active in two orgs: tasks of the other org, which it created, are never candidates', async () => {
    const w = await world('cand2')
    const t = await taskOf(w)
    const mine = await plain(w.orgId, w.a, '本组织')
    const orgB = `${ORG_PREFIX}cand2b_${w.stamp}`
    await q('INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)', [w.a.userId, orgB])
    const foreign = await plain(orgB, w.a, '他组织')
    for (const direction of ['predecessor', 'successor']) {
      const res = await candidates(w.a, t, { direction })
      const ids = res.body.items.map((item: { id: string }) => item.id)
      expect(ids, direction).toContain(mine)
      expect(ids, direction).not.toContain(foreign)
    }
  })
})

describe('M5 PR-4a slice 4, M5-c: the candidate set beyond the fixture graph ([S11], X3, D17)', () => {
  async function candidateIds(who: SeededTaskActor, taskId: string, direction: 'predecessor' | 'successor'): Promise<unknown> {
    const res = await candidates(who, taskId, { direction })
    return [res.status, (res.body.items as Array<{ id: string }> | undefined)?.map((item) => item.id).sort(), res.body.total]
  }

  it('cand-tree | [S11]: the parent and a child of the task are candidates in both directions', async () => {
    const w = await world('candtree')
    const [p, t, k] = [await plain(w.orgId, w.a, 'P'), await plain(w.orgId, w.a, 'T'), await plain(w.orgId, w.a, 'K')]
    await setTaskParent({ orgId: w.orgId, actorId: w.a.userId, taskId: t, body: { parentId: p } })
    await setTaskParent({ orgId: w.orgId, actorId: w.a.userId, taskId: k, body: { parentId: t } })
    for (const direction of ['predecessor', 'successor'] as const) {
      expect(await candidateIds(w.a, t, direction), direction).toEqual([200, [p, k].sort(), 2])
    }
  })

  it('cand-soft-deleted | a soft-deleted task is never a candidate: T, G soft-deleted, L ⇒ exactly L in both directions', async () => {
    const w = await world('canddel')
    const [t, g, l] = [await plain(w.orgId, w.a, 'T'), await plain(w.orgId, w.a, 'G'), await plain(w.orgId, w.a, 'L')]
    await deleteTaskById({ orgId: w.orgId, actorId: w.a.userId, taskId: g })
    for (const direction of ['predecessor', 'successor'] as const) {
      expect(await candidateIds(w.a, t, direction), direction).toEqual([200, [l], 1])
    }
  })

  it('cand-dead-middle | D17: an edge to a soft-deleted task is not in the exclusion graph: T → D → E with D soft-deleted, E is a predecessor candidate of T', async () => {
    const w = await world('canddead')
    const [t, d, e] = [await plain(w.orgId, w.a, 'T'), await plain(w.orgId, w.a, 'D'), await plain(w.orgId, w.a, 'E')]
    expect((await postDep(w.a, d, { predecessorId: t })).status).toBe(200)
    expect((await postDep(w.a, e, { predecessorId: d })).status).toBe(200)
    await deleteTaskById({ orgId: w.orgId, actorId: w.a.userId, taskId: d })
    expect(await candidateIds(w.a, t, 'predecessor')).toEqual([200, [e], 1])
  })

  it('cand-diamond | a walk through a finished diamond: with A → B, A → C, B → D, C → D, adding X → A is 200; then X\'s predecessor candidates are exactly the unrelated Y (A, B, C and D would each close a cycle)', async () => {
    const w = await world('canddiam')
    const [a, b, c, d] = [await plain(w.orgId, w.a, 'A'), await plain(w.orgId, w.a, 'B'), await plain(w.orgId, w.a, 'C'), await plain(w.orgId, w.a, 'D')]
    const [x, y] = [await plain(w.orgId, w.a, 'X'), await plain(w.orgId, w.a, 'Y')]
    for (const [pred, succ] of [[a, b], [a, c], [b, d], [c, d]]) expect((await postDep(w.a, succ, { predecessorId: pred })).status).toBe(200)
    const res = await postDep(w.a, a, { predecessorId: x })
    expect([res.status, res.body]).toEqual([200, { predecessorId: x, successorId: a }])
    expect(await candidateIds(w.a, x, 'predecessor')).toEqual([200, [y], 1])
  })
})

describe('M5 PR-4a slice 4: dependency and milestone events do not notify (design §4.4)', () => {
  it('dep-notify | with delivery on: adding and removing an edge and setting a milestone queue no delivery row; a completion of the same task does (control)', async () => {
    const w = await world('notify')
    await seedOrgDingTalkIntegration(w.orgId)
    const t = await taskOf(w)
    const p = await plain(w.orgId, w.c)
    await withNotifications(async () => {
      expect((await postDep(w.c, t, { predecessorId: p })).status).toBe(200)
      expect((await deletePredecessor(w.c, t, p)).status).toBe(200)
      expect((await patchMilestone(w.c, t, { isMilestone: true })).status).toBe(200)
    })
    const quiet = await q<{ n: number }>('SELECT count(*)::int AS n FROM task_notification_deliveries WHERE source_id = ANY($1)', [[t, p]])
    expect(quiet[0].n).toBe(0)
    await withNotifications(async () => {
      expect((await bearer(app().post(`/api/tasks/${t}/complete`), w.a)).status).toBe(200)
    })
    const rows = await q<{ event: string }>(`SELECT payload->>'event' AS event FROM task_notification_deliveries WHERE source_id = $1`, [t])
    expect(rows.length).toBeGreaterThan(0)
    expect(new Set(rows.map((row) => row.event))).toEqual(new Set(['completed']))
  })
})

// ---------------------------------------------------------------------------------------------
// M5|7 lock-order control, forward cells on the dependency write paths (RULED(2026-10-09): [S09];
// design §4.2, §6.1). The recorder is switched on after the fixtures.
// ---------------------------------------------------------------------------------------------

describe('M5|7 lock-order control — dependency, milestone and spawn paths', () => {
  let seen = new Map<number, TaskLockOrderLock[]>()
  const record = (): void => {
    seen = new Map()
    setTaskLockOrderRecorderForTests((instance, lock) => {
      const list = seen.get(instance) ?? []
      list.push(lock)
      seen.set(instance, list)
    })
  }

  afterEach(() => {
    setTaskLockOrderRecorderForTests(null)
  })

  /** Every sequence recorded since `record()`: exactly `n` of them, each non-empty, first item the
   * structure lock (rank 1), and nothing else. */
  function expectStructureOnly(n: number): void {
    const sequences = [...seen.values()]
    expect(sequences).toHaveLength(n)
    for (const sequence of sequences) {
      expect(sequence.length).toBeGreaterThan(0)
      expect(sequence[0]).toBe('structure')
      expect(sequence).toEqual(['structure'])
    }
  }

  async function recurring(w: World): Promise<string> {
    const { id } = await createTask({ orgId: w.orgId, creatorId: w.a.userId, title: '日报', assignees: undefined, dueDate: '2031-03-15', timeZone: 'Asia/Shanghai' })
    await setTaskRecurrence({ orgId: w.orgId, actorId: w.a.userId, taskId: id, body: { recurrence: { freq: 'daily', interval: 1 } } })
    return id
  }

  async function spawnedFrom(taskId: string): Promise<number> {
    return (await q('SELECT id FROM tasks WHERE previous_occurrence_id = $1', [taskId])).length
  }

  it('lock-dep-add | adding an edge records one sequence: [structure]', async () => {
    const w = await world('lkadd')
    const [x, y] = [await plain(w.orgId, w.a), await plain(w.orgId, w.a)]
    record()
    await addTaskDependency({ orgId: w.orgId, actorId: w.a.userId, taskId: y, body: { predecessorId: x } })
    expectStructureOnly(1)
  })

  it('lock-dep-remove | removing an edge records one sequence: [structure]', async () => {
    const w = await world('lkrm')
    const [x, y] = [await plain(w.orgId, w.a), await plain(w.orgId, w.a)]
    await addTaskDependency({ orgId: w.orgId, actorId: w.a.userId, taskId: y, body: { predecessorId: x } })
    record()
    await removeTaskDependency({ orgId: w.orgId, actorId: w.a.userId, taskId: y, otherId: x, direction: 'predecessor' })
    expectStructureOnly(1)
    expect(await edgesTouching([x, y])).toEqual([])
  })

  it('lock-milestone | setting the milestone flag records one sequence: [structure]', async () => {
    const w = await world('lkms')
    const x = await plain(w.orgId, w.a)
    record()
    await setTaskMilestone({ orgId: w.orgId, actorId: w.a.userId, taskId: x, body: { isMilestone: true } })
    expectStructureOnly(1)
  })

  it('lock-spawn | a completion that spawns the next occurrence records one sequence: [structure]', async () => {
    const w = await world('lkspawn')
    const id = await recurring(w)
    record()
    await completeTask({ orgId: w.orgId, actorId: w.a.userId, taskId: id })
    expectStructureOnly(1)
    expect(await spawnedFrom(id)).toBe(1)
  })

  it('lock-pairs | set parent ∥ add edge, set parent ∥ spawn, add edge ∥ spawn, each pair concurrent in one org: two sequences per pair, each [structure]', async () => {
    const w = await world('lkpair')
    const setParent = async (): Promise<() => Promise<unknown>> => {
      const [root, child] = [await plain(w.orgId, w.a, '根'), await plain(w.orgId, w.a, '子')]
      return () => setTaskParent({ orgId: w.orgId, actorId: w.a.userId, taskId: child, body: { parentId: root } })
    }
    const addEdge = async (): Promise<() => Promise<unknown>> => {
      const [x, y] = [await plain(w.orgId, w.a), await plain(w.orgId, w.a)]
      return () => addTaskDependency({ orgId: w.orgId, actorId: w.a.userId, taskId: y, body: { predecessorId: x } })
    }
    const spawn = async (): Promise<() => Promise<unknown>> => {
      const id = await recurring(w)
      return async () => {
        await completeTask({ orgId: w.orgId, actorId: w.a.userId, taskId: id })
        expect(await spawnedFrom(id)).toBe(1)
      }
    }
    for (const [left, right] of [[setParent, addEdge], [setParent, spawn], [addEdge, spawn]] as const) {
      const ops = [await left(), await right()]
      record()
      await Promise.all(ops.map((op) => op()))
      setTaskLockOrderRecorderForTests(null)
      expectStructureOnly(2)
    }
  })
})
