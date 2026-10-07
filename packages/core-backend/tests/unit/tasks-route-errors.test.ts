/**
 * `sendError` in `routes/tasks.ts` (M3R2-AUTHZ-4, R3-TAM-5): an error thrown
 * by a task service is sent as `{ error: { code } }` only when it carries a
 * 4xx numeric `status` and a string `code`; anything else is 500
 * `{ error: { code: 'INTERNAL' } }` with no SQLSTATE and no message. The
 * trigger here is a stubbed service, independent of any input handling.
 */
import express from 'express'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'

const createTask = vi.fn()

vi.mock('../../src/middleware/auth', () => {
  const authenticate = (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    ;(req as unknown as { user: unknown }).user = { id: 'usr_route_errors', sub: 'usr_route_errors' }
    ;(req as unknown as { authenticatedTenantId: string }).authenticatedTenantId = 'org_route_errors'
    next()
  }
  return { authenticate, default: authenticate }
})

vi.mock('../../src/rbac/rbac', () => ({
  rbacGuard: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}))

vi.mock('../../src/services/task-records', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/task-records')>()
  return { ...actual, createTask: (...args: unknown[]) => createTask(...args) }
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

beforeEach(() => {
  createTask.mockReset()
})

function pgShaped(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, severity: 'ERROR', detail: `detail ${message}` })
}

describe('tasks route sendError', () => {
  const internalCases: Array<{ label: string; error: unknown; secrets: string[] }> = [
    { label: 'pg-shaped error with a SQLSTATE', error: pgShaped('22021', 'invalid byte sequence for encoding "UTF8": 0x00'), secrets: ['22021', 'invalid byte sequence', 'UTF8'] },
    { label: 'non-4xx numeric status (503)', error: Object.assign(new Error('upstream down'), { status: 503, code: 'UPSTREAM_DOWN' }), secrets: ['UPSTREAM_DOWN', 'upstream down', '503'] },
    // M3R4-TAM-4: status exactly 500 with a string code is still INTERNAL.
    { label: 'status exactly 500 with a string code', error: Object.assign(new Error('boom'), { status: 500, code: 'X' }), secrets: ['X', 'boom'] },
    { label: '4xx status with a non-string code', error: Object.assign(new Error('odd'), { status: 422, code: 42 }), secrets: ['42', 'odd'] },
    { label: 'plain TypeError', error: new TypeError('cannot read x of undefined'), secrets: ['TypeError', 'cannot read'] },
  ]

  it.each(internalCases)('$label is 500 { code: INTERNAL } and echoes nothing', async ({ error, secrets }) => {
    createTask.mockRejectedValueOnce(error)
    const res = await request(pinned.url()).post('/api/tasks').send({ title: 't' })
    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: { code: 'INTERNAL' } })
    for (const secret of secrets) expect(res.text).not.toContain(secret)
  })

  it('a 4xx service error with a string code is sent as-is (control)', async () => {
    createTask.mockRejectedValueOnce(Object.assign(new Error('INVALID_TITLE'), { status: 422, code: 'INVALID_TITLE' }))
    const res = await request(pinned.url()).post('/api/tasks').send({ title: 't' })
    expect(res.status).toBe(422)
    expect(res.body).toEqual({ error: { code: 'INVALID_TITLE' } })
  })
})
