import '../helpers/assert-rbac-optional-off'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { poolManager } from '../../src/integration/db/connection-pool'
import { completeTask, countPendingList, countTasks, createTask, listTasks } from '../../src/services/task-records'
import { addFollower } from '../../src/services/task-structure'
import { TASK_VIEWS, taskMatchesView, type TaskView, type TaskViewRow } from '../../src/tasks/task-access'
import { dropTaskM4Fixtures, runSourceMutant, seedTaskActor, type SeededTaskActor } from '../helpers/task-m4-fixtures'
import { startTasksListener, tasksClient, type TasksClient, type TasksListener } from '../helpers/tasks-http-harness'

/**
 * G2-core (design task-g2-core-design-20261011.md §3, §6).
 * RULED(2026-10-09): `GET /api/tasks?status=open|done|all` is orthogonal to the five views, and the
 * list and its total share one condition. ASSUMPTION(task-g2): an absent status is `all`.
 *
 * One org, two actors (`me`, `other`). For each status the fixture holds one task per role
 * relation of `me` (assignee only, follower only, creator with no assignee, creator with another
 * assignee) plus one task `me` has no role on; `done` rows are reached through `completeTask`. One
 * more all-mode task has `me` and `other` as assignees with only `me` completed: the task stays
 * `open` (the filter reads `tasks.status`, not the viewer's own row).
 *
 * Expected row sets are `taskMatchesView` over the fixture rows, intersected with the row status
 * read back from the table. Test names start with `g2core|`, never with the gate-19 prefix.
 * HTTP goes through `tasksRouter()` on one express listener (tests/helpers/tasks-http-harness.ts).
 */

if (process.env.EXPECT_DB !== '1') {
  throw new Error('task-g2-status-filter.db.test.ts requires EXPECT_DB=1')
}

const ORG_PREFIX = 'org_tasks_g2status_'
const seededUsers: string[] = []
const seededRoles: string[] = []

const req = createRequire(import.meta.url)
const EXPRESS_PATH = req.resolve('express')
const SUPERTEST_PATH = req.resolve('supertest')
const ROUTES_FILE = new URL('../../src/routes/tasks.ts', import.meta.url).pathname
const RECORDS_FILE = new URL('../../src/services/task-records.ts', import.meta.url).pathname

type Status = 'open' | 'done'

interface FixtureRow extends TaskViewRow {
  id: string
  label: string
  status: Status
}

const stamp = randomUUID().replace(/-/g, '').slice(0, 12)
const orgId = `${ORG_PREFIX}${stamp}`
let me: SeededTaskActor
let other: SeededTaskActor
const rows: FixtureRow[] = []
let listener: TasksListener | undefined

function app(): TasksClient {
  return tasksClient(listener?.baseUrl ?? '')
}

function auth(who: SeededTaskActor): { Authorization: string } {
  return { Authorization: `Bearer ${who.bearer}` }
}

async function make(label: string, input: {
  creator: SeededTaskActor
  assignees: SeededTaskActor[]
  followers?: SeededTaskActor[]
  completers?: SeededTaskActor[]
}): Promise<void> {
  const created = await createTask({
    orgId,
    creatorId: input.creator.userId,
    title: `g2 ${label}`,
    assignees: input.assignees.map((who) => who.userId),
    completionMode: 'all',
  })
  for (const follower of input.followers ?? []) {
    await addFollower({ orgId, actorId: input.creator.userId, taskId: created.id, body: { userId: follower.userId } })
  }
  for (const completer of input.completers ?? []) {
    await completeTask({ orgId, actorId: completer.userId, taskId: created.id })
  }
  const stored = await poolManager.get().query('SELECT status FROM tasks WHERE id = $1', [created.id])
  rows.push({
    id: created.id,
    label,
    status: stored.rows[0].status as Status,
    createdBy: input.creator.userId,
    assigneeIds: input.assignees.map((who) => who.userId),
    followerIds: (input.followers ?? []).map((who) => who.userId),
  })
}

/** `taskMatchesView` over the fixture, intersected with the stored status (`all` = no filter). */
function expected(view: TaskView, status: Status | 'all'): string[] {
  return rows
    .filter((row) => taskMatchesView(row, me.userId, view) && (status === 'all' || row.status === status))
    .map((row) => row.id)
    .sort()
}

function idsOf(body: { items: { id: string }[] }): string[] {
  return body.items.map((row) => row.id).sort()
}

beforeAll(async () => {
  listener = await startTasksListener()
  me = await seedTaskActor({ label: 'g2me', stamp, orgId, codes: ['tasks:read', 'tasks:write'], admission: true })
  other = await seedTaskActor({ label: 'g2other', stamp, orgId, codes: ['tasks:read', 'tasks:write'], admission: true })
  seededUsers.push(me.userId, other.userId)
  seededRoles.push(me.roleId, other.roleId)
  for (const status of ['open', 'done'] as const) {
    const done = status === 'done'
    await make(`assignee-${status}`, { creator: other, assignees: [me], completers: done ? [me] : [] })
    await make(`follower-${status}`, { creator: other, assignees: [other], followers: [me], completers: done ? [other] : [] })
    await make(`creator-${status}`, { creator: me, assignees: [], completers: done ? [me] : [] })
    await make(`delegated-${status}`, { creator: me, assignees: [other], completers: done ? [other] : [] })
    await make(`none-${status}`, { creator: other, assignees: [other], completers: done ? [other] : [] })
  }
  await make('self-completed', { creator: other, assignees: [me, other], completers: [me] })
}, 120000)

afterAll(async () => {
  await dropTaskM4Fixtures({ orgPrefix: ORG_PREFIX, userIds: seededUsers, roleIds: seededRoles })
  await listener?.close()
})

describe('G2-core fixture', () => {
  it('g2core|fixture|every row reached the intended status; the self-completed all-mode task is still open', () => {
    for (const row of rows) {
      const want: Status = row.label.endsWith('-done') ? 'done' : 'open'
      expect(row.status, row.label).toBe(want)
    }
    expect(rows).toHaveLength(11)
  })

  it.each(TASK_VIEWS)('g2core|fixture|%s has at least one open and one done row (so each status cell can tell)', (view) => {
    expect(expected(view, 'open').length, view).toBeGreaterThan(0)
    expect(expected(view, 'done').length, view).toBeGreaterThan(0)
  })
})

describe('G2-core status filter on GET /api/tasks', () => {
  it.each(TASK_VIEWS.flatMap((view) => (['open', 'done'] as const).map((status) => [view, status] as const)))(
    'g2core|%s|%s: rows = view rows ∩ status, total = the row-set size (paged and unpaged)',
    async (view, status) => {
      const want = expected(view, status)
      const res = await app().get('/api/tasks').query({ view, status }).set(auth(me))
      expect(res.status).toBe(200)
      expect(idsOf(res.body)).toEqual(want)
      expect(res.body.total).toBe(want.length)
      // The view rows without a status filter, intersected here, give the same set.
      const all = await app().get('/api/tasks').query({ view }).set(auth(me))
      const byStatus = new Map(rows.map((row) => [row.id, row.status]))
      expect(idsOf(all.body).filter((id) => byStatus.get(id) === status)).toEqual(want)
      const first = await app().get('/api/tasks').query({ view, status, limit: '1' }).set(auth(me))
      expect(first.body.items).toHaveLength(1)
      expect(first.body.total).toBe(want.length)
      expect(await countTasks({ orgId, actorId: me.userId, view, status })).toBe(want.length)
      const listed = await listTasks({ orgId, actorId: me.userId, view, status })
      expect(listed.every((row) => row.status === status)).toBe(true)
    },
  )

  it.each(TASK_VIEWS)('g2core|%s|all: `all` and an absent status answer the same items and total as before G2', async (view) => {
    const want = expected(view, 'all')
    const absent = await app().get('/api/tasks').query({ view }).set(auth(me))
    const all = await app().get('/api/tasks').query({ view, status: 'all' }).set(auth(me))
    expect(absent.status).toBe(200)
    expect(idsOf(absent.body)).toEqual(want)
    expect(absent.body.total).toBe(want.length)
    expect(all.body).toEqual(absent.body)
    expect(want.length).toBe(expected(view, 'open').length + expected(view, 'done').length)
  })

  it('g2core|assigned|self-completed: an all-mode task only I completed is under open, not done, and is not pending', async () => {
    const self = rows.find((row) => row.label === 'self-completed')
    expect(self).toBeDefined()
    const open = await app().get('/api/tasks').query({ view: 'assigned', status: 'open' }).set(auth(me))
    const done = await app().get('/api/tasks').query({ view: 'assigned', status: 'done' }).set(auth(me))
    expect(idsOf(open.body)).toContain(self?.id)
    expect(idsOf(done.body)).not.toContain(self?.id)
    const pending = await app().get('/api/tasks/pending').set(auth(me))
    expect(idsOf(pending.body)).not.toContain(self?.id)
    // /pending is not changed by G2-core: only the open assignee row I have not completed.
    const assigneeOpen = rows.find((row) => row.label === 'assignee-open')
    expect(idsOf(pending.body)).toEqual([assigneeOpen?.id])
    expect(await countPendingList({ orgId, actorId: me.userId })).toBe(1)
  })

  it('g2core|invalid: an unknown, empty, repeated or wrongly cased status is answered like an unknown view', async () => {
    const badView = await app().get('/api/tasks').query({ view: 'not-a-view' }).set(auth(me))
    expect(badView.status).toBe(200)
    expect(badView.body).toEqual({ items: [], degraded: true, reason: 'predicate_error' })
    for (const path of [
      '/api/tasks?view=assigned&status=closed',
      '/api/tasks?view=assigned&status=',
      '/api/tasks?view=assigned&status=OPEN',
      '/api/tasks?view=assigned&status=open&status=done',
    ]) {
      const res = await app().get(path).set(auth(me))
      expect(res.status, path).toBe(badView.status)
      expect(res.body, path).toEqual(badView.body)
    }
    const badPage = await app().get('/api/tasks?view=assigned&status=closed&limit=0').set(auth(me))
    expect(badPage.status).toBe(422)
    expect(badPage.body).toEqual({ error: { code: 'INVALID_LIMIT' } })
  })

  it('g2core|other actor: the filter does not widen another actor\'s view', async () => {
    const res = await app().get('/api/tasks').query({ view: 'assigned', status: 'done' }).set(auth(other))
    const want = rows
      .filter((row) => row.assigneeIds.includes(other.userId) && row.status === 'done')
      .map((row) => row.id)
      .sort()
    expect(idsOf(res.body)).toEqual(want)
    expect(res.body.total).toBe(want.length)
  })
})

// ---------------------------------------------------------------------------------------------
// Negative controls. Each child exits 0 when the mutant makes a positive cell above go red.
// ---------------------------------------------------------------------------------------------

describe('G2-core negative controls (source mutants)', () => {
  const view: TaskView = 'any_role'

  it('g2core|nc1|deleting the status clause: the done list carries open rows and the total is wrong', () => {
    const want = expected(view, 'done')
    runSourceMutant(RECORDS_FILE, "return value === 'all' ? '' : ` AND tasks.status = '${value}'`", "return ''", `
      const { listTasks, countTasks } = await import(${JSON.stringify(RECORDS_FILE)})
      const rows = await listTasks({ orgId: ${JSON.stringify(orgId)}, actorId: ${JSON.stringify(me.userId)}, view: ${JSON.stringify(view)}, status: 'done' })
      const total = await countTasks({ orgId: ${JSON.stringify(orgId)}, actorId: ${JSON.stringify(me.userId)}, view: ${JSON.stringify(view)}, status: 'done' })
      const got = rows.map((row) => row.id).sort()
      const want = ${JSON.stringify(want)}
      const listRed = JSON.stringify(got) !== JSON.stringify(want)
      const totalRed = total !== want.length
      console.log(JSON.stringify({ nc1: 'red', listRed, totalRed }))
      process.exit(listRed && totalRed ? 0 : 1)
    `, {}, { unique: true })
  }, 180000)

  it('g2core|nc2|the status reaching the list but not the total: the list stays right, the total goes red', () => {
    const want = expected(view, 'open')
    runSourceMutant(
      RECORDS_FILE,
      'status?: string }): Promise<number> {\n  const cond = taskViewCondition(input)',
      "status?: string }): Promise<number> {\n  const cond = taskViewCondition({ ...input, status: 'all' })",
      `
      const { listTasks, countTasks } = await import(${JSON.stringify(RECORDS_FILE)})
      const rows = await listTasks({ orgId: ${JSON.stringify(orgId)}, actorId: ${JSON.stringify(me.userId)}, view: ${JSON.stringify(view)}, status: 'open' })
      const total = await countTasks({ orgId: ${JSON.stringify(orgId)}, actorId: ${JSON.stringify(me.userId)}, view: ${JSON.stringify(view)}, status: 'open' })
      const got = rows.map((row) => row.id).sort()
      const want = ${JSON.stringify(want)}
      const listOk = JSON.stringify(got) === JSON.stringify(want)
      const totalRed = total !== want.length
      console.log(JSON.stringify({ nc2: 'red', listOk, totalRed, total }))
      process.exit(listOk && totalRed ? 0 : 1)
    `,
      {},
      { unique: true },
    )
  }, 180000)

  it('g2core|nc3|the route passing the status to the list only: the HTTP total goes red', () => {
    const want = expected(view, 'done')
    runSourceMutant(
      ROUTES_FILE,
      'const total = await countTasks({ orgId: org, actorId: actorId(req), view, status })',
      'const total = await countTasks({ orgId: org, actorId: actorId(req), view })',
      `
      process.env.TASKS_ENABLED = 'true'
      const express = (await import(${JSON.stringify(EXPRESS_PATH)})).default
      const request = (await import(${JSON.stringify(SUPERTEST_PATH)})).default
      const { tasksRouter } = await import(${JSON.stringify(ROUTES_FILE)})
      const server = express()
      server.use(express.json())
      server.use(tasksRouter())
      const res = await request(server).get('/api/tasks?view=${view}&status=done').set('Authorization', 'Bearer ' + ${JSON.stringify(me.bearer)})
      const got = res.body.items.map((row) => row.id).sort()
      const want = ${JSON.stringify(want)}
      const listOk = JSON.stringify(got) === JSON.stringify(want)
      const totalRed = res.body.total !== want.length
      console.log(JSON.stringify({ nc3: 'red', status: res.status, listOk, totalRed, total: res.body.total }))
      process.exit(res.status === 200 && listOk && totalRed ? 0 : 1)
    `,
      {},
      { unique: true },
    )
  }, 180000)

  it('g2core|nc4|the route dropping the status entirely: the done HTTP list carries open rows', () => {
    const want = expected(view, 'done')
    runSourceMutant(
      ROUTES_FILE,
      'const items = await listTasks({ orgId: org, actorId: actorId(req), view, status, page })',
      'const items = await listTasks({ orgId: org, actorId: actorId(req), view, page })',
      `
      process.env.TASKS_ENABLED = 'true'
      const express = (await import(${JSON.stringify(EXPRESS_PATH)})).default
      const request = (await import(${JSON.stringify(SUPERTEST_PATH)})).default
      const { tasksRouter } = await import(${JSON.stringify(ROUTES_FILE)})
      const server = express()
      server.use(express.json())
      server.use(tasksRouter())
      const res = await request(server).get('/api/tasks?view=${view}&status=done').set('Authorization', 'Bearer ' + ${JSON.stringify(me.bearer)})
      const got = res.body.items.map((row) => row.id).sort()
      const want = ${JSON.stringify(want)}
      const listRed = JSON.stringify(got) !== JSON.stringify(want)
      console.log(JSON.stringify({ nc4: 'red', status: res.status, listRed }))
      process.exit(res.status === 200 && listRed ? 0 : 1)
    `,
      {},
      { unique: true },
    )
  }, 180000)
})
