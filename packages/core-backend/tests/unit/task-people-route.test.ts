/**
 * Task usability package 1b: the two people routes in `routes/tasks.ts` over a stubbed service —
 * the org check before anything else, the query bounds, the answer shapes, the per-user limit and
 * the error envelope. The reads themselves are in tests/integration/task-people.db.test.ts.
 */
import express from 'express'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'

const people = vi.hoisted(() => ({
  searchOrgPeople: vi.fn(),
  resolveOrgPeople: vi.fn(),
  loadTaskPeople: vi.fn(),
}))

// The signed-in user and the org claim come from two test headers; a request without the org header
// is a session without an org.
vi.mock('../../src/middleware/auth', () => {
  const authenticate = (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const user = String(req.header('x-test-user') ?? 'usr_people_a')
    ;(req as unknown as { user: unknown }).user = { id: user, sub: user }
    const org = req.header('x-test-org')
    if (org) (req as unknown as { authenticatedTenantId: string }).authenticatedTenantId = org
    next()
  }
  return { authenticate, default: authenticate }
})

vi.mock('../../src/rbac/rbac', () => ({
  rbacGuard: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}))

vi.mock('../../src/services/task-people', () => ({
  searchOrgPeople: (...args: unknown[]) => people.searchOrgPeople(...args),
  resolveOrgPeople: (...args: unknown[]) => people.resolveOrgPeople(...args),
  loadTaskPeople: (...args: unknown[]) => people.loadTaskPeople(...args),
}))

const ORG = 'org_people_route'
const NO_ORG_TEXT = JSON.stringify({ error: { code: 'ORG_MISSING' } })
const INVALID_TEXT = JSON.stringify({ error: { code: 'PEOPLE_QUERY_INVALID' } })

const pinned = usePinnedServer()
const previousFlag = process.env.TASKS_ENABLED
let routes: typeof import('../../src/routes/tasks')
let router: express.Router | null = null

beforeAll(async () => {
  process.env.TASKS_ENABLED = 'true'
  routes = await import('../../src/routes/tasks')
})

afterAll(() => {
  if (previousFlag === undefined) delete process.env.TASKS_ENABLED
  else process.env.TASKS_ENABLED = previousFlag
})

beforeEach(() => {
  for (const fn of Object.values(people)) fn.mockReset()
  people.searchOrgPeople.mockResolvedValue({ items: [], hasMore: false })
  people.resolveOrgPeople.mockResolvedValue([])
  people.loadTaskPeople.mockResolvedValue({})
  // A fresh router per cell, so each cell starts with its own search counter.
  router = routes.tasksRouter()
  if (!router) throw new Error('tasks router not mounted')
  const app = express()
  app.use(express.json())
  app.use(router)
  pinned.setApp(app)
})

afterEach(() => {
  routes.disposeTasksRouter(router)
  router = null
})

function getPeople(path: string, opts: { org?: string | null; user?: string } = {}) {
  const call = request(pinned.url()).get(path).set('x-test-user', opts.user ?? 'usr_people_a')
  return opts.org === null ? call : call.set('x-test-org', opts.org ?? ORG)
}

describe('GET /api/tasks/people', () => {
  it('without a term: the "type a name" marker, and nothing is read', async () => {
    for (const path of ['/api/tasks/people', '/api/tasks/people?q=', '/api/tasks/people?q=%20%20']) {
      const res = await getPeople(path)
      expect(res.status, path).toBe(200)
      expect(res.body, path).toEqual({ items: [], hasMore: false, requiresQuery: true, limit: 20, minQueryLength: 1 })
    }
    expect(people.searchOrgPeople).not.toHaveBeenCalled()
    expect(people.resolveOrgPeople).not.toHaveBeenCalled()
  })

  it('a one-character term searches the caller\'s org with the trimmed term and the page size', async () => {
    people.searchOrgPeople.mockResolvedValueOnce({ items: [{ id: 'usr_1', name: '张三', detail: 'zh***@example.test', canUseTasks: true }], hasMore: true })
    const res = await getPeople(`/api/tasks/people?q=${encodeURIComponent(' 张 ')}`)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      items: [{ id: 'usr_1', name: '张三', detail: 'zh***@example.test', canUseTasks: true }],
      hasMore: true,
      requiresQuery: false,
      limit: 20,
    })
    expect(people.searchOrgPeople).toHaveBeenCalledTimes(1)
    expect(people.searchOrgPeople.mock.calls[0][1]).toEqual({ orgId: ORG, term: '张', limit: 20 })
  })

  it('a term of 65 characters, both keys, or a repeated key is 422 PEOPLE_QUERY_INVALID, and nothing is read', async () => {
    for (const path of [
      `/api/tasks/people?q=${'a'.repeat(65)}`,
      '/api/tasks/people?q=a&ids=b',
      '/api/tasks/people?q=a&q=b',
      '/api/tasks/people?ids=a&ids=b',
    ]) {
      const res = await getPeople(path)
      expect(res.status, path).toBe(422)
      expect(res.text, path).toBe(INVALID_TEXT)
    }
    expect(people.searchOrgPeople).not.toHaveBeenCalled()
    expect(people.resolveOrgPeople).not.toHaveBeenCalled()
  })

  it('ids: only ids the member rule accepts reach the service, at most 50, and the answer says when some were dropped', async () => {
    people.resolveOrgPeople.mockResolvedValue([{ id: 'ok_1', name: '', detail: '', canUseTasks: false }])
    const odd = ['.', '..', '', 'u'.repeat(256), 'ok_1'].map(encodeURIComponent).join(',')
    const first = await getPeople(`/api/tasks/people?ids=${odd}`)
    expect(first.status).toBe(200)
    expect(first.body).toEqual({ items: [{ id: 'ok_1', name: '', detail: '', canUseTasks: false }], truncated: false })
    expect(people.resolveOrgPeople.mock.calls[0][1]).toEqual({ orgId: ORG, ids: ['ok_1'] })

    const many = Array.from({ length: 51 }, (_, i) => `u${i}`)
    const second = await getPeople(`/api/tasks/people?ids=${many.join(',')}`)
    expect(second.status).toBe(200)
    expect(second.body.truncated).toBe(true)
    expect(people.resolveOrgPeople.mock.calls[1][1]).toEqual({ orgId: ORG, ids: many.slice(0, 50) })
  })

  it('an ids value longer than 4096 characters is 422, and nothing is read', async () => {
    const res = await getPeople(`/api/tasks/people?ids=${'a'.repeat(4097)}`)
    expect(res.status).toBe(422)
    expect(res.text).toBe(INVALID_TEXT)
    expect(people.resolveOrgPeople).not.toHaveBeenCalled()
  })

  it('without an org: 422 ORG_MISSING byte for byte, before the query is looked at, and nothing is read', async () => {
    for (const path of ['/api/tasks/people', '/api/tasks/people?q=x', '/api/tasks/people?ids=u', `/api/tasks/people?q=${'a'.repeat(65)}`]) {
      const res = await getPeople(path, { org: null })
      expect(res.status, path).toBe(422)
      expect(res.text, path).toBe(NO_ORG_TEXT)
    }
    expect(people.searchOrgPeople).not.toHaveBeenCalled()
    expect(people.resolveOrgPeople).not.toHaveBeenCalled()
  })

  it('a driver error is 500 INTERNAL and echoes nothing', async () => {
    people.searchOrgPeople.mockRejectedValueOnce(Object.assign(new Error('invalid byte sequence for encoding "UTF8"'), { code: '22021' }))
    const res = await getPeople('/api/tasks/people?q=x')
    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: { code: 'INTERNAL' } })
    for (const secret of ['22021', 'invalid byte sequence', 'UTF8']) expect(res.text).not.toContain(secret)
  })

  it('120 searches a minute per user: the 121st is 429 RATE_LIMITED with Retry-After; another user is not affected', async () => {
    for (let i = 0; i < 120; i += 1) {
      const res = await getPeople('/api/tasks/people?q=x')
      expect(res.status, `call ${i + 1}`).toBe(200)
    }
    const limited = await getPeople('/api/tasks/people?q=x')
    expect(limited.status).toBe(429)
    expect(limited.text).toBe(JSON.stringify({ error: { code: 'RATE_LIMITED' } }))
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0)
    expect(people.searchOrgPeople).toHaveBeenCalledTimes(120)

    const other = await getPeople('/api/tasks/people?q=x', { user: 'usr_people_b' })
    expect(other.status).toBe(200)
  }, 30000)

  it('the counter belongs to one router: a new router starts from zero', async () => {
    for (let i = 0; i < 121; i += 1) await getPeople('/api/tasks/people')
    expect((await getPeople('/api/tasks/people')).status).toBe(429)
    routes.disposeTasksRouter(router)
    router = routes.tasksRouter()
    const app = express()
    app.use(router!)
    pinned.setApp(app)
    expect((await getPeople('/api/tasks/people')).status).toBe(200)
  }, 30000)
})

describe('GET /api/tasks/:id/people', () => {
  it('hands the service the org, the actor and the path id, and answers { people }', async () => {
    people.loadTaskPeople.mockResolvedValueOnce({ usr_1: { name: '张三', status: 'active' }, usr_2: { name: '', status: 'inactive' } })
    const res = await getPeople('/api/tasks/tsk_x/people')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ people: { usr_1: { name: '张三', status: 'active' }, usr_2: { name: '', status: 'inactive' } } })
    expect(people.loadTaskPeople).toHaveBeenCalledWith({ orgId: ORG, actorId: 'usr_people_a', taskId: 'tsk_x' })
  })

  it('without an org: 404 NOT_FOUND byte for byte, and nothing is read', async () => {
    const res = await getPeople('/api/tasks/tsk_x/people', { org: null })
    expect(res.status).toBe(404)
    expect(res.text).toBe(JSON.stringify({ error: { code: 'NOT_FOUND' } }))
    expect(people.loadTaskPeople).not.toHaveBeenCalled()
  })

  it('a 404 from the service is sent as-is; a driver error is 500 INTERNAL', async () => {
    people.loadTaskPeople.mockRejectedValueOnce(Object.assign(new Error('NOT_FOUND'), { status: 404, code: 'NOT_FOUND' }))
    const missing = await getPeople('/api/tasks/tsk_x/people')
    expect(missing.status).toBe(404)
    expect(missing.body).toEqual({ error: { code: 'NOT_FOUND' } })
    people.loadTaskPeople.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: '57014' }))
    const failed = await getPeople('/api/tasks/tsk_x/people')
    expect(failed.status).toBe(500)
    expect(failed.body).toEqual({ error: { code: 'INTERNAL' } })
  })
})

describe('disposeTasksRouter', () => {
  it('a router owns one sweep timer, and disposing the router clears it', () => {
    vi.useFakeTimers()
    try {
      const before = vi.getTimerCount()
      const built = routes.tasksRouter()
      expect(vi.getTimerCount()).toBe(before + 1)
      routes.disposeTasksRouter(built)
      expect(vi.getTimerCount()).toBe(before)
      routes.disposeTasksRouter(built)
      routes.disposeTasksRouter(null)
      expect(vi.getTimerCount()).toBe(before)
    } finally {
      vi.useRealTimers()
    }
  })
})
