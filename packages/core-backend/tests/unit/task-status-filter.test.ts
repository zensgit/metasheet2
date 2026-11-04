/**
 * G2-core (design task-g2-core-design-20261011.md §3, §6): `GET /api/tasks?status=open|done|all`.
 *
 * `src/db/pg` is mocked: every statement is recorded with its params. The service cells check that
 * `listTasks` and `countTasks` carry the same status clause after the view condition, that `all`
 * and an absent status emit the pre-G2 text, and that an unknown status is refused before any
 * statement. The route cells mount `tasksRouter()` with auth and RBAC stubbed and check that the
 * route hands the same status to both reads and answers an unknown one like an unknown view.
 *
 * The `search|` cells cover `GET /api/tasks?q=` the same way: the clause follows the status clause,
 * list and total share it, the page binds number on after it, and an unusable value is refused
 * before any statement.
 */
import express from 'express'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildTaskScopeCondition, TASK_VIEWS } from '../../src/tasks/task-access'
import { usePinnedServer } from '../utils/pinned-server'

const state = vi.hoisted(() => ({
  calls: [] as { sql: string; params?: unknown[] }[],
  count: '0',
}))

vi.mock('../../src/db/pg', () => ({
  query: vi.fn(async (sql: string, params?: unknown[]) => {
    state.calls.push({ sql, params })
    if (sql.startsWith('SELECT count(*)')) return { rows: [{ n: state.count }] }
    return { rows: [] }
  }),
  transaction: vi.fn(async () => {
    throw new Error('no transaction expected on a list read')
  }),
}))

vi.mock('../../src/middleware/auth', () => {
  const authenticate = (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    ;(req as unknown as { user: unknown }).user = { id: 'usr_g2', sub: 'usr_g2' }
    ;(req as unknown as { authenticatedTenantId: string }).authenticatedTenantId = 'org_g2'
    next()
  }
  return { authenticate, default: authenticate }
})

vi.mock('../../src/rbac/rbac', () => ({
  rbacGuard: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}))

const { countTasks, listTasks, TASK_STATUS_FILTERS } = await import('../../src/services/task-records')

const ORG = 'org_g2'
const ME = 'usr_g2'
const CLAUSE = {
  open: " AND tasks.status = 'open'",
  done: " AND tasks.status = 'done'",
} as const

beforeEach(() => {
  state.calls = []
  state.count = '0'
})

function whereOf(sql: string): string {
  const at = sql.indexOf(' WHERE ')
  const tail = sql.slice(at + ' WHERE '.length)
  const order = tail.indexOf(' ORDER BY ')
  return order >= 0 ? tail.slice(0, order) : tail
}

describe('G2-core service: list and total share one status condition', () => {
  it('the closed set is exactly open | done | all', () => {
    expect([...TASK_STATUS_FILTERS]).toEqual(['open', 'done', 'all'])
  })

  it.each(TASK_VIEWS.flatMap((view) => (['open', 'done'] as const).map((status) => [view, status] as const)))(
    'g2core|svc|%s|%s: list and count carry the view condition followed by the same status clause',
    async (view, status) => {
      await listTasks({ orgId: ORG, actorId: ME, view, status })
      await countTasks({ orgId: ORG, actorId: ME, view, status })
      expect(state.calls).toHaveLength(2)
      const base = buildTaskScopeCondition({ view, actorParam: ME, orgParam: ORG })
      const [list, count] = state.calls
      expect(whereOf(list.sql)).toBe(`${base.sql}${CLAUSE[status]}`)
      expect(whereOf(count.sql)).toBe(`${base.sql}${CLAUSE[status]}`)
      // The bind slots stay $1/$2; the page binds follow them on the list only.
      expect(count.params).toEqual([ME, ORG])
      expect(list.params?.slice(0, 2)).toEqual([ME, ORG])
      expect(list.sql).toContain('LIMIT $3 OFFSET $4')
    },
  )

  it.each(TASK_VIEWS)('g2core|svc|%s|all: `all` and an absent status emit the pre-G2 text', async (view) => {
    await listTasks({ orgId: ORG, actorId: ME, view })
    await countTasks({ orgId: ORG, actorId: ME, view })
    await listTasks({ orgId: ORG, actorId: ME, view, status: 'all' })
    await countTasks({ orgId: ORG, actorId: ME, view, status: 'all' })
    const base = buildTaskScopeCondition({ view, actorParam: ME, orgParam: ORG })
    for (const call of state.calls) {
      expect(whereOf(call.sql)).toBe(base.sql)
      expect(call.sql).not.toContain('tasks.status')
    }
    expect(state.calls[0]).toEqual(state.calls[2])
    expect(state.calls[1]).toEqual(state.calls[3])
  })

  it.each(['', 'OPEN', 'Open', 'closed', 'undefined', 'open ', ' done', "open' OR '1'='1", 'all,open'])(
    'g2core|svc|invalid %j: 422 INVALID_STATUS from both reads, before any statement',
    async (status) => {
      await expect(listTasks({ orgId: ORG, actorId: ME, view: 'assigned', status })).rejects.toMatchObject({ status: 422, code: 'INVALID_STATUS' })
      await expect(countTasks({ orgId: ORG, actorId: ME, view: 'assigned', status })).rejects.toMatchObject({ status: 422, code: 'INVALID_STATUS' })
      expect(state.calls).toHaveLength(0)
    },
  )

  it('g2core|svc|an unknown view is still INVALID_VIEW whatever the status', async () => {
    await expect(listTasks({ orgId: ORG, actorId: ME, view: 'nope', status: 'open' })).rejects.toMatchObject({ code: 'INVALID_VIEW' })
    await expect(listTasks({ orgId: ORG, actorId: ME, view: 'nope', status: 'bad' })).rejects.toMatchObject({ code: 'INVALID_VIEW' })
    expect(state.calls).toHaveLength(0)
  })

  it('g2core|svc|the pending condition is not touched by the status filter', async () => {
    const { buildTaskPendingCondition } = await import('../../src/tasks/task-access')
    const pending = buildTaskPendingCondition({ actorParam: ME, orgParam: ORG, scope: 'all_open' })
    const base = buildTaskScopeCondition({ view: 'assigned', actorParam: ME, orgParam: ORG })
    expect(pending.sql.startsWith(base.sql)).toBe(true)
    expect(base.sql).not.toContain('tasks.status')
  })
})

const pinned = usePinnedServer()
const previousFlag = process.env.TASKS_ENABLED

beforeAll(async () => {
  process.env.TASKS_ENABLED = 'true'
  const { tasksRouter } = await import('../../src/routes/tasks')
  const router = tasksRouter()
  if (!router) throw new Error('tasks router not mounted')
  const app = express()
  app.use(express.json())
  app.use(router)
  pinned.setApp(app)
})

afterAll(() => {
  if (previousFlag === undefined) delete process.env.TASKS_ENABLED
  else process.env.TASKS_ENABLED = previousFlag
})

describe('G2-core route: GET /api/tasks?status=', () => {
  it.each(['open', 'done'] as const)('g2core|route|%s: list and total read with the same status clause', async (status) => {
    state.count = '7'
    const res = await request(pinned.url()).get('/api/tasks').query({ view: 'created', status })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ items: [], total: 7 })
    expect(state.calls).toHaveLength(2)
    for (const call of state.calls) expect(whereOf(call.sql).endsWith(CLAUSE[status])).toBe(true)
  })

  it('g2core|route|absent and `all` send the same statements', async () => {
    await request(pinned.url()).get('/api/tasks').query({ view: 'any_role' })
    const absent = state.calls
    state.calls = []
    await request(pinned.url()).get('/api/tasks').query({ view: 'any_role', status: 'all' })
    expect(state.calls).toEqual(absent)
    for (const call of absent) expect(call.sql).not.toContain('tasks.status')
  })

  it.each([
    ['unknown value', '/api/tasks?view=assigned&status=closed'],
    ['empty value', '/api/tasks?view=assigned&status='],
    ['upper case', '/api/tasks?view=assigned&status=OPEN'],
    ['repeated', '/api/tasks?view=assigned&status=open&status=done'],
    ['nested', '/api/tasks?view=assigned&status[a]=open'],
  ])('g2core|route|%s status is answered like an unknown view, with no statement', async (_label, path) => {
    const res = await request(pinned.url()).get(path)
    const badView = await request(pinned.url()).get('/api/tasks?view=not-a-view')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ items: [], degraded: true, reason: 'predicate_error' })
    expect(res.body).toEqual(badView.body)
    expect(res.status).toBe(badView.status)
    expect(state.calls).toHaveLength(0)
  })

  it('g2core|route|a bad page beats a bad status (422 INVALID_LIMIT)', async () => {
    const res = await request(pinned.url()).get('/api/tasks?view=assigned&status=closed&limit=0')
    expect(res.status).toBe(422)
    expect(res.body).toEqual({ error: { code: 'INVALID_LIMIT' } })
    expect(state.calls).toHaveLength(0)
  })

  it('g2core|route|/pending ignores a status parameter', async () => {
    await request(pinned.url()).get('/api/tasks/pending?status=done')
    const withStatus = state.calls
    state.calls = []
    await request(pinned.url()).get('/api/tasks/pending')
    expect(withStatus).toEqual(state.calls)
    expect(withStatus.length).toBeGreaterThan(0)
  })
})

const SEARCH = (n: number) => ` AND tasks.title ILIKE $${n} ESCAPE '\\'`

describe('search service: list and total share one title clause', () => {
  it.each(TASK_VIEWS)('search|svc|%s: the clause follows the view condition and the page binds number on after it', async (view) => {
    await listTasks({ orgId: ORG, actorId: ME, view, q: 'alpha', page: { limit: 10, offset: 20 } })
    await countTasks({ orgId: ORG, actorId: ME, view, q: 'alpha' })
    const base = buildTaskScopeCondition({ view, actorParam: ME, orgParam: ORG })
    const [list, count] = state.calls
    expect(whereOf(list.sql)).toBe(`${base.sql}${SEARCH(3)}`)
    expect(whereOf(count.sql)).toBe(`${base.sql}${SEARCH(3)}`)
    expect(list.sql).toContain('LIMIT $4 OFFSET $5')
    expect(list.params).toEqual([ME, ORG, '%alpha%', 10, 20])
    expect(count.params).toEqual([ME, ORG, '%alpha%'])
    // The org clause is still emitted once, by the scope builder.
    expect(list.sql.split('org_id').length).toBe(base.sql.split('org_id').length)
  })

  it.each(['open', 'done'] as const)('search|svc|%s: the clause comes after the status clause', async (status) => {
    await listTasks({ orgId: ORG, actorId: ME, view: 'created', status, q: 'alpha' })
    await countTasks({ orgId: ORG, actorId: ME, view: 'created', status, q: 'alpha' })
    const base = buildTaskScopeCondition({ view: 'created', actorParam: ME, orgParam: ORG })
    for (const call of state.calls) expect(whereOf(call.sql)).toBe(`${base.sql}${CLAUSE[status]}${SEARCH(3)}`)
  })

  it('search|svc|an absent query emits the statements it emitted before search', async () => {
    await listTasks({ orgId: ORG, actorId: ME, view: 'any_role', status: 'open' })
    await listTasks({ orgId: ORG, actorId: ME, view: 'any_role', status: 'open', q: undefined })
    expect(state.calls[0]).toEqual(state.calls[1])
    expect(state.calls[0].sql).not.toContain('ILIKE')
    expect(state.calls[0].params).toEqual([ME, ORG, 100, 0])
  })

  it.each([
    ['percent', '100%', '%100\\%%'],
    ['underscore', 'a_b', '%a\\_b%'],
    ['backslash', 'a\\b', '%a\\\\b%'],
    ['all three', '\\%_', '%\\\\\\%\\_%'],
    ['edge blanks', '  alpha  ', '%alpha%'],
    ['inner blanks', 'a  b', '%a  b%'],
    ['an edge zero-width mark', '​alpha', '%alpha%'],
    ['decomposed text', 'café', '%café%'],
    ['a quote', "a' OR '1'='1", "%a' OR '1'='1%"],
  ])('search|svc|%s: the value reaches the statement only as an escaped bind', async (_label, q, pattern) => {
    await countTasks({ orgId: ORG, actorId: ME, view: 'assigned', q })
    expect(state.calls[0].params).toEqual([ME, ORG, pattern])
    expect(state.calls[0].sql).not.toContain(q.trim() || q)
  })

  it.each([
    ['100 characters', 'x'.repeat(100)],
    ['100 astral code points', '\u{1F600}'.repeat(100)],
    ['100 characters between blanks', `  ${'x'.repeat(100)}  `],
    ['one character', 'x'],
  ])('search|svc|%s is accepted', async (_label, q) => {
    await countTasks({ orgId: ORG, actorId: ME, view: 'assigned', q })
    expect(state.calls).toHaveLength(1)
  })

  it.each([
    ['empty', ''],
    ['blanks', '   '],
    ['tabs and newlines', '\t\n'],
    ['only a zero-width mark', '​'],
    ['101 characters', 'x'.repeat(101)],
    ['101 astral code points', '\u{1F600}'.repeat(101)],
    ['U+0000', 'a\u0000b'],
    ['a lone surrogate', 'a\ud83d'],
  ])('search|svc|%s: 422 INVALID_QUERY from both reads, before any statement', async (_label, q) => {
    await expect(listTasks({ orgId: ORG, actorId: ME, view: 'assigned', q })).rejects.toMatchObject({ status: 422, code: 'INVALID_QUERY' })
    await expect(countTasks({ orgId: ORG, actorId: ME, view: 'assigned', q })).rejects.toMatchObject({ status: 422, code: 'INVALID_QUERY' })
    expect(state.calls).toHaveLength(0)
  })

  it('search|svc|the pending condition is not touched by search', async () => {
    const { buildTaskPendingCondition } = await import('../../src/tasks/task-access')
    const pending = buildTaskPendingCondition({ actorParam: ME, orgParam: ORG, scope: 'all_open' })
    expect(pending.sql).not.toContain('ILIKE')
  })
})

describe('search route: GET /api/tasks?q=', () => {
  it('search|route|list and total read with the same clause and bind', async () => {
    state.count = '3'
    const res = await request(pinned.url()).get('/api/tasks').query({ view: 'created', status: 'open', q: ' alpha ', limit: '2', offset: '4' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ items: [], total: 3 })
    expect(state.calls).toHaveLength(2)
    const base = buildTaskScopeCondition({ view: 'created', actorParam: ME, orgParam: ORG })
    for (const call of state.calls) expect(whereOf(call.sql)).toBe(`${base.sql}${CLAUSE.open}${SEARCH(3)}`)
    expect(state.calls[0].params).toEqual([ME, ORG, '%alpha%', 2, 4])
    expect(state.calls[1].params).toEqual([ME, ORG, '%alpha%'])
  })

  it('search|route|without q the statements are the ones sent before search', async () => {
    await request(pinned.url()).get('/api/tasks').query({ view: 'assigned', status: 'done' })
    expect(state.calls).toHaveLength(2)
    for (const call of state.calls) expect(call.sql).not.toContain('ILIKE')
    expect(state.calls[1].params).toEqual([ME, ORG])
  })

  it.each([
    ['empty', '/api/tasks?view=assigned&q='],
    ['blank', '/api/tasks?view=assigned&q=%20%20'],
    ['too long', `/api/tasks?view=assigned&q=${'x'.repeat(101)}`],
    ['U+0000', '/api/tasks?view=assigned&q=a%00b'],
    ['repeated', '/api/tasks?view=assigned&q=a&q=b'],
    ['bracket array', '/api/tasks?view=assigned&q[]=a'],
    ['nested', '/api/tasks?view=assigned&q[a]=b'],
  ])('search|route|%s q is 422 INVALID_QUERY in the route error shape, with no statement', async (_label, path) => {
    const res = await request(pinned.url()).get(path)
    expect(res.status).toBe(422)
    expect(res.body).toEqual({ error: { code: 'INVALID_QUERY' } })
    expect(state.calls).toHaveLength(0)
  })

  it('search|route|order of refusals: page, then view, then status, then query', async () => {
    const page = await request(pinned.url()).get('/api/tasks?view=nope&status=closed&q=&limit=0')
    expect(page.status).toBe(422)
    expect(page.body).toEqual({ error: { code: 'INVALID_LIMIT' } })
    for (const path of ['/api/tasks?view=nope&q=', '/api/tasks?view=assigned&status=closed&q=']) {
      const res = await request(pinned.url()).get(path)
      expect(res.status, path).toBe(200)
      expect(res.body, path).toEqual({ items: [], degraded: true, reason: 'predicate_error' })
    }
    expect(state.calls).toHaveLength(0)
  })

  it('search|route|/pending and /pending-count ignore a q parameter', async () => {
    for (const path of ['/api/tasks/pending', '/api/tasks/pending-count']) {
      state.calls = []
      await request(pinned.url()).get(`${path}?q=`)
      const withQ = state.calls
      state.calls = []
      await request(pinned.url()).get(path)
      expect(withQ, path).toEqual(state.calls)
      expect(withQ.length, path).toBeGreaterThan(0)
    }
  })
})
