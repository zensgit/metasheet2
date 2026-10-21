/**
 * `lockTaskRowForDelete` in `services/task-structure.ts` (M3R4-TAM-3): only
 * the two "gave up waiting" SQLSTATEs of the bounded `FOR UPDATE` statement
 * (57014 `query_canceled`, 55P03 `lock_not_available`) are answered as the
 * retryable 409 `TASK_BUSY`. Any other failure of that statement propagates
 * unchanged, and reaches the client as 500 `INTERNAL` with nothing echoed.
 * The database is a stub: the pre-lock check finds the caller's own task,
 * and the row-lock statement rejects with a chosen SQLSTATE.
 */
import express from 'express'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'

const state = vi.hoisted(() => ({
  lockCode: '08006',
  lockMessage: 'connection terminated',
  calls: [] as string[],
  actorId: 'usr_lock_errors',
}))

vi.mock('../../src/db/pg', () => ({
  query: vi.fn(async (sql: string) => {
    state.calls.push(sql)
    if (sql.includes('SELECT created_by FROM tasks')) return { rows: [{ created_by: state.actorId }] }
    return { rows: [] }
  }),
  transaction: vi.fn(async (handler: (client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }) => Promise<unknown>) =>
    handler({
      query: async (sql: string) => {
        state.calls.push(sql)
        if (sql.includes("current_setting('statement_timeout')")) return { rows: [{ value: '30s' }] }
        if (sql.includes('FOR UPDATE')) {
          throw Object.assign(new Error(state.lockMessage), { code: state.lockCode, severity: 'ERROR' })
        }
        return { rows: [] }
      },
    })),
}))

vi.mock('../../src/middleware/auth', () => {
  const authenticate = (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    ;(req as unknown as { user: unknown }).user = { id: state.actorId, sub: state.actorId }
    ;(req as unknown as { authenticatedTenantId: string }).authenticatedTenantId = 'org_lock_errors'
    next()
  }
  return { authenticate, default: authenticate }
})

vi.mock('../../src/rbac/rbac', () => ({
  rbacGuard: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}))

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
  state.calls.length = 0
  state.lockCode = '08006'
  state.lockMessage = 'connection terminated'
})

describe('deleteTaskById row-lock statement errors', () => {
  it('a non-busy SQLSTATE from the FOR UPDATE statement propagates unchanged (no status, original code)', async () => {
    const { deleteTaskById } = await import('../../src/services/task-structure')
    const err = await deleteTaskById({ orgId: 'org_lock_errors', actorId: state.actorId, taskId: 'tsk_lock_errors' }).then(
      () => { throw new Error('resolved') },
      (e: unknown) => e as Record<string, unknown>,
    )
    expect(err).toBeInstanceOf(Error)
    expect(err.code).toBe('08006')
    expect(err).not.toHaveProperty('status')
    expect(state.calls.some((sql) => sql.includes('FOR UPDATE'))).toBe(true)
    // The failed transaction does not go on: nothing after the lock ran.
    expect(state.calls.some((sql) => sql.includes('UPDATE tasks'))).toBe(false)
  })

  it.each([['40001', 'could not serialize access'], ['57P01', 'terminating connection due to administrator command']])(
    'SQLSTATE %s from the FOR UPDATE statement is not 409 TASK_BUSY',
    async (code, message) => {
      state.lockCode = code
      state.lockMessage = message
      const { deleteTaskById } = await import('../../src/services/task-structure')
      const err = await deleteTaskById({ orgId: 'org_lock_errors', actorId: state.actorId, taskId: 'tsk_lock_errors' }).then(
        () => { throw new Error('resolved') },
        (e: unknown) => e as Record<string, unknown>,
      )
      expect(err.code).toBe(code)
      expect(err).not.toHaveProperty('status')
    },
  )

  it.each(['57014', '55P03'])('busy SQLSTATE %s is 409 TASK_BUSY (control)', async (code) => {
    state.lockCode = code
    const { deleteTaskById } = await import('../../src/services/task-structure')
    await expect(deleteTaskById({ orgId: 'org_lock_errors', actorId: state.actorId, taskId: 'tsk_lock_errors' }))
      .rejects.toMatchObject({ status: 409, code: 'TASK_BUSY' })
  })

  it('at HTTP a non-busy SQLSTATE is 500 INTERNAL with nothing echoed; a busy one is 409 TASK_BUSY', async () => {
    const res = await request(pinned.url()).delete('/api/tasks/tsk_lock_errors')
    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: { code: 'INTERNAL' } })
    for (const secret of ['08006', 'connection terminated', 'TASK_BUSY']) expect(res.text).not.toContain(secret)
    state.lockCode = '57014'
    const busy = await request(pinned.url()).delete('/api/tasks/tsk_lock_errors')
    expect(busy.status).toBe(409)
    expect(busy.body).toEqual({ error: { code: 'TASK_BUSY' } })
  })
})
