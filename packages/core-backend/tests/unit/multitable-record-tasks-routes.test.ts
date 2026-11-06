/**
 * The record's list of tasks (routes/multitable-record-tasks.ts) in the no-DB unit lane: the mount
 * predicate, the gate order, the refusals, the `dispatchKey` query and the SQL the list sends. The
 * real router and the real `listRecordTasks` run; the session, the task door, the record read gate and
 * the database are faked. What the SQL selects on a real database is proven in
 * tests/integration/task-p2-source-links.db.test.ts.
 *
 * No supertest: the route's layers are invoked directly, the way the record approvals route test does.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NextFunction, Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  requireRecordReadable: vi.fn(),
  rbacGuard: vi.fn(),
  door: { allow: true },
  identity: { id: 'usr_view', sub: 'usr_view', org: 'org_view' as string | undefined },
}))

vi.mock('../../src/db/pg', () => ({ pool: null, query: mocks.query, transaction: vi.fn() }))

vi.mock('../../src/routes/univer-meta', () => ({
  requireRecordReadable: mocks.requireRecordReadable,
}))

vi.mock('../../src/middleware/auth', () => {
  const authenticate = (req: Request, _res: Response, next: NextFunction) => {
    ;(req as unknown as { user: unknown }).user = { id: mocks.identity.id, sub: mocks.identity.sub }
    if (mocks.identity.org !== undefined) {
      ;(req as unknown as { authenticatedTenantId: string }).authenticatedTenantId = mocks.identity.org
    }
    next()
  }
  return { authenticate, default: authenticate }
})

vi.mock('../../src/rbac/rbac', () => ({
  rbacGuard: (...args: unknown[]) => {
    mocks.rbacGuard(...args)
    return (_req: Request, res: Response, next: NextFunction) => {
      if (mocks.door.allow) return next()
      res.status(403).json({ error: 'Forbidden' })
    }
  },
}))

import { createMultitableRecordTaskRoutes } from '../../src/routes/multitable-record-tasks'
import { buildTaskScopeCondition } from '../../src/tasks/task-access'
import { clampRecordTaskListLimit, RECORD_TASK_LIST_DEFAULT_LIMIT, RECORD_TASK_LIST_MAX_LIMIT } from '../../src/tasks/task-source-links'

const PATH = '/sheets/:sheetId/records/:recordId/tasks'
const SHEET = 'sht_rt_1'
const RECORD = 'rec_rt_1'
const KEY = '9d4c1b7e-2f3a-4c5d-8e6f-0a1b2c3d4e5f'

const READABLE = {
  access: { userId: 'usr_view', isAdminRole: false },
  capabilities: { canRead: true },
  capabilityOrigin: 'permission',
}

const previousFlag = process.env.TASKS_ENABLED

beforeEach(() => {
  process.env.TASKS_ENABLED = 'true'
  mocks.query.mockReset()
  mocks.requireRecordReadable.mockReset()
  mocks.rbacGuard.mockReset()
  mocks.door.allow = true
  mocks.identity.id = 'usr_view'
  mocks.identity.sub = 'usr_view'
  mocks.identity.org = 'org_view'
  mocks.requireRecordReadable.mockResolvedValue(READABLE)
  mocks.query.mockResolvedValue({ rows: [] })
})

afterEach(() => {
  if (previousFlag === undefined) delete process.env.TASKS_ENABLED
  else process.env.TASKS_ENABLED = previousFlag
})

function createMockResponse() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(payload: unknown) {
      this.body = payload
      return this
    },
  } as unknown as Response & { statusCode: number; body: unknown }
}

type RouteLayer = { route?: { path?: string; methods?: Record<string, boolean>; stack: Array<{ handle: (...args: unknown[]) => unknown }> } }

async function invoke(options: { params?: Record<string, string>; query?: Record<string, unknown> } = {}) {
  const router = createMultitableRecordTaskRoutes()
  if (!router) throw new Error('the record tasks router did not mount')
  const layer = (router.stack as RouteLayer[]).find((entry) => entry.route?.path === PATH && entry.route?.methods?.get)
  if (!layer?.route) throw new Error(`route GET ${PATH} not found`)
  const req = {
    method: 'GET',
    headers: {},
    params: options.params ?? { sheetId: SHEET, recordId: RECORD },
    query: options.query ?? {},
  } as unknown as Request
  const res = createMockResponse()
  for (const routeLayer of layer.route.stack) {
    let advanced = false
    await (routeLayer.handle as (req: Request, res: Response, next: () => void) => unknown)(req, res, () => { advanced = true })
    if (!advanced) break
  }
  return { req, res }
}

function taskRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'tsk_1',
    title: '备料复核',
    status: 'open',
    completion_mode: 'any',
    due_at: new Date('2031-05-06T09:00:00.000Z'),
    due_date: '2031-05-06',
    created_by: 'usr_view',
    created_at: new Date('2031-05-01T08:00:00.000Z'),
    ...over,
  }
}

function lastParam(): unknown {
  const params = sentSql()[0]!.params
  return params[params.length - 1]
}

function sentSql(): Array<{ sql: string; params: unknown[] }> {
  return mocks.query.mock.calls.map(([sql, params]) => ({ sql: String(sql), params: (params ?? []) as unknown[] }))
}

describe('mount', () => {
  it.each([
    ['unset', undefined, false],
    ['empty', '', false],
    ['TRUE', 'TRUE', false],
    ['1', '1', false],
    ['padded', ' true', false],
    ['exact true', 'true', true],
  ] as const)('TASKS_ENABLED %s: the factory mounts = %s', (_label, value, mounted) => {
    if (value === undefined) delete process.env.TASKS_ENABLED
    else process.env.TASKS_ENABLED = value
    expect(createMultitableRecordTaskRoutes() !== null).toBe(mounted)
  })

  it('one GET route, behind the task read door', () => {
    const router = createMultitableRecordTaskRoutes()!
    const routes = (router.stack as RouteLayer[]).filter((entry) => entry.route)
    expect(routes.map((entry) => [entry.route?.path, Object.keys(entry.route?.methods ?? {})])).toEqual([[PATH, ['get']]])
    expect(mocks.rbacGuard.mock.calls).toEqual([['tasks', 'read']])
  })

  it('index.ts mounts it under /api/multitable only when the task routes mount', () => {
    const index = readFileSync(join(__dirname, '../../src/index.ts'), 'utf8')
    expect(index).toContain('const recordTaskRoutes = createMultitableRecordTaskRoutes()')
    expect(index).toContain("if (taskRoutes && recordTaskRoutes) this.app.use('/api/multitable', recordTaskRoutes)")
    expect(index.indexOf('const recordTaskRoutes')).toBeGreaterThan(index.indexOf('const taskRoutes = tasksRouter()'))
  })
})

describe('gates, in order', () => {
  it('the task door refuses before the record gate and before any SQL', async () => {
    mocks.door.allow = false
    const { res } = await invoke()
    expect(res.statusCode).toBe(403)
    expect(mocks.requireRecordReadable).not.toHaveBeenCalled()
    expect(mocks.query).not.toHaveBeenCalled()
  })

  it('the record gate gets the request, a query function and the trimmed path ids', async () => {
    const { req } = await invoke({ params: { sheetId: ` ${SHEET} `, recordId: ` ${RECORD}` } })
    expect(mocks.requireRecordReadable).toHaveBeenCalledTimes(1)
    const [gotReq, gotQuery, sheetId, recordId] = mocks.requireRecordReadable.mock.calls[0]!
    expect(gotReq).toBe(req)
    expect(typeof gotQuery).toBe('function')
    expect([sheetId, recordId]).toEqual([SHEET, RECORD])
  })

  it.each([
    [403, { ok: false, error: { code: 'PERMISSION_DENIED', message: 'Insufficient permissions' } }],
    [404, { ok: false, error: { code: 'RECORD_NOT_FOUND', message: 'Record not found' } }],
  ])('a record gate %s is answered with one code and no task SQL', async (status, body) => {
    mocks.requireRecordReadable.mockResolvedValueOnce({ status, body: { ok: false, error: { code: 'GATE_OWN', message: 'gate text' } } })
    const { res } = await invoke()
    expect(res.statusCode).toBe(status)
    expect(res.body).toEqual(body)
    expect(mocks.query).not.toHaveBeenCalled()
  })

  it('a record gate 401 passes through byte-for-byte', async () => {
    const gateBody = { ok: false, error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } }
    mocks.requireRecordReadable.mockResolvedValueOnce({ status: 401, body: gateBody })
    const { res } = await invoke()
    expect(res.statusCode).toBe(401)
    expect(res.body).toBe(gateBody)
    expect(mocks.query).not.toHaveBeenCalled()
  })

  it('a gated reader who is not the task actor is refused, no task SQL', async () => {
    mocks.identity.sub = 'usr_other'
    const { res } = await invoke()
    expect(res.statusCode).toBe(403)
    expect(res.body).toEqual({ ok: false, error: { code: 'PERMISSION_DENIED', message: 'Insufficient permissions' } })
    expect(mocks.query).not.toHaveBeenCalled()
  })

  it.each([
    ['short', 'short'],
    ['too long', 'k'.repeat(65)],
    ['a space', 'key with space 01'],
    ['repeated', [KEY, KEY]],
    ['nested', { a: KEY }],
    ['empty', ''],
  ])('a %s dispatchKey is 422 INVALID_DISPATCH_KEY after the record gate, no task SQL', async (_label, dispatchKey) => {
    const { res } = await invoke({ query: { dispatchKey } })
    expect(res.statusCode).toBe(422)
    expect(res.body).toEqual({ ok: false, error: { code: 'INVALID_DISPATCH_KEY', message: 'Invalid dispatch key' } })
    expect(mocks.requireRecordReadable).toHaveBeenCalledTimes(1)
    expect(mocks.query).not.toHaveBeenCalled()
  })

  it('a refused record gate is answered before a malformed key is looked at', async () => {
    mocks.requireRecordReadable.mockResolvedValueOnce({ status: 403, body: {} })
    const { res } = await invoke({ query: { dispatchKey: 'short' } })
    expect(res.statusCode).toBe(403)
  })

  it('no org on the session: an empty degraded answer and no task SQL', async () => {
    mocks.identity.org = undefined
    const { res } = await invoke()
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ ok: true, data: { items: [], hasMore: false, degraded: true, reason: 'org_missing' } })
    expect(mocks.query).not.toHaveBeenCalled()
  })

  it('a failing read is 500 INTERNAL_ERROR without the driver text', async () => {
    mocks.query.mockRejectedValueOnce(Object.assign(new Error('relation "task_source_links" does not exist'), { code: '42P01' }))
    const { res } = await invoke()
    expect(res.statusCode).toBe(500)
    expect(res.body).toEqual({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to list record tasks' } })
    expect(JSON.stringify(res.body)).not.toContain('task_source_links')
  })
})

describe('the list', () => {
  it('one SELECT: the link join on this sheet and record, the any_role scope of the viewer and the org, newest first, a limit + 1 probe', async () => {
    await invoke()
    const calls = sentSql()
    expect(calls).toHaveLength(1)
    const [{ sql, params }] = calls
    const scope = buildTaskScopeCondition({ view: 'any_role', actorParam: 'usr_view', orgParam: 'org_view' })
    expect(sql).toContain('JOIN task_source_links l ON l.task_id = tasks.id AND l.org_id = tasks.org_id')
    expect(sql).toContain('WHERE l.sheet_id = $3 AND l.record_id = $4 AND l.source_type = $5')
    expect(sql).toContain(scope.sql)
    expect(sql.split('tasks.org_id = $2').length - 1).toBe(1)
    expect(sql).toContain('ORDER BY tasks.created_at DESC, tasks.id DESC')
    expect(sql).toContain('LIMIT $6')
    // The list never reads or filters on a retry key and never counts.
    expect(sql).not.toContain('dispatch_key')
    expect(sql).not.toContain('l.created_by')
    expect(sql.toLowerCase()).not.toContain('count(')
    expect(params).toEqual(['usr_view', 'org_view', SHEET, RECORD, 'multitable_record', RECORD_TASK_LIST_DEFAULT_LIMIT + 1])
  })

  it('rows carry ids, the title, the status and the dates; isMine is the viewer as creator; no key and no count', async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [taskRow(), taskRow({ id: 'tsk_2', created_by: 'usr_other', due_at: null, due_date: null, status: 'done', completion_mode: 'all' })],
    })
    const { res } = await invoke()
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({
      ok: true,
      data: {
        items: [
          {
            id: 'tsk_1', title: '备料复核', status: 'open', completionMode: 'any',
            dueAt: '2031-05-06T09:00:00.000Z', dueDate: '2031-05-06',
            createdBy: 'usr_view', createdAt: '2031-05-01T08:00:00.000Z', isMine: true,
          },
          {
            id: 'tsk_2', title: '备料复核', status: 'done', completionMode: 'all',
            dueAt: null, dueDate: null,
            createdBy: 'usr_other', createdAt: '2031-05-01T08:00:00.000Z', isMine: false,
          },
        ],
        hasMore: false,
      },
    })
    const data = (res.body as { data: Record<string, unknown> }).data
    expect(Object.keys(data).sort()).toEqual(['hasMore', 'items'])
    for (const item of data.items as Record<string, unknown>[]) {
      expect(Object.prototype.hasOwnProperty.call(item, 'dispatchKey')).toBe(false)
    }
  })

  it('hasMore comes from the probe row, which is not returned', async () => {
    const rows = [1, 2, 3].map((n) => taskRow({ id: `tsk_${n}` }))
    mocks.query.mockResolvedValueOnce({ rows })
    const { res } = await invoke({ query: { limit: '2' } })
    const data = (res.body as { data: { items: Array<{ id: string }>; hasMore: boolean } }).data
    expect(data.items.map((item) => item.id)).toEqual(['tsk_1', 'tsk_2'])
    expect(data.hasMore).toBe(true)
    expect(lastParam()).toBe(3)
  })

  it.each([
    ['absent', undefined, RECORD_TASK_LIST_DEFAULT_LIMIT],
    ['garbage', 'abc', RECORD_TASK_LIST_DEFAULT_LIMIT],
    ['zero', '0', RECORD_TASK_LIST_DEFAULT_LIMIT],
    ['negative', '-3', RECORD_TASK_LIST_DEFAULT_LIMIT],
    ['fraction', '2.5', RECORD_TASK_LIST_DEFAULT_LIMIT],
    ['one', '1', 1],
    ['above the bound', '500', RECORD_TASK_LIST_MAX_LIMIT],
  ])('limit %s', async (_label, limit, page) => {
    await invoke({ query: limit === undefined ? {} : { limit } })
    expect(lastParam()).toBe(page + 1)
  })
})

describe('the dispatchKey query', () => {
  it('adds the link creator = the viewer and the key; the same scope and org; at most one row; hasMore false', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [taskRow()] })
    const { res } = await invoke({ query: { dispatchKey: KEY } })
    const [{ sql, params }] = sentSql()
    const scope = buildTaskScopeCondition({ view: 'any_role', actorParam: 'usr_view', orgParam: 'org_view' })
    expect(sql).toContain('WHERE l.sheet_id = $3 AND l.record_id = $4 AND l.source_type = $5 AND l.created_by = $1 AND l.dispatch_key = $6')
    expect(sql).toContain(scope.sql)
    expect(sql).toContain('LIMIT $7')
    expect(params).toEqual(['usr_view', 'org_view', SHEET, RECORD, 'multitable_record', KEY, 1])
    expect(res.body).toEqual({
      ok: true,
      data: {
        items: [{
          id: 'tsk_1', title: '备料复核', status: 'open', completionMode: 'any',
          dueAt: '2031-05-06T09:00:00.000Z', dueDate: '2031-05-06',
          createdBy: 'usr_view', createdAt: '2031-05-01T08:00:00.000Z', isMine: true,
        }],
        hasMore: false,
      },
    })
  })

  it('no row is an empty answer, the same shape', async () => {
    const { res } = await invoke({ query: { dispatchKey: KEY, limit: '5' } })
    expect(res.body).toEqual({ ok: true, data: { items: [], hasMore: false } })
    expect(lastParam()).toBe(1)
  })
})

describe('the page size', () => {
  it('clampRecordTaskListLimit keeps 1..100 and defaults the rest', () => {
    expect([undefined, null, '', 'x', 0, -1, 1.5, '1.5', NaN, {}].map(clampRecordTaskListLimit))
      .toEqual(Array(10).fill(RECORD_TASK_LIST_DEFAULT_LIMIT))
    expect([1, '1', 37, '100', 101, '9999'].map(clampRecordTaskListLimit)).toEqual([1, 1, 37, 100, 100, 100])
  })
})

describe('no record write', () => {
  it('the route file and the task services never write meta_records', () => {
    const root = join(__dirname, '../../src')
    const services = readdirSync(join(root, 'services')).filter((name) => name.startsWith('task-') && name.endsWith('.ts'))
    expect(services).toContain('task-records.ts')
    for (const rel of ['routes/multitable-record-tasks.ts', ...services.map((name) => `services/${name}`)]) {
      const text = readFileSync(join(root, rel), 'utf8')
      expect(text, rel).not.toMatch(/INSERT\s+INTO\s+meta_records|UPDATE\s+meta_records|DELETE\s+FROM\s+meta_records/i)
    }
  })
})
