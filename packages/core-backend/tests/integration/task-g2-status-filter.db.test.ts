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
 *
 * The `search|` cells at the end cover `GET /api/tasks?q=` on a fixture of their own, in an org of
 * its own, so the row sets above do not move.
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
    runSourceMutant(RECORDS_FILE, 'return TASK_STATUS_CLAUSE[value as TaskStatusFilter]', "return ''", `
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
      'status?: string; q?: string }): Promise<number> {\n  const cond = taskViewCondition(input)',
      "status?: string; q?: string }): Promise<number> {\n  const cond = taskViewCondition({ ...input, status: 'all' })",
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
      'const total = await countTasks({ orgId: org, actorId: actorId(req), view, status, q })',
      'const total = await countTasks({ orgId: org, actorId: actorId(req), view, q })',
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
      'const items = await listTasks({ orgId: org, actorId: actorId(req), view, status, q, page })',
      'const items = await listTasks({ orgId: org, actorId: actorId(req), view, q, page })',
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

// ---------------------------------------------------------------------------------------------
// Basic title search: `q` narrows the view and status rows to titles holding the value literally.
//
// `searchOrg` holds one task per role relation of `searcher`, for each status, under a title the
// query matches and under one it does not; `elsewhereOrg` holds tasks with the same matching title
// that `searcher` created and is assignee of, and one from a member of that org. So a cell can only
// stay green if the view arm, the status and the org clause all still apply under the query.
// ---------------------------------------------------------------------------------------------

describe('search on GET /api/tasks', () => {
  const searchOrg = `${ORG_PREFIX}${stamp}s`
  const elsewhereOrg = `${ORG_PREFIX}${stamp}x`
  const WORD = 'lanternfish'
  const STATUSES = ['open', 'done', 'all'] as const
  interface SearchRow extends FixtureRow { title: string }
  const searchRows: SearchRow[] = []
  const elsewhereIds: string[] = []
  let searcher: SeededTaskActor
  let peer: SeededTaskActor
  let outsider: SeededTaskActor
  let outsiderOwnId = ''

  async function makeSearch(title: string, input: {
    creator: SeededTaskActor
    assignees: SeededTaskActor[]
    followers?: SeededTaskActor[]
    completers?: SeededTaskActor[]
  }): Promise<string> {
    const created = await createTask({
      orgId: searchOrg,
      creatorId: input.creator.userId,
      title,
      assignees: input.assignees.map((who) => who.userId),
      completionMode: 'all',
    })
    for (const follower of input.followers ?? []) {
      await addFollower({ orgId: searchOrg, actorId: input.creator.userId, taskId: created.id, body: { userId: follower.userId } })
    }
    for (const completer of input.completers ?? []) {
      await completeTask({ orgId: searchOrg, actorId: completer.userId, taskId: created.id })
    }
    const stored = await poolManager.get().query('SELECT status FROM tasks WHERE id = $1', [created.id])
    searchRows.push({
      id: created.id,
      label: title,
      title,
      status: stored.rows[0].status as Status,
      createdBy: input.creator.userId,
      assigneeIds: input.assignees.map((who) => who.userId),
      followerIds: (input.followers ?? []).map((who) => who.userId),
    })
    return created.id
  }

  /** What the view and status list holds for `searcher`, narrowed by a plain substring test. */
  function searchExpected(view: TaskView, status: Status | 'all', holds: (title: string) => boolean): string[] {
    return searchRows
      .filter((row) => taskMatchesView(row, searcher.userId, view) && (status === 'all' || row.status === status) && holds(row.title))
      .map((row) => row.id)
      .sort()
  }

  const holdsWord = (title: string): boolean => title.toLowerCase().includes(WORD)

  beforeAll(async () => {
    searcher = await seedTaskActor({ label: 'srchme', stamp, orgId: searchOrg, codes: ['tasks:read', 'tasks:write'], admission: true })
    peer = await seedTaskActor({ label: 'srchpeer', stamp, orgId: searchOrg, codes: ['tasks:read', 'tasks:write'], admission: true })
    outsider = await seedTaskActor({ label: 'srchout', stamp, orgId: elsewhereOrg, codes: ['tasks:read', 'tasks:write'], admission: true })
    seededUsers.push(searcher.userId, peer.userId, outsider.userId)
    seededRoles.push(searcher.roleId, peer.roleId, outsider.roleId)
    for (const status of ['open', 'done'] as const) {
      const done = status === 'done'
      for (const name of [`${WORD} ${status}`, `salmon ${status}`]) {
        await makeSearch(`assignee ${name}`, { creator: peer, assignees: [searcher], completers: done ? [searcher] : [] })
        await makeSearch(`follower ${name}`, { creator: peer, assignees: [peer], followers: [searcher], completers: done ? [peer] : [] })
        await makeSearch(`creator ${name}`, { creator: searcher, assignees: [], completers: done ? [searcher] : [] })
        await makeSearch(`delegated ${name}`, { creator: searcher, assignees: [peer], completers: done ? [peer] : [] })
        await makeSearch(`unrelated ${name}`, { creator: peer, assignees: [peer], completers: done ? [peer] : [] })
      }
    }
    for (const title of ['100% done', '100 percent', 'snake_case', 'snakeXcase', 'back\\slash', 'backslash', 'UPPER Lanternfish', 'caf\u00e9 menu']) {
      await makeSearch(title, { creator: peer, assignees: [searcher] })
    }
    // The same matching title in another org: the searcher's own task there, and a member's.
    const mine = await createTask({ orgId: elsewhereOrg, creatorId: searcher.userId, title: `assignee ${WORD} open`, assignees: undefined })
    const theirs = await createTask({ orgId: elsewhereOrg, creatorId: outsider.userId, title: `assignee ${WORD} open`, assignees: undefined })
    elsewhereIds.push(mine.id, theirs.id)
    outsiderOwnId = theirs.id
  }, 180000)

  function search(query: Record<string, string>, who: SeededTaskActor = searcher) {
    return app().get('/api/tasks').query(query).set(auth(who))
  }

  it('search|fixture|the matching rows include one the searcher has no role on, and the other org holds the same title', async () => {
    const unrelated = searchRows.filter((row) => row.title.startsWith('unrelated') && holdsWord(row.title))
    expect(unrelated).toHaveLength(2)
    for (const view of TASK_VIEWS) {
      expect(searchExpected(view, 'open', holdsWord).length, view).toBeGreaterThan(0)
      expect(searchExpected(view, 'done', holdsWord).length, view).toBeGreaterThan(0)
      expect(searchExpected(view, 'all', () => true).length, view).toBeGreaterThan(searchExpected(view, 'all', holdsWord).length)
    }
    const stored = await poolManager.get().query('SELECT org_id FROM tasks WHERE id = ANY($1::text[])', [elsewhereIds])
    expect(stored.rows.map((row) => row.org_id)).toEqual([elsewhereOrg, elsewhereOrg])
  })

  it.each(TASK_VIEWS.flatMap((view) => STATUSES.map((status) => [view, status] as const)))(
    'search|%s|%s: rows = view rows ∩ status ∩ title, total = the row-set size',
    async (view, status) => {
      const want = searchExpected(view, status, holdsWord)
      const res = await search({ view, status, q: WORD })
      expect(res.status).toBe(200)
      expect(idsOf(res.body)).toEqual(want)
      expect(res.body.total).toBe(want.length)
      expect(await countTasks({ orgId: searchOrg, actorId: searcher.userId, view, status, q: WORD })).toBe(want.length)
      const listed = await listTasks({ orgId: searchOrg, actorId: searcher.userId, view, status, q: WORD })
      expect(listed.map((row) => String(row.id)).sort()).toEqual(want)
    },
  )

  it.each(TASK_VIEWS)('search|%s: no task of another org and no task without a role of the searcher, under a matching title', async (view) => {
    const res = await search({ view, status: 'all', q: WORD })
    const ids = idsOf(res.body)
    for (const id of elsewhereIds) expect(ids).not.toContain(id)
    for (const row of searchRows.filter((candidate) => candidate.title.startsWith('unrelated'))) {
      expect(ids).not.toContain(row.id)
    }
    expect(res.body.total).toBe(ids.length)
  })

  it.each(TASK_VIEWS)('search|%s: a member of the other org sees only that org\'s rows under the same query', async (view) => {
    const res = await search({ view, status: 'all', q: WORD }, outsider)
    expect(res.status).toBe(200)
    const searchOrgIds = new Set(searchRows.map((row) => row.id))
    expect(idsOf(res.body).filter((id) => searchOrgIds.has(id))).toEqual([])
    expect(idsOf(res.body).filter((id) => id !== outsiderOwnId)).toEqual([])
  })

  it.each(TASK_VIEWS)('search|%s: no match answers an empty list with total 0', async (view) => {
    const res = await search({ view, status: 'all', q: 'no-such-title-anywhere' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ items: [], total: 0 })
  })

  it('search|the match ignores case and edge blanks, and meets the stored spelling of a title', async () => {
    const want = searchExpected('assigned', 'open', holdsWord)
    expect(want).toContain(searchRows.find((row) => row.title === 'UPPER Lanternfish')?.id)
    for (const q of [WORD, WORD.toUpperCase(), `  ${WORD}  `]) {
      const res = await search({ view: 'assigned', status: 'open', q })
      expect(idsOf(res.body), q).toEqual(want)
    }
    const decomposed = await search({ view: 'assigned', q: 'cafe\u0301' })
    expect(decomposed.body.items.map((row: { title: string }) => row.title)).toEqual(['caf\u00e9 menu'])
  })

  it.each([
    ['%', ['100% done']],
    ['100%', ['100% done']],
    ['_', ['snake_case']],
    ['e_c', ['snake_case']],
    ['\\', ['back\\slash']],
    ['back\\', ['back\\slash']],
  ])('search|escape|%j matches its characters literally', async (q, titles) => {
    const res = await search({ view: 'assigned', status: 'open', q })
    expect(res.status).toBe(200)
    expect(res.body.items.map((row: { title: string }) => row.title).sort()).toEqual(titles)
    expect(res.body.total).toBe(titles.length)
  })

  it.each([
    ['q only', { view: 'any_role', q: WORD }, 'all'],
    ['q and status', { view: 'any_role', status: 'done', q: WORD }, 'done'],
  ] as const)('search|paging|%s: pages walk the row set in order, each with the same total', async (_label, query, status) => {
    const want = searchExpected('any_role', status, holdsWord)
    expect(want.length).toBeGreaterThan(2)
    const whole = await search({ ...query })
    const walked: string[] = []
    for (let offset = 0; offset < want.length + 1; offset += 2) {
      const res = await search({ ...query, limit: '2', offset: String(offset) })
      expect(res.status).toBe(200)
      expect(res.body.total).toBe(want.length)
      expect(res.body.items.length).toBe(Math.min(2, Math.max(0, want.length - offset)))
      walked.push(...res.body.items.map((row: { id: string }) => row.id))
    }
    expect(walked).toEqual(whole.body.items.map((row: { id: string }) => row.id))
    expect([...walked].sort()).toEqual(want)
  })

  it('search|invalid: blank, too long, repeated or nested q is 422 INVALID_QUERY', async () => {
    const accepted = await search({ view: 'assigned', q: 'x'.repeat(100) })
    expect(accepted.status).toBe(200)
    expect(accepted.body).toEqual({ items: [], total: 0 })
    const astral = await search({ view: 'assigned', q: '\u{1F600}'.repeat(100) })
    expect(astral.status).toBe(200)
    for (const path of [
      '/api/tasks?view=assigned&q=',
      '/api/tasks?view=assigned&q=%20%09',
      `/api/tasks?view=assigned&q=${'x'.repeat(101)}`,
      '/api/tasks?view=assigned&q=a%00b',
      '/api/tasks?view=assigned&q=a&q=b',
      '/api/tasks?view=assigned&q[a]=b',
    ]) {
      const res = await app().get(path).set(auth(searcher))
      expect(res.status, path).toBe(422)
      expect(res.body, path).toEqual({ error: { code: 'INVALID_QUERY' } })
    }
  })

  it('search|a viewer without the task read code is refused with or without q', async () => {
    const bare = await seedTaskActor({ label: 'srchbare', stamp, orgId: searchOrg, codes: [], admission: false })
    seededUsers.push(bare.userId)
    seededRoles.push(bare.roleId)
    const withQ = await search({ view: 'assigned', q: WORD }, bare)
    const without = await search({ view: 'assigned' }, bare)
    expect(withQ.status).toBe(403)
    expect(withQ.body).toEqual({ error: 'Insufficient permissions' })
    expect(without.status).toBe(403)
    expect(without.body).toEqual(withQ.body)
  })

  it('search|/pending takes no q: the same rows with and without it', async () => {
    const plain = await app().get('/api/tasks/pending').set(auth(searcher))
    const withQ = await app().get('/api/tasks/pending').query({ q: 'no-such-title-anywhere' }).set(auth(searcher))
    expect(withQ.status).toBe(200)
    expect(withQ.body).toEqual(plain.body)
    expect(plain.body.items.length).toBeGreaterThan(0)
  })

  it('search|nc5|the route passing q to the list only: the HTTP total goes red', () => {
    const want = searchExpected('any_role', 'all', holdsWord)
    runSourceMutant(
      ROUTES_FILE,
      'const total = await countTasks({ orgId: org, actorId: actorId(req), view, status, q })',
      'const total = await countTasks({ orgId: org, actorId: actorId(req), view, status })',
      `
      process.env.TASKS_ENABLED = 'true'
      const express = (await import(${JSON.stringify(EXPRESS_PATH)})).default
      const request = (await import(${JSON.stringify(SUPERTEST_PATH)})).default
      const { tasksRouter } = await import(${JSON.stringify(ROUTES_FILE)})
      const server = express()
      server.use(express.json())
      server.use(tasksRouter())
      const res = await request(server).get('/api/tasks?view=any_role&status=all&q=${WORD}').set('Authorization', 'Bearer ' + ${JSON.stringify(searcher.bearer)})
      const got = res.body.items.map((row) => row.id).sort()
      const want = ${JSON.stringify(want)}
      const listOk = JSON.stringify(got) === JSON.stringify(want)
      const totalRed = res.body.total !== want.length
      console.log(JSON.stringify({ nc5: 'red', status: res.status, listOk, totalRed, total: res.body.total }))
      process.exit(res.status === 200 && listOk && totalRed ? 0 : 1)
    `,
      {},
      { unique: true },
    )
  }, 180000)

  it('search|nc6|the value reaching the pattern unescaped: a percent sign matches every row', () => {
    const want = searchExpected('assigned', 'open', (title) => title.includes('%'))
    runSourceMutant(
      RECORDS_FILE,
      "return term.replace(/[\\\\%_]/g, '\\\\$&')",
      'return term',
      `
      const { listTasks } = await import(${JSON.stringify(RECORDS_FILE)})
      const rows = await listTasks({ orgId: ${JSON.stringify(searchOrg)}, actorId: ${JSON.stringify(searcher.userId)}, view: 'assigned', status: 'open', q: '%' })
      const got = rows.map((row) => row.id).sort()
      const want = ${JSON.stringify(want)}
      const red = JSON.stringify(got) !== JSON.stringify(want)
      console.log(JSON.stringify({ nc6: 'red', red, got: got.length }))
      process.exit(red ? 0 : 1)
    `,
      {},
      { unique: true },
    )
  }, 180000)

  it('search|nc7|dropping the title clause: the query no longer narrows the list', () => {
    const want = searchExpected('assigned', 'open', holdsWord)
    runSourceMutant(
      RECORDS_FILE,
      "${statusClause} AND tasks.title ILIKE $${params.length} ESCAPE '\\\\'`, params }",
      '${statusClause}`, params: cond.params }',
      `
      const { listTasks } = await import(${JSON.stringify(RECORDS_FILE)})
      const rows = await listTasks({ orgId: ${JSON.stringify(searchOrg)}, actorId: ${JSON.stringify(searcher.userId)}, view: 'assigned', status: 'open', q: ${JSON.stringify(WORD)} })
      const got = rows.map((row) => row.id).sort()
      const want = ${JSON.stringify(want)}
      const red = JSON.stringify(got) !== JSON.stringify(want)
      console.log(JSON.stringify({ nc7: 'red', red, got: got.length }))
      process.exit(red ? 0 : 1)
    `,
      {},
      { unique: true },
    )
  }, 180000)
})
