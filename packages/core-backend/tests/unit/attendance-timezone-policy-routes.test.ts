import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
type Request = { params: { userId?: string }, allowed?: boolean }
type Response = { status: (status: number) => Response, json: (body: unknown) => void }
type Handler = (req: Request, res: Response) => Promise<void>
const { registerAttendanceTimezonePolicyRoutes: register } = require(
  '../../../../plugins/plugin-attendance/lib/attendance-timezone-policy-routes.cjs',
)
const defaultRow = { id: 'rule-a', timezone: 'Asia/Tokyo', timezone_version: 3 }

function fixture(responses: unknown[][], actor: { orgId: string, userId: string } | null = { orgId: 'org-a', userId: 'admin-a' }) {
  const routes = new Map<string, Handler>()
  const query = vi.fn()
  for (const rows of responses) query.mockResolvedValueOnce(rows)
  const transaction = vi.fn(async (work: (trx: { query: typeof query }) => Promise<unknown>) => work({ query }))
  const permissions: string[] = []
  register({
    addRoute: (method: string, path: string, handler: Handler) => routes.set(method + ' ' + path, handler),
    withPermission: (permission: string, handler: Handler) => {
      permissions.push(permission)
      return async (req: Request, res: Response) => {
        if (!req.allowed) { res.status(403).json({ ok: false, error: { code: 'FORBIDDEN' } }); return }
        await handler(req, res)
      }
    },
    resolveActor: () => actor,
    db: { transaction },
  })
  async function run(employee = false, allowed = true) {
    const result = { status: 200, body: undefined as unknown }
    const res: Response = {
      status: status => { result.status = status; return res },
      json: body => { result.body = body },
    }
    const path = employee ? '/api/attendance/timezone-policy/employees/:userId' : '/api/attendance/timezone-policy'
    await routes.get('GET ' + path)!({ params: { userId: 'employee-a' }, allowed }, res)
    return result
  }
  return { routes, query, transaction, permissions, run }
}

afterEach(() => vi.useRealTimers())

describe('attendance timezone administration read routes', () => {
  it('registers only the two admin GET routes', () => {
    const f = fixture([])
    expect([...f.routes.keys()]).toEqual([
      'GET /api/attendance/timezone-policy',
      'GET /api/attendance/timezone-policy/employees/:userId',
    ])
    expect(f.permissions).toEqual(['attendance:admin', 'attendance:admin'])
  })
  it('denies insufficient permission before any transaction or SQL', async () => {
    const f = fixture([])
    expect(await f.run(false, false)).toEqual({ status: 403, body: { ok: false, error: { code: 'FORBIDDEN' } } })
    expect(f.transaction).not.toHaveBeenCalled()
    expect(f.query).not.toHaveBeenCalled()
  })
  it('returns before SQL when the authenticated actor resolver refuses the request', async () => {
    const f = fixture([], null)
    await f.run()
    expect(f.transaction).not.toHaveBeenCalled()
  })
  it('returns absent policy as OFF with the actual organization default revision', async () => {
    const f = fixture([[{ id: 'admin-a' }], [], [defaultRow]])
    expect(await f.run()).toEqual({
      status: 200, body: { ok: true, data: {
        enabled: false, version: 0,
        systemDefault: { orgId: 'org-a', referenceId: 'rule-a', timezone: 'Asia/Tokyo', version: 3 },
      } },
    })
    expect(f.transaction).toHaveBeenCalledTimes(1)
    expect(f.query.mock.calls.map(call => call[1])).toEqual([
      ['admin-a', 'org-a'], ['org-a'], ['org-a'],
    ])
    expect(f.query.mock.calls.every(call => /^SELECT /.test(call[0]))).toBe(true)
  })
  it('returns a persisted strict boolean and actual policy version', async () => {
    const f = fixture([[{ id: 'admin-a' }], [{ enabled: true, version: 7 }], [defaultRow]])
    expect((await f.run()).body).toEqual({ ok: true, data: {
      enabled: true, version: 7,
      systemDefault: { orgId: 'org-a', referenceId: 'rule-a', timezone: 'Asia/Tokyo', version: 3 },
    } })
  })
  it('refuses an inactive or cross-organization actor without reading configuration', async () => {
    const f = fixture([[]])
    expect(await f.run()).toEqual({ status: 403, body: { ok: false, error: { code: 'ATTENDANCE_TIMEZONE_MEMBER_REQUIRED' } } })
    expect(f.query).toHaveBeenCalledTimes(1)
    expect(f.query.mock.calls[0][0]).toContain('uo.org_id = $2')
    expect(f.query.mock.calls[0][0]).toContain('uo.is_active = true')
  })
  it('refuses missing organization default instead of using a global fallback', async () => {
    const f = fixture([[{ id: 'admin-a' }], [], []])
    expect(await f.run()).toEqual({ status: 422, body: { ok: false, error: { code: 'ATTENDANCE_TIMEZONE_DEFAULT_REQUIRED' } } })
  })
  it('refuses duplicate defaults without choosing by row order', async () => {
    const f = fixture([[{ id: 'admin-a' }], [], [defaultRow, { ...defaultRow, id: 'rule-b' }]])
    expect(await f.run()).toEqual({ status: 409, body: { ok: false, error: { code: 'ATTENDANCE_TIMEZONE_MULTIPLE_DEFAULTS' } } })
  })
  it('never echoes a database error or turns it into OFF', async () => {
    const f = fixture([])
    f.query.mockRejectedValueOnce(new Error('synthetic-sensitive-value'))
    expect(await f.run()).toEqual({ status: 503, body: { ok: false, error: { code: 'ATTENDANCE_TIMEZONE_STORE_UNAVAILABLE' } } })
  })
  it('refuses a target outside the organization before reading its overrides', async () => {
    const f = fixture([[{ id: 'admin-a' }], []])
    expect(await f.run(true)).toEqual({ status: 403, body: { ok: false, error: { code: 'ATTENDANCE_TIMEZONE_MEMBER_REQUIRED' } } })
    expect(f.query).toHaveBeenCalledTimes(2)
    expect(f.query.mock.calls[1][1]).toEqual(['employee-a', 'org-a'])
  })
  it('returns no effective override as null using one server instant', async () => {
    vi.useFakeTimers()
    const now = new Date('2026-10-12T01:00:00.000Z')
    vi.setSystemTime(now)
    const f = fixture([[{ id: 'admin-a' }], [{ id: 'employee-a' }], []])
    expect(await f.run(true)).toEqual({ status: 200, body: { ok: true, data: { override: null } } })
    expect(f.query.mock.calls[2][1]).toEqual(['org-a', 'employee-a', now])
  })
})
